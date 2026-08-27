import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import paperclipPiExtension, { parseDsmlToolCalls } from "./pi-paperclip-extension.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("paperclip Pi extension", () => {
  it("strictly converts complete DSML envelopes into typed tool calls", () => {
    expect(parseDsmlToolCalls(`
      <｜DSML｜tool_calls>
      <｜DSML｜invoke name="write_document">
      <｜DSML｜parameter name="key" string="true">plan</｜DSML｜parameter>
      <｜DSML｜parameter name="baseRevisionId" string="false">null</｜DSML｜parameter>
      <｜DSML｜parameter name="metadata" string="false">{"revision":2}</｜DSML｜parameter>
      </｜DSML｜invoke>
      </｜DSML｜tool_calls>
    `)).toEqual([{
      name: "write_document",
      arguments: { key: "plan", baseRevisionId: null, metadata: { revision: 2 } },
    }]);
    expect(parseDsmlToolCalls("before <｜DSML｜tool_calls></｜DSML｜tool_calls>" )).toBeNull();
    expect(parseDsmlToolCalls(`
      <｜DSML｜tool_calls>
      <｜DSML｜invoke name="write_document">
      <｜DSML｜parameter name="baseRevisionId" string="false">not-json</｜DSML｜parameter>
      </｜DSML｜invoke>
      </｜DSML｜tool_calls>
    `)).toBeNull();
  });

  it("registers only the public catalog and gates built-ins without exposing command content", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-extension-"));
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await mkdir(workspace);
    await mkdir(runtime);
    vi.stubEnv("PAPERCLIP_RUNNER_BRIDGE_URL", "http://127.0.0.1:43123/mcp");
    vi.stubEnv("PAPERCLIP_RUNNER_BRIDGE_TOKEN", "a".repeat(64));
    vi.stubEnv("PAPERCLIP_WORKSPACE_ROOT", workspace);
    vi.stubEnv("PAPERCLIP_RUNTIME_ROOT", runtime);

    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [{ name: "paperclip_finish", inputSchema: { type: "object" } }],
          },
        }), { status: 200 });
      }
      if (request.method === "tools/call") {
        if ((request.params as Record<string, unknown>)?.name === "__paperclip_runtime_input") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [{ type: "text", text: JSON.stringify({ action: "accept", content: { environment: "staging" } }) }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: JSON.stringify({ decision: "accept_for_session" }) }] },
        }), { status: 200 });
      }
      return request.id === undefined
        ? new Response(null, { status: 202 })
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), { status: 200 });
    }));

    const tools: Array<Record<string, unknown>> = [];
    let toolCallHandler: ((event: Record<string, unknown>) => Promise<unknown>) | null = null;
    let messageEndHandler: ((event: Record<string, unknown>) => unknown) | null = null;
    await paperclipPiExtension({
      registerTool(tool) { tools.push(tool as unknown as Record<string, unknown>); },
      on(event, handler) {
        if (event === "tool_call") toolCallHandler = handler as unknown as typeof toolCallHandler;
        if (event === "message_end") messageEndHandler = handler as unknown as typeof messageEndHandler;
      },
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["request_user_input", "paperclip_finish"]);
    expect(JSON.stringify(tools)).not.toContain("__paperclip_runtime_permission");
    const inputResult = await (tools[0]!.execute as (
      callId: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>)("input-1", {
      title: "Deployment",
      questions: [{
        id: "environment",
        prompt: "Where should we deploy?",
        answerMode: "single_select",
        options: [{ id: "staging", label: "Staging" }],
      }],
    }, new AbortController().signal);
    expect(inputResult).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("staging") }],
    });
    expect(requests).toContainEqual(expect.objectContaining({
      method: "tools/call",
      params: expect.objectContaining({ name: "__paperclip_runtime_input" }),
    }));
    expect(await toolCallHandler!({ toolName: "read", toolCallId: "read-1", input: { path: "/etc/passwd" } })).toMatchObject({ block: true });
    expect(await toolCallHandler!({ toolName: "bash", toolCallId: "bash-1", input: { command: "printf hello" } })).toBeUndefined();
    expect(await toolCallHandler!({ toolName: "bash", toolCallId: "bash-relative", input: { command: "mkdir -p nested/dir && printf hello > nested/dir/file.txt" } })).toBeUndefined();
    expect(await toolCallHandler!({ toolName: "write", toolCallId: "write-nested", input: { path: "new/nested/file.txt" } })).toBeUndefined();

    const permissionCall = requests.find((request) =>
      request.method === "tools/call"
      && (request.params as Record<string, unknown>)?.name === "__paperclip_runtime_permission"
    );
    const permissionArguments = ((permissionCall?.params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;
    expect(permissionArguments.target).toMatch(/^command-sha256:[a-f0-9]{64}$/);
    expect(requests.filter((request) =>
      request.method === "tools/call"
      && (request.params as Record<string, unknown>)?.name === "__paperclip_runtime_permission"
    )).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("printf hello");
    expect(await toolCallHandler!({ toolName: "bash", toolCallId: "bash-2", input: { command: "cat /etc/passwd" } })).toMatchObject({ block: true });
    expect(await toolCallHandler!({ toolName: "bash", toolCallId: "bash-parent", input: { command: "cat safe/../../etc/passwd" } })).toMatchObject({ block: true });

    const baseMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "deepseek-v4-flash-0731",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    };
    const recovered = await messageEndHandler!({
      message: {
        ...baseMessage,
        content: [{ type: "text", text: `<｜DSML｜tool_calls>
          <｜DSML｜invoke name="paperclip_finish">
          <｜DSML｜parameter name="reportedWorkDisposition" string="true">done</｜DSML｜parameter>
          </｜DSML｜invoke>
        </｜DSML｜tool_calls>` }],
      },
    }) as { message: { content: Array<Record<string, unknown>>; stopReason: string } };
    expect(recovered.message).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", name: "paperclip_finish", arguments: { reportedWorkDisposition: "done" } }],
    });
    expect(await messageEndHandler!({
      message: {
        ...baseMessage,
        content: [{ type: "text", text: `<｜DSML｜tool_calls><｜DSML｜invoke name="unknown_tool"></｜DSML｜invoke></｜DSML｜tool_calls>` }],
      },
    })).toBeUndefined();
  });
});
