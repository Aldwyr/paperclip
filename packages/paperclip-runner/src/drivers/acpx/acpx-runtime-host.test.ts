import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
} from "acpx/runtime";
import { describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../../contracts/runtime-context.js";
import {
  AcpxRuntimeHost,
  inspectQualifiedAcpxInstallation,
  shouldAutoApproveRunnerOwnedSemanticPermission,
} from "./acpx-runtime-host.js";

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

async function createRuntimeContext(root: string): Promise<NativeRuntimeContextSnapshot> {
  const instructionRoot = join(root, "instruction-source");
  const skillRoot = join(root, "skill-source");
  await Promise.all([
    mkdir(instructionRoot, { recursive: true }),
    mkdir(join(skillRoot, "references"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(instructionRoot, "AGENTS.md"), "Read sibling.md\n"),
    writeFile(join(instructionRoot, "sibling.md"), "instruction sibling\n"),
    writeFile(join(skillRoot, "SKILL.md"), "# Assigned\nRead references/support.md\n"),
    writeFile(join(skillRoot, "references", "support.md"), "skill support\n"),
  ]);
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    },
    skills: [{
      key: "company/assigned",
      runtimeName: "assigned",
      versionId: "version-1",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: skillRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    }],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

describe("AcpxRuntimeHost", () => {
  it("launches Pi through the provider-local executable shim", async () => {
    const installation = await inspectQualifiedAcpxInstallation(
      "pi",
      "openrouter/deepseek/deepseek-v4-flash-0731",
    );

    expect(installation.agentRuntimePath).toMatch(
      /node_modules\/\.bin\/pi$/,
    );
    const launcher = await readFile(installation.agentRuntimePath!, "utf8");
    expect(launcher).toContain("node");
  });

  it("auto-approves only runner-owned semantic MCP calls for non-Pi ACP agents", () => {
    const permission = (title: string) => ({
      raw: { toolCall: { title } },
    }) as unknown as AcpPermissionRequest;
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "claude",
      permission("mcp__paperclip__paperclip_finish"),
    )).toBe(true);
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "codex",
      ({
        raw: {
          _meta: { is_mcp_tool_approval: true },
          toolCall: {
            rawInput: { serverName: "paperclip" },
          },
        },
      }) as unknown as AcpPermissionRequest,
    )).toBe(true);
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "codex",
      ({
        raw: {
          toolCall: {
            rawInput: { serverName: "paperclip-assigned" },
          },
        },
      }) as unknown as AcpPermissionRequest,
      new Set(["paperclip", "paperclip-assigned"]),
    )).toBe(true);
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "codex",
      ({
        raw: {
          _meta: { is_mcp_tool_approval: true },
          toolCall: {},
        },
      }) as unknown as AcpPermissionRequest,
      new Set(["paperclip", "paperclip-assigned"]),
      true,
    )).toBe(true);
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "pi",
      permission("mcp__paperclip__paperclip_finish"),
    )).toBe(false);
    expect(shouldAutoApproveRunnerOwnedSemanticPermission(
      "codex",
      ({
        raw: {
          _meta: { is_mcp_tool_approval: true },
          toolCall: {
            rawInput: { serverName: "company-github" },
          },
        },
      }) as unknown as AcpPermissionRequest,
    )).toBe(false);
  });

  it.each([
    { configuredMode: undefined, effectiveMode: "approve-all" as const, read: "allow_once", execute: "allow_once", delegated: 0 },
    { configuredMode: "approve-reads" as const, effectiveMode: "approve-reads" as const, read: "allow_once", execute: "reject_once", delegated: 1 },
    { configuredMode: "deny-all" as const, effectiveMode: "deny-all" as const, read: "reject_once", execute: "reject_once", delegated: 0 },
  ])("applies default/effective ACPX $effectiveMode without widening semantic-tool authority", async ({ configuredMode, effectiveMode, read, execute, delegated }) => {
    const root = await mkdtemp(join(tmpdir(), `paperclip-acpx-permission-${effectiveMode}-`));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let captured: AcpRuntimeOptions | null = null;
    let externalPermissionRequests = 0;
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: `permission-${effectiveMode}`,
      workingDirectory: workspace,
      agent: "claude",
      model: "claude-sonnet-5",
      permissionMode: configuredMode,
      dynamicToolHandler: async () => ({}),
      onPermissionRequest: async () => {
        externalPermissionRequests += 1;
        return { outcome: "reject_once" };
      },
      runtimeFactory: (options) => {
        captured = options;
        return {
          ensureSession: async () => ({
            sessionKey: `permission-${effectiveMode}`,
            backend: "acpx",
            runtimeSessionName: `permission-${effectiveMode}`,
            acpxRecordId: `record-${effectiveMode}`,
            backendSessionId: `backend-${effectiveMode}`,
            agentSessionId: `agent-${effectiveMode}`,
          }),
          startTurn: (input) => completedTurn(input.requestId),
          runTurn: async function* () {},
          getStatus: async () => ({
            acpxRecordId: `record-${effectiveMode}`,
            backendSessionId: `backend-${effectiveMode}`,
            agentSessionId: `agent-${effectiveMode}`,
            models: { currentModelId: "sonnet", availableModelIds: ["sonnet"] },
          }),
          setConfigOption: async () => {},
          cancel: async () => {},
          close: async () => {},
        };
      },
    });
    try {
      expect(host.identity().permissionMode).toBe(effectiveMode);
      expect((captured as AcpRuntimeOptions).permissionMode).toBe(effectiveMode);
      const permissionHandler = (captured as AcpRuntimeOptions).onPermissionRequest!;
      const request = (inferredKind: string, title: string) => ({
        sessionId: `agent-${effectiveMode}`,
        inferredKind,
        raw: { sessionId: `agent-${effectiveMode}`, toolCall: { title }, options: [] },
      }) as unknown as AcpPermissionRequest;
      await expect(permissionHandler(
        request("read", "Read"),
        { signal: new AbortController().signal },
      )).resolves.toEqual({ outcome: read });
      await expect(permissionHandler(
        request("execute", "Bash"),
        { signal: new AbortController().signal },
      )).resolves.toEqual({ outcome: execute });
      await expect(permissionHandler(
        request("execute", "mcp__paperclip__paperclip_finish"),
        { signal: new AbortController().signal },
      )).resolves.toEqual({ outcome: "allow_once" });
      expect(externalPermissionRequests).toBe(delegated);
    } finally {
      await host.close({ reason: "permission test complete" });
    }
  });

  it("resolves a pinned profile, isolates state, and keeps credentials out of session records", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-host-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let captured: AcpRuntimeOptions | null = null;
    let ensureInput: Parameters<AcpRuntime["ensureSession"]>[0] | null = null;
    let piElicitation: unknown = null;
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
      onElicitation: async (context) => {
        piElicitation = context.request;
        return { action: "accept", content: { environment: "staging", replicas: 3 } };
      },
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
      expect(catalog.result.tools.map((tool) => tool.name)).not.toContain("__paperclip_runtime_input");
      const permissionResponse = await fetch(childEnvironment.PAPERCLIP_RUNNER_BRIDGE_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${childEnvironment.PAPERCLIP_RUNNER_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "pi-permission-1",
          method: "tools/call",
          params: {
            name: "__paperclip_runtime_permission",
            arguments: { operation: "write", target: "index.html", inputClass: "workspace_mutation" },
          },
        }),
      });
      expect(await permissionResponse.json()).toMatchObject({
        result: { content: [{ text: expect.stringContaining("accept_for_session") }] },
      });
      const inputResponse = await fetch(childEnvironment.PAPERCLIP_RUNNER_BRIDGE_URL!, {
        method: "POST",
        headers: {
          authorization: `Bearer ${childEnvironment.PAPERCLIP_RUNNER_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "pi-input-1",
          method: "tools/call",
          params: {
            name: "__paperclip_runtime_input",
            arguments: {
              title: "Deployment",
              description: "Choose deployment settings.",
              questions: [
                {
                  id: "environment",
                  header: "Environment",
                  prompt: "Where should we deploy?",
                  answerMode: "single_select",
                  options: [
                    { id: "staging", label: "Staging" },
                    { id: "production", label: "Production" },
                  ],
                },
                {
                  id: "replicas",
                  prompt: "How many replicas?",
                  answerMode: "integer",
                  minimum: 1,
                  maximum: 10,
                },
              ],
            },
          },
        }),
      });
      expect(inputResponse.ok).toBe(true);
      expect(await inputResponse.json()).toMatchObject({
        result: { content: [{ type: "text", text: expect.stringContaining("staging") }] },
      });
      expect(piElicitation).toMatchObject({
        mode: "form",
        message: "Choose deployment settings.",
        requestedSchema: {
          title: "Deployment",
          required: ["environment", "replicas"],
          properties: {
            environment: { type: "string", title: "Environment" },
            replicas: { type: "integer", minimum: 1, maximum: 10 },
          },
        },
      });
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

  it.each([
    { agent: "pi" as const, model: "openrouter/deepseek/deepseek-v4-flash-0731" },
    { agent: "claude" as const, model: "claude-sonnet-5" },
    { agent: "codex" as const, model: "gpt-5.6-sol" },
  ])("realizes the complete Paperclip context for ACPX $agent", async ({ agent, model }) => {
    const root = await mkdtemp(join(tmpdir(), `paperclip-acpx-${agent}-context-`));
    const workspace = join(root, "workspace");
    const tracePath = join(root, "provider-trace.ndjson");
    await mkdir(workspace);
    const runtimeContext = await createRuntimeContext(root);
    const systemInstructions = `${PAPERCLIP_EXECUTION_PROMPT}\n\nRead sibling.md\n\nRead-only instruction sibling root: ${runtimeContext.instructions.bundle.rootPath}`;
    let capturedOptions: AcpRuntimeOptions | null = null;
    let ensureInput: Parameters<AcpRuntime["ensureSession"]>[0] | null = null;
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: `${agent}-runtime-context`,
      workingDirectory: workspace,
      agent,
      model,
      systemInstructions,
      runtimeContext,
      environment: {
        PATH: process.env.PATH,
        PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp",
        PAPERCLIP_NATIVE_MCP_TOKEN: "x".repeat(40),
        PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
        ...(agent === "codex" ? { CODEX_API_KEY: "test-codex-key" } : {}),
      },
      dynamicToolHandler: async () => ({}),
      onElicitation: async () => ({ action: "cancel" }),
      runtimeFactory: (options) => {
        capturedOptions = options;
        return {
          ensureSession: async (input) => {
            ensureInput = input;
            if (agent === "codex") {
              const environment = (options as AcpRuntimeOptions & { spawnEnvironment?: () => Record<string, string> })
                .spawnEnvironment?.() ?? {};
              await writeFile(join(environment.CODEX_HOME!, "auth.json"), '{"OPENAI_API_KEY":"test-codex-key"}', { mode: 0o600 });
            }
            return {
              sessionKey: `${agent}-session-key`,
              backend: "acpx",
              runtimeSessionName: `${agent}-runtime`,
              acpxRecordId: `${agent}-record`,
              backendSessionId: `${agent}-backend`,
              agentSessionId: `${agent}-agent`,
            };
          },
          startTurn: (input) => completedTurn(input.requestId),
          runTurn: async function* () {},
          getStatus: async () => ({
            acpxRecordId: `${agent}-record`,
            backendSessionId: `${agent}-backend`,
            agentSessionId: `${agent}-agent`,
            models: {
              currentModelId: agent === "claude" ? "sonnet" : model,
              availableModelIds: [agent === "claude" ? "sonnet" : model],
            },
          }),
          setConfigOption: async () => {},
          cancel: async () => {},
          close: async () => {},
        };
      },
    });
    try {
      const options = capturedOptions as AcpRuntimeOptions & { spawnEnvironment?: () => Record<string, string> };
      const environment = options.spawnEnvironment?.() ?? {};
      options.onAcpMessage?.("outbound", {
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: {},
      } as never);
      options.onAcpMessage?.("inbound", {
        jsonrpc: "2.0",
        id: 1,
        result: { sessionId: "provider-session" },
      } as never);
      host.correlateProviderFrame(
        host.latestInboundTraceFrameId(),
        ["event-1", "event-2", "event-3"],
        "semantic_tool.paperclip_finish",
      );
      expect(environment.PAPERCLIP_ACPX_ISOLATED_CONTEXT).toBe("1");
      if (agent === "codex") {
        expect(environment.CODEX_API_KEY).toBe("test-codex-key");
        expect(environment.DEFAULT_AUTH_REQUEST).toBe('{"methodId":"api-key"}');
        expect(environment.NO_BROWSER).toBe("1");
      }
      expect(options.elicitationModes).toEqual(agent === "codex" ? [] : ["form"]);
      expect(ensureInput).toMatchObject({
        sessionOptions: { systemPrompt: { append: systemInstructions } },
      });
      expect(JSON.stringify(ensureInput)).not.toContain("x".repeat(40));
      await expect(readFile(join(host.runtimeRoot(), `${agent}-home`, "skills", "assigned", "references", "support.md"), "utf8"))
        .resolves.toBe("skill support\n");
      if (agent === "pi") {
        expect(JSON.parse(environment.PI_ACP_PI_ARGS_JSON ?? "[]")).not.toContain("--no-skills");
        expect(options.mcpServers).toEqual([]);
        expect(environment.PAPERCLIP_NATIVE_MCP_URL).toBe("https://paperclip.example/mcp");
      } else {
        expect(options.mcpServers).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "paperclip-assigned", url: "https://paperclip.example/mcp" }),
        ]));
      }
    } finally {
      await host.close({ reason: "test complete" });
    }
    if (agent === "codex") {
      await expect(readFile(join(host.runtimeRoot(), "codex-home", "auth.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    const traceEntries = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traceEntries.filter((entry) => entry.kind === "frame")).toHaveLength(2);
    expect(traceEntries.filter((entry) => entry.kind === "interpretation")).toHaveLength(3);
    expect(traceEntries).toContainEqual(expect.objectContaining({
      kind: "interpretation",
      frameId: 2,
      stage: "typescript_acpx_runtime_normalization",
      ruleId: "acpx.runtime.semantic_tool.paperclip_finish",
      disposition: "mapped",
      emittedEventIds: ["event-1", "event-2", "event-3"],
    }));
    expect(traceEntries.at(-1)).toMatchObject({ kind: "trace_status", status: "complete" });
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
      permissionMode: "approve-reads",
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
          expect(environment.DEFAULT_AUTH_REQUEST).toBeUndefined();
          expect(environment.NO_BROWSER).toBe("1");
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

  it("stages environment-delivered managed Codex auth without forwarding the JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-codex-env-auth-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canary = "managed-codex-environment-canary";
    let isolatedAuthPath = "";
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "codex-environment-session",
      workingDirectory: workspace,
      agent: "codex",
      model: "gpt-5.6-sol",
      environment: {
        PATH: process.env.PATH,
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: JSON.stringify({
          tokens: { access_token: canary },
        }),
      },
      dynamicToolHandler: async () => ({}),
      runtimeFactory: (options) => ({
        ensureSession: async (input) => {
          const environment = (options as AcpRuntimeOptions & { spawnEnvironment?: () => Record<string, string> }).spawnEnvironment?.() ?? {};
          expect(JSON.stringify(input)).not.toContain(canary);
          expect(JSON.stringify(environment)).not.toContain(canary);
          isolatedAuthPath = join(environment.CODEX_HOME!, "auth.json");
          expect(await readFile(isolatedAuthPath, "utf8")).toContain(canary);
          return {
            sessionKey: "codex-env-session-key",
            backend: "acpx",
            runtimeSessionName: "codex-env-runtime",
            acpxRecordId: "codex-env-record",
            backendSessionId: "codex-env-backend",
            agentSessionId: "codex-env-agent",
          };
        },
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({
          acpxRecordId: "codex-env-record",
          backendSessionId: "codex-env-backend",
          agentSessionId: "codex-env-agent",
          models: { currentModelId: "gpt-5.6-sol", availableModelIds: ["gpt-5.6-sol"] },
        }),
        cancel: async () => {},
        close: async () => {},
      }),
    });
    expect((await stat(isolatedAuthPath)).mode & 0o777).toBe(0o600);
    await host.close({ reason: "test complete" });
    await expect(readFile(isolatedAuthPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before provider startup when managed Codex auth is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-codex-missing-auth-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let runtimeStarted = false;
    await expect(AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "codex-missing-auth-session",
      workingDirectory: workspace,
      agent: "codex",
      model: "gpt-5.6-sol",
      environment: { PATH: process.env.PATH },
      managedCredentialSources: { codexAuthPath: join(root, "missing-auth.json") },
      dynamicToolHandler: async () => ({}),
      runtimeFactory: () => {
        runtimeStarted = true;
        throw new Error("runtime must not start");
      },
    })).rejects.toThrow(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
    expect(runtimeStarted).toBe(false);
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
      profileDigest: "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
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
        profileDigest: "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
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

  it("flushes and redacts a trailing ACP agent stderr fragment when startup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-stderr-flush-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const diagnostics: string[] = [];

    await expect(AcpxRuntimeHost.open({
      runtimeDirectory: root,
      normalizedSessionId: "stderr-flush",
      workingDirectory: workspace,
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      dynamicToolHandler: async () => ({}),
      onDiagnostic: (message) => diagnostics.push(message),
      runtimeFactory: (options) => ({
        ensureSession: async () => {
          options.onAgentStderr?.("fatal token=provider-secret");
          throw new Error("Cannot call write after a stream was destroyed");
        },
        startTurn: (input) => completedTurn(input.requestId),
        runTurn: async function* () {},
        getStatus: async () => ({}),
        cancel: async () => {},
        close: async () => {},
      }),
    })).rejects.toThrow("Cannot call write after a stream was destroyed");

    expect(diagnostics).toEqual(["fatal token=[REDACTED]"]);
  });
});
