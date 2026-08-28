import type { ChildProcess } from "node:child_process";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpSessionStore,
} from "acpx/runtime";

import type {
  AcpxRuntimePort,
  AcpxRuntimePortIdentity,
  AcpxRuntimePortOpenOptions,
} from "./runtime-host.js";
import { decideAcpxPermission } from "./permission-policy.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";
const RUNTIME_CLOSE_TIMEOUT_MS = 2_000;

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
}

/**
 * Adapt the pinned ACPX library to Paperclip's admitted runtime port. The
 * executable, launch environment, and spawn cwd stay host-owned and are never
 * persisted in ACPX's session options.
 */
export async function openCodexAcpxRuntime(
  options: AcpxRuntimePortOpenOptions,
  dependencies: CodexAcpxRuntimeDependencies = {},
): Promise<AcpxRuntimePort> {
  if (options.profile.agent !== "codex") {
    throw new Error(
      "The production ACPX runtime currently supports Codex only",
    );
  }

  const createRegistry = dependencies.createRegistry ?? createAgentRegistry;
  const createStore = dependencies.createStore ?? createRuntimeStore;
  const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
  const children = new SpawnedChildSet();
  const runnerOwnedMcpServerNames = new Set(
    options.mcpServers
      .filter((server) => server.runnerOwned)
      .map((server) => server.name),
  );
  const runtime = createRuntime({
    cwd: options.cwd,
    sessionStore: createStore({ stateDir: options.stateDirectory }),
    agentRegistry: createRegistry({
      overrides: { codex: [VERIFIED_COMMAND_SENTINEL] },
    }),
    permissionMode: options.permissionMode,
    elicitationModes: ["form"],
    nonInteractivePermissions: "fail",
    permissionPolicy: {
      ...options.permissionPolicy,
      autoApprove: options.permissionPolicy.autoApprove
        ? [...options.permissionPolicy.autoApprove]
        : undefined,
      escalate: options.permissionPolicy.escalate
        ? [...options.permissionPolicy.escalate]
        : undefined,
    },
    mcpServers: options.mcpServers.map((server) => ({
      type: "http" as const,
      name: server.name,
      url: server.url,
      headers: [
        { name: "Authorization", value: `Bearer ${server.bearerToken}` },
      ],
    })),
    onPermissionRequest: async (request) => {
      const disposition = decideAcpxPermission(
        options.profile.agent,
        options.permissionMode,
        request,
        {
          runnerOwnedMcpServerNames,
          allConfiguredMcpServersAreRunnerOwned:
            options.mcpServers.length > 0 &&
            options.mcpServers.every((server) => server.runnerOwned),
        },
      );
      return disposition === "delegate" ? undefined : { outcome: disposition };
    },
    spawnEnvironment: () => definedEnvironment(options.launchEnvironment),
    spawnCwd: options.cwd,
    spawnAgent: (input) =>
      children.add(
        options.command.spawn(input.args, input.options) as ChildProcess,
      ),
  });

  let handle: AcpRuntimeHandle;
  try {
    handle = await runtime.ensureSession({
      sessionKey: options.providerSessionKey,
      agent: "codex",
      mode: "persistent",
      cwd: options.cwd,
      sessionOptions: {
        model: options.profile.qualificationModel,
        ...(options.systemInstructions
          ? { systemPrompt: { append: options.systemInstructions } }
          : {}),
      },
    });
  } catch (error) {
    const cleanupErrors = await children.terminate();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX session handshake and provider cleanup failed",
      );
    }
    throw error;
  }

  try {
    return runtimePort(runtime, handle, requireIdentity(handle), children);
  } catch (error) {
    try {
      await runtime.close({
        handle,
        reason: "ACPX runtime identity validation failed",
        discardPersistentState: false,
      });
    } catch (cleanupError) {
      const processErrors = await children.terminate();
      throw new AggregateError(
        [error, cleanupError, ...processErrors],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    const processErrors = await children.terminate();
    if (processErrors.length > 0) {
      throw new AggregateError(
        [error, ...processErrors],
        "ACPX runtime identity validation and provider cleanup failed",
      );
    }
    throw error;
  }
}

function runtimePort(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
  children: SpawnedChildSet,
): AcpxRuntimePort {
  return {
    async identity() {
      return structuredClone(identity);
    },
    async getStatus() {
      if (!runtime.getStatus) {
        throw new Error("The pinned ACPX runtime cannot report session status");
      }
      return structuredClone(await runtime.getStatus({ handle }));
    },
    ...(runtime.setConfigOption
      ? {
          async setModel(model: string) {
            await runtime.setConfigOption?.({
              handle,
              key: "model",
              value: model,
            });
          },
        }
      : {}),
    startTurn(input) {
      return runtime.startTurn({
        handle,
        text: input.text,
        mode: "prompt",
        requestId: input.requestId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
      });
    },
    async close(input) {
      const closeError = await boundedRuntimeClose(
        Promise.resolve(
          runtime.close({
            handle,
            reason: input.reason,
            discardPersistentState: false,
          }),
        ),
        RUNTIME_CLOSE_TIMEOUT_MS,
      );
      const processErrors = await children.terminate();
      if (closeError !== null || processErrors.length > 0) {
        const errors = [...processErrors];
        if (closeError !== null) errors.unshift(closeError);
        throw new AggregateError(
          errors,
          "ACPX runtime and provider cleanup failed",
        );
      }
    },
  };
}

async function boundedRuntimeClose(
  close: Promise<void>,
  timeoutMs: number,
): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      close.then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise<Error>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              new Error("ACPX runtime close exceeded its shutdown timeout"),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class SpawnedChildSet {
  readonly #children = new Set<ChildProcess>();

  add(child: ChildProcess): ChildProcess {
    this.#children.add(child);
    const forget = () => this.#children.delete(child);
    child.once("exit", forget);
    child.once("close", forget);
    return child;
  }

  async terminate(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const children = [...this.#children];
    await Promise.all(
      children.map(async (child) => {
        if (!running(child)) return;
        try {
          child.kill("SIGTERM");
        } catch (error) {
          errors.push(error);
        }
        if (await waitForExit(child, 2_000)) return;
        try {
          child.kill("SIGKILL");
        } catch (error) {
          errors.push(error);
        }
        if (!(await waitForExit(child, 2_000))) {
          errors.push(new Error("ACPX provider did not exit after SIGKILL"));
        }
      }),
    );
    return errors;
  }
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (!running(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("close", onExit);
    if (!running(child)) finish(true);
  });
}

function requireIdentity(handle: AcpRuntimeHandle): AcpxRuntimePortIdentity {
  const identity = {
    acpxRecordId: handle.acpxRecordId,
    backendSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
  };
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`ACPX runtime omitted ${name}`);
    }
  }
  return identity as AcpxRuntimePortIdentity;
}

function definedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
