import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import {
  createCapabilityRunnerdCodexTransport,
  createSanitizedAwsAgentCoreEnvironment,
  defaultCapabilityRunnerdBinary,
  rehydrateRunnerdUsageNotification,
  unwrapRunnerdProviderNotification,
  unwrapRunnerdProviderNotifications,
} from "./runnerd-codex-transport.js";

it("passes only workload-identity metadata to the AgentCore runner", () => {
  const sanitized = createSanitizedAwsAgentCoreEnvironment({
    PATH: "/bin",
    AWS_PROFILE: "paperclip-dev",
    AWS_REGION: "us-east-1",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/workload",
    AWS_ACCESS_KEY_ID: "AKIACANARY",
    AWS_SECRET_ACCESS_KEY: "secret-canary",
    AWS_SESSION_TOKEN: "token-canary",
    PAPERCLIP_API_KEY: "paperclip-canary",
    ANTHROPIC_API_KEY: "anthropic-canary",
  });
  expect(sanitized).toEqual({
    PATH: "/bin",
    AWS_PROFILE: "paperclip-dev",
    AWS_REGION: "us-east-1",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/workload",
  });
});

it("rehydrates normalized usage with the provider thread binding", () => {
  expect(rehydrateRunnerdUsageNotification({
    providerSessionId: "thread-1",
    cumulative: { inputTokens: 10 },
    runDelta: { inputTokens: 3 },
  }, "fallback-thread", "turn-1")).toMatchObject({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: { inputTokens: 10 },
      runDelta: { inputTokens: 3 },
    },
  });
});

const fakeCodex = resolve(
  import.meta.dirname,
  "../../runner/target/debug/fake-codex-app-server",
);

it("unwraps a coalesced provider notification without losing its turn identity", () => {
  expect(unwrapRunnerdProviderNotification({
    coalescedCount: 2,
    latest: {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
    },
  })).toEqual({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "provider-turn-1" } },
  });
});

it("replays every provider notification from a durable coalesced batch", () => {
  expect(unwrapRunnerdProviderNotifications({
    coalescedCount: 3,
    events: [
      { method: "item/started", params: { item: { id: "reasoning-1" } } },
      { method: "item/reasoning/summaryTextDelta", params: { delta: "Checking the task" } },
      { method: "item/completed", params: { item: { id: "reasoning-1" } } },
    ],
  })).toEqual([
    expect.objectContaining({ method: "item/started" }),
    expect.objectContaining({ method: "item/reasoning/summaryTextDelta" }),
    expect.objectContaining({ method: "item/completed" }),
  ]);
});

it("runs the lab provider boundary through authenticated durable PRP", async () => {
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: [],
  });
  bundle.transport.setServerRequestHandler(async (request) => ({
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ ok: true, result: { task: { title: "PRP lab task" } } }),
    }],
  }));
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [{
        name: "get_task_context",
        description: "Read the active task.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    expect(opened.thread).toMatchObject({ modelProvider: "openai" });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Read the task." }],
    });
    const methods: string[] = [];
    for await (const notification of bundle.transport.notifications()) {
      methods.push(notification.method);
      if (notification.method === "turn/completed") break;
    }
    expect(methods).toContain("turn/completed");
    expect(bundle.evidence().diagnostics).toContain(
      "runnerd authenticated to the durable PRP control plane",
    );
  } finally {
    await bundle.transport.close();
  }
  expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
}, 30_000);

it("steers the active provider turn through the durable PRP command path", async () => {
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: ["--linger-after-turn-start"],
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Work until I steer you." }],
    });

    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        input: [{ type: "text", text: "Prioritize the mobile queue layout." }],
        correlationId: "queued-comment-1",
      }),
    ).resolves.toEqual({});
    await expect(
      bundle.transport.request("turn/steer", {
        expectedTurnId: "stale-logical-turn",
        input: [{ type: "text", text: "This must not dispatch." }],
      }),
    ).rejects.toThrow("stale turn");

    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const methods: string[] = [];
    let acknowledged = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !acknowledged) {
      const next = await Promise.race([
        notifications.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("steering notification timeout")),
            1_000,
          ),
        ),
      ]);
      if (!next.value) break;
      methods.push(next.value.method);
      acknowledged =
        next.value.method === "item/completed" &&
        (next.value.params?.kind === "steering_acknowledgement" ||
          next.value.params?.item?.kind === "steering_acknowledgement");
    }
    expect(methods).toContain("turn/started");
    expect(acknowledged).toBe(true);
  } finally {
    await bundle.transport.close();
  }
}, 30_000);

