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
    const usages: unknown[] = [];
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
      onUsage: (usage) => usages.push(usage),
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
      options.onAgentStderr?.("[paperclip-pi-usage-v1]{\"inputTokens\":12,\"outputTokens\":3,");
      options.onAgentStderr?.("\"totalTokens\":15,\"cost\":{\"amount\":0.001,\"currency\":\"USD\"}}\n");
      expect(usages).toEqual([{
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cost: { amount: 0.001, currency: "USD" },
      }]);
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

  it("verifies Claude's exact canonical model through its ACP selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-claude-model-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const setCalls: Array<{ key: string; value: unknown }> = [];
    let capturedOptions: AcpRuntimeOptions | null = null;
    let externalPermissionRequests = 0;
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "claude-model-session",
      workingDirectory: workspace,
      agent: "claude",
      model: "claude-sonnet-5",
      environment: { PATH: process.env.PATH },
      dynamicToolHandler: async () => ({}),
      onPermissionRequest: async () => {
        externalPermissionRequests += 1;
        return { outcome: "reject_once" };
      },
      runtimeFactory: (options) => {
        capturedOptions = options;
        return {
        ensureSession: async () => ({
          sessionKey: "claude-session-key",
          backend: "acpx",
          runtimeSessionName: "claude-runtime",
          acpxRecordId: "claude-record",
          backendSessionId: "claude-backend",
          agentSessionId: "claude-agent",
        }),
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          acpxRecordId: "claude-record",
          backendSessionId: "claude-backend",
          agentSessionId: "claude-agent",
          models: { currentModelId: "sonnet", availableModelIds: ["default", "sonnet", "opus"] },
        }),
        setConfigOption: async (input) => { setCalls.push({ key: input.key, value: input.value }); },
        cancel: async () => {},
        close: async () => {},
        };
      },
    });
    try {
      expect(setCalls).toEqual([{ key: "model", value: "claude-sonnet-5" }]);
      expect(host.identity()).toMatchObject({
        requestedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
      });
      expect((await host.status()).models).toMatchObject({
        currentModelId: "claude-sonnet-5",
        availableModelIds: ["default", "claude-sonnet-5", "opus"],
      });
      const permissionHandler = (capturedOptions as AcpRuntimeOptions).onPermissionRequest!;
      await expect(permissionHandler({
        sessionId: "claude-agent",
        inferredKind: "other",
        raw: {
          sessionId: "claude-agent",
          toolCall: {
            toolCallId: "tool-paperclip",
            title: "mcp__paperclip__get_task_context",
            kind: "other",
          },
          options: [],
        },
      }, { signal: new AbortController().signal })).resolves.toEqual({ outcome: "allow_once" });
      expect(externalPermissionRequests).toBe(0);
      await expect(permissionHandler({
        sessionId: "claude-agent",
        inferredKind: "execute",
        raw: {
          sessionId: "claude-agent",
          toolCall: { toolCallId: "tool-bash", title: "Bash", kind: "execute" },
          options: [],
        },
      }, { signal: new AbortController().signal })).resolves.toEqual({ outcome: "reject_once" });
      expect(externalPermissionRequests).toBe(1);
    } finally {
      await host.close({ reason: "test complete" });
    }
  });

  it("rejects an unverified Claude selector even after an exact model set", async () => {
    await expect(AcpxRuntimeHost.open({
      runtimeDirectory: await mkdtemp(join(tmpdir(), "paperclip-acpx-claude-drift-")),
      normalizedSessionId: "claude-model-drift",
      workingDirectory: process.cwd(),
      agent: "claude",
      model: "claude-sonnet-5",
      dynamicToolHandler: async () => ({}),
      runtimeFactory: () => ({
        ensureSession: async () => ({
          sessionKey: "claude-drift-key",
          backend: "acpx",
          runtimeSessionName: "claude-drift-runtime",
          acpxRecordId: "claude-drift-record",
          backendSessionId: "claude-drift-backend",
          agentSessionId: "claude-drift-agent",
        }),
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          models: { currentModelId: "default", availableModelIds: ["default", "sonnet"] },
        }),
        setConfigOption: async () => {},
        cancel: async () => {},
        close: async () => {},
      }),
    })).rejects.toThrow("expected ACP selector sonnet");
  });

  it("stages managed Codex auth only in the isolated home and removes it on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-codex-auth-"));
    const workspace = join(root, "workspace");
    const sourceAuth = join(root, "managed-auth.json");
    await mkdir(workspace);
    await writeFile(sourceAuth, JSON.stringify({ tokens: { access_token: "managed-codex-canary" } }), { mode: 0o600 });
    let isolatedAuthPath = "";
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "codex-session",
      workingDirectory: workspace,
      agent: "codex",
      model: "gpt-5.6-sol",
      environment: { PATH: process.env.PATH },
      managedCredentialSources: { codexAuthPath: sourceAuth },
      dynamicToolHandler: async () => ({}),
      runtimeFactory: (options) => ({
        ensureSession: async (input) => {
          const environment = (options as AcpRuntimeOptions & { spawnEnvironment?: () => Record<string, string> }).spawnEnvironment?.() ?? {};
          expect(JSON.stringify(input)).not.toContain("managed-codex-canary");
          expect(environment.CODEX_HOME).toContain("codex-home");
          isolatedAuthPath = join(environment.CODEX_HOME!, "auth.json");
          expect(await readFile(isolatedAuthPath, "utf8")).toContain("managed-codex-canary");
          return {
            sessionKey: "codex-session-key",
            backend: "acpx",
            runtimeSessionName: "codex-runtime",
            acpxRecordId: "codex-record",
            backendSessionId: "codex-backend",
            agentSessionId: "codex-agent",
          };
        },
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          acpxRecordId: "codex-record",
          backendSessionId: "codex-backend",
          agentSessionId: "codex-agent",
          models: { currentModelId: "gpt-5.6-sol", availableModelIds: ["gpt-5.6-sol"] },
        }),
        cancel: async () => {},
        close: async () => {},
      }),
    });
    expect((await stat(isolatedAuthPath)).mode & 0o777).toBe(0o600);
    await host.close({ reason: "test complete" });
    await expect(readFile(isolatedAuthPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sourceAuth, "utf8")).toContain("managed-codex-canary");
  });

  it("retains the record but still closes Pi when backend session deletion is unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-close-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const closeAttempts: boolean[] = [];
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "pi-close-session",
      workingDirectory: workspace,
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      environment: { PATH: process.env.PATH },
      dynamicToolHandler: async () => ({}),
      runtimeFactory: () => ({
        ensureSession: async () => ({
          sessionKey: "pi-close-key",
          backend: "acpx",
          runtimeSessionName: "pi-close-runtime",
          acpxRecordId: "pi-close-record",
          backendSessionId: "pi-close-backend",
          agentSessionId: "pi-close-agent",
        }),
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          acpxRecordId: "pi-close-record",
          backendSessionId: "pi-close-backend",
          agentSessionId: "pi-close-agent",
          models: {
            currentModelId: "openrouter/deepseek/deepseek-v4-flash-0731",
            availableModelIds: ["openrouter/deepseek/deepseek-v4-flash-0731"],
          },
        }),
        cancel: async () => {},
        close: async (input) => {
          closeAttempts.push(input.discardPersistentState === true);
          if (input.discardPersistentState) {
            const error = new Error("Pi does not implement session/close") as Error & { code: string };
            error.code = "ACP_BACKEND_UNSUPPORTED_CONTROL";
            throw error;
          }
        },
      }),
    });

    await expect(host.close({ reason: "environment probe", discardPersistentState: true })).resolves.toBeUndefined();
    expect(closeAttempts).toEqual([true, false]);
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
      profileDigest: "sha256:e806321f458baaf23aa5580324d8f90a59082066105eda69de35b1ef0c8418eb",
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
        profileDigest: "sha256:e806321f458baaf23aa5580324d8f90a59082066105eda69de35b1ef0c8418eb",
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
