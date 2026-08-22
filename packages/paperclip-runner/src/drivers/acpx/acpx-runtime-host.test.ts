import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
} from "acpx/runtime";
import { describe, expect, it } from "vitest";

import { AcpxRuntimeHost } from "./acpx-runtime-host.js";

function completedTurn(requestId: string): AcpRuntimeTurn {
  return {
    requestId,
    promptStarted: Promise.resolve(),
    events: { async *[Symbol.asyncIterator]() {} },
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    cancel: async () => {},
    closeStream: async () => {},
  };
}

describe("AcpxRuntimeHost", () => {
  it("resolves a pinned profile, isolates state, and keeps credentials out of session records", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-host-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let captured: AcpRuntimeOptions | null = null;
    let ensureInput: Parameters<AcpRuntime["ensureSession"]>[0] | null = null;
    const handle: AcpRuntimeHandle = {
      sessionKey: "session-key",
      backend: "acpx",
      runtimeSessionName: "runtime-name",
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
    };
    const runtimeFactory = (options: AcpRuntimeOptions): AcpRuntime => {
      captured = options;
      return {
        ensureSession: async (input) => { ensureInput = input; return handle; },
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          acpxRecordId: "record-1",
          backendSessionId: "backend-1",
          agentSessionId: "agent-1",
          models: {
            currentModelId: "openrouter/deepseek/deepseek-v4-flash-0731",
            availableModelIds: ["openrouter/deepseek/deepseek-v4-flash-0731"],
          },
        }),
        cancel: async () => {},
        close: async () => {},
      };
    };
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "company/agent/session",
      workingDirectory: workspace,
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      dynamicTools: [{
        operationId: "get_task_context",
        description: "Read task context.",
        inputSchema: { type: "object", additionalProperties: false },
      }],
      environment: {
        PATH: process.env.PATH,
        LANG: "en_US.UTF-8",
        OPENROUTER_API_KEY: "openrouter-canary-secret",
        PAPERCLIP_API_KEY: "paperclip-must-not-pass",
        DATABASE_URL: "database-must-not-pass",
      },
      dynamicToolHandler: async () => ({ ok: true }),
      runtimeFactory,
    });
    try {
      expect(host.identity()).toMatchObject({
        acpxRecordId: "record-1",
        agentSessionId: "agent-1",
        requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
        effectiveModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      });
      const options = captured as AcpRuntimeOptions & { spawnEnvironment?: () => Record<string, string> };
      const childEnvironment = options.spawnEnvironment?.() ?? {};
      expect(childEnvironment.OPENROUTER_API_KEY).toBe("openrouter-canary-secret");
      expect(JSON.parse(childEnvironment.PI_ACP_PI_ARGS_JSON ?? "[]")).toEqual(expect.arrayContaining([
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      ]));
      expect(childEnvironment.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(childEnvironment.PI_TELEMETRY).toBe("0");
      const catalogResponse = await fetch(childEnvironment.PAPERCLIP_RUNNER_BRIDGE_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${childEnvironment.PAPERCLIP_RUNNER_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "catalog", method: "tools/list", params: {} }),
      });
      const catalog = await catalogResponse.json() as { result: { tools: Array<{ name: string }> } };
      expect(catalog.result.tools.map((tool) => tool.name)).toContain("get_task_context");
      expect(JSON.stringify(childEnvironment)).not.toContain("paperclip-must-not-pass");
      expect(JSON.stringify(childEnvironment)).not.toContain("database-must-not-pass");
      expect(JSON.stringify(ensureInput)).not.toContain("openrouter-canary-secret");
      expect(JSON.stringify(ensureInput)).not.toContain("paperclip-must-not-pass");
      expect((await stat(host.runtimeRoot())).mode & 0o777).toBe(0o700);
      const settingsPath = join(host.runtimeRoot(), "pi-home", "settings.json");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
      });
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    } finally {
      await host.close({ reason: "test complete" });
    }
  });

  it("rejects model fallback before starting the runtime", async () => {
    await expect(AcpxRuntimeHost.open({
      runtimeDirectory: await mkdtemp(join(tmpdir(), "paperclip-acpx-model-")),
      normalizedSessionId: "session",
      workingDirectory: process.cwd(),
      agent: "pi",
      model: "openrouter/another-model",
      dynamicToolHandler: async () => ({}),
      runtimeFactory: () => { throw new Error("runtime must not start"); },
    })).rejects.toThrow("requires exact model");
  });

  it("rejects recovery identity drift before constructing or spawning the runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-recovery-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const sessionRoot = join(root, "acpx", "session");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "identity.json"), JSON.stringify({
      acpxRecordId: "record-real",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      effectiveModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      profileDigest: "sha256:896d0f734998529087bc2af0854112b2064c83047c4bc59359420510abd14791",
    }));
    let runtimeConstructed = false;
    await expect(AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "session",
      workingDirectory: workspace,
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      expectedIdentity: {
        kind: "acpx",
        normalizedSessionId: "session",
        acpxRecordId: "record-stale",
        backendSessionId: "backend-1",
        agentSessionId: "agent-1",
        profileDigest: "sha256:896d0f734998529087bc2af0854112b2064c83047c4bc59359420510abd14791",
        workspaceDigest: `sha256:${createHash("sha256").update(resolve(workspace)).digest("hex")}`,
        requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
        effectiveModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      },
      dynamicToolHandler: async () => ({}),
      runtimeFactory: () => {
        runtimeConstructed = true;
        throw new Error("runtime must not start");
      },
    })).rejects.toThrow("does not match the persisted runtime record");
    expect(runtimeConstructed).toBe(false);
  });
});
