import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import paperclipPiExtension from "./pi-paperclip-extension.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("paperclip Pi extension", () => {
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
    await paperclipPiExtension({
      registerTool(tool) { tools.push(tool as unknown as Record<string, unknown>); },
      on(event, handler) {
        if (event === "tool_call") toolCallHandler = handler as unknown as typeof toolCallHandler;
      },
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["paperclip_finish"]);
    expect(JSON.stringify(tools)).not.toContain("__paperclip_runtime_permission");
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
  });
});