it("attaches a second governed run to one warm runner and provider process", async () => {
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: [],
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [{
        name: "get_task_context",
        description: "Read the active task.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    const runnerPid = bundle.evidence().runnerPid;
    const providerPid = bundle.evidence().codexPid;
    const notifications = bundle.transport.notifications()[Symbol.asyncIterator]();
    const waitForCompletion = async (label: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          notifications.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} notification timeout`)), 1_000)),
        ]);
        if (next.value?.method === "turn/completed") return;
      }
      throw new Error(`${label} completion timeout`);
    };
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "first run" }] });
    await waitForCompletion("first run");

    await bundle.transport.attachRun?.({
      runId: "run-warm-second",
      turnId: "turn-binding-second",
      itemId: "item-binding-second",
    });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "second run" }] });
    await waitForCompletion("second run");

    expect(bundle.evidence()).toMatchObject({ runnerPid, codexPid: providerPid, runnerExited: false });
  } finally {
    await bundle.transport.close();
  }
}, 30_000);

it("cold-restores a suspended provider session under a new run binding", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-cold-attach-"));
  const baseIdentity = {
    runnerInstanceId: "runner-cold-attach",
    environmentLeaseId: "lease-cold-attach",
    runId: "run-cold-first",
    normalizedSessionId: "session-cold-attach",
    turnId: "turn-cold-first",
    itemId: "item-cold-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: [],
    stateDirectory,
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
  };
  const dynamicTools = [{
    name: "get_task_context",
    description: "Read the active task.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }];
  const first = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: baseIdentity });
  first.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools });
    await first.transport.request("turn/start", { input: [{ type: "text", text: "first process" }] });
    for await (const event of first.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
  } finally {
    await first.transport.close();
  }

  const restored = createCapabilityRunnerdCodexTransport({
    ...options,
    resumeDynamicTools: dynamicTools,
    prpIdentity: {
      ...baseIdentity,
      runId: "run-cold-restored",
      turnId: "turn-cold-restored",
      itemId: "item-cold-restored",
    },
  });
  restored.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    const read = await restored.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({ id: "fake-thread" });
    const durable = JSON.parse(await readFile(
      join(stateDirectory, "runner", "runner-state.json"),
      "utf8",
    )) as { providerToolBridge?: { authorized?: Record<string, unknown> } };
    expect(Object.keys(durable.providerToolBridge?.authorized ?? {})).toEqual(expect.arrayContaining([
      "get_task_context",
      "paperclip_finish",
      "paperclip_block",
    ]));
    await restored.transport.request("turn/start", { input: [{ type: "text", text: "restored process" }] });
    for await (const event of restored.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
    expect(restored.evidence()).toMatchObject({ runnerExited: false, codexPid: expect.any(Number) });
  } finally {
    await restored.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("rejects the notification stream promptly when runnerd exits after accepting a turn", async () => {
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: ["--linger-after-turn-start"],
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [{
        name: "get_task_context",
        description: "Read the active task.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport.notifications()[Symbol.asyncIterator]();
    expect((await notifications.next()).value?.method).toBe("turn/started");
    const runnerPid = bundle.evidence().runnerPid;
    expect(runnerPid).not.toBeNull();
    process.kill(runnerPid!, "SIGKILL");
    await expect(Promise.race([
      notifications.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("notification stream hung")), 2_000)),
    ])).rejects.toThrow("native_runner_process_exited");
  } finally {
    await bundle.transport.close();
  }
}, 30_000);
