#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import type { HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { OpenCodeServerDriver } from "../drivers/opencode/opencode-server-driver.js";

type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextServerRequestId = 1;
let driver: OpenCodeServerDriver | null = null;
let session: HarnessSession | null = null;
let eventPump: Promise<void> | null = null;
let cwd = "";
let activeTurnId: string | null = null;
const announcedTurnIds = new Set<string>();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requestController(method: string, params: unknown): Promise<unknown> {
  const id = `opencode-${nextServerRequestId++}`;
  send({ id, method, params });
  return new Promise((resolveValue, reject) => pending.set(id, { resolve: resolveValue, reject }));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function runtimeDirectory(): string {
  const configured = process.env.PAPERCLIP_OPENCODE_RUNTIME_DIR?.trim();
  if (!configured) throw new Error("PAPERCLIP_OPENCODE_RUNTIME_DIR is required");
  return resolve(configured);
}

async function open(params: Record<string, unknown>, resume: boolean): Promise<Record<string, unknown>> {
  if (session) return threadResponse(session.ids().providerSessionId ?? session.ids().driverSessionId);
  cwd = resolve(text(params.cwd, process.cwd()));
  const model = text(params.model);
  if (!model.includes("/")) throw new Error("OpenCode proxy requires model in provider/model form");
  const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools.map(record) : [];
  driver = new OpenCodeServerDriver({
    model,
    command: process.env.PAPERCLIP_OPENCODE_COMMAND?.trim() || "opencode",
    runtimeDirectory: runtimeDirectory(),
    environment: process.env,
    runnerInstanceId: process.env.PAPERCLIP_RUNNER_INSTANCE_ID ?? "paperclip-runnerd-opencode",
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Complete the provider turn supplied by Paperclip Runner.",
      constraints: [
        text(params.baseInstructions, "Complete only the supplied task."),
        "Work only inside the supplied working directory.",
        "Use Paperclip MCP tools for semantic operations.",
      ],
    }),
    dynamicTools,
    dynamicToolHandler: async (call) => requestController("item/tool/call", {
      threadId: session?.ids().driverSessionId ?? "opening",
      turnId: call.turnId,
      callId: call.callId,
      tool: call.tool,
      arguments: call.arguments,
    }),
    onDiagnostic: (message) => process.stderr.write(`[opencode] ${message}\n`),
    // runnerd gives this proxy its own process group. Keep `opencode serve` in
    // that same group so runnerd's TERM/KILL fallback cannot orphan it.
    isolateProcessGroup: false,
  });
  if (resume) {
    const threadId = text(params.threadId);
    const snapshot: PersistedHarnessSession = {
      driverKind: "opencode_server",
      driverSessionId: threadId,
      providerSessionId: threadId,
      runId: process.env.PAPERCLIP_RUN_ID ?? "runnerd-run",
      normalizedSessionId: process.env.PAPERCLIP_NORMALIZED_SESSION_ID ?? threadId,
      activeTurnId: null,
      lastSourceSequence: 0,
    };
    const recovered = await driver.recoverSession(snapshot);
    if (!recovered.recovered || !recovered.session) throw new Error(recovered.reason ?? "OpenCode recovery failed");
    session = recovered.session;
  } else {
    session = await driver.openSession({
      runId: process.env.PAPERCLIP_RUN_ID ?? "runnerd-run",
      normalizedSessionId: process.env.PAPERCLIP_NORMALIZED_SESSION_ID ?? `runnerd-${Date.now()}`,
      workingDirectory: cwd,
    });
  }
  eventPump = pumpEvents(session);
  return threadResponse(session.ids().providerSessionId ?? session.ids().driverSessionId);
}

function threadResponse(id: string): Record<string, unknown> {
  return { thread: { id, sessionId: id, cwd }, model: process.env.PAPERCLIP_OPENCODE_MODEL ?? null };
}

function announceTurnStarted(opened: HarnessSession, turnId: string): void {
  if (announcedTurnIds.has(turnId)) return;
  announcedTurnIds.add(turnId);
  send({
    method: "turn/started",
    params: {
      threadId: opened.ids().driverSessionId,
      turnId,
      turn: { id: turnId, status: "inProgress" },
    },
  });
}

async function pumpEvents(opened: HarnessSession): Promise<void> {
  for await (const event of opened.events()) {
    const payload = record(event.payload);
    if (event.eventType === "turn.started") {
      if (typeof event.turnId === "string") announceTurnStarted(opened, event.turnId);
    } else if (event.eventType === "item.started" || event.eventType === "item.delta" || event.eventType === "item.completed") {
      const assistantText = payload.kind === "text" && typeof payload.text === "string"
        ? payload.text
        : null;
      const method = event.eventType === "item.delta" && assistantText !== null
        ? "item/agentMessage/delta"
        : event.eventType.replace(".", "/");
      const providerItem = record(payload.item);
      const item = assistantText === null
        ? payload.item ?? { id: event.itemId, type: payload.kind, text: payload.text }
        : { ...providerItem, id: event.itemId, type: "agentMessage", text: assistantText };
      send({
        method,
        params: {
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          ...payload,
          item,
          ...(method === "item/agentMessage/delta" ? { delta: assistantText } : {}),
        },
      });
      if (payload.kind === "usage") {
        const usage = record(payload.usage);
        const cache = record(usage.cache);
        send({ method: "thread/tokenUsage/updated", params: {
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          tokenUsage: { total: {
            inputTokens: usage.inputTokens ?? usage.input ?? 0,
            outputTokens: usage.outputTokens ?? usage.output ?? 0,
            cachedInputTokens: usage.cachedInputTokens ?? cache.read ?? 0,
            reasoningTokens: usage.reasoningTokens ?? usage.reasoning ?? 0,
            costUsd: usage.costUsd ?? usage.cost ?? null,
          } },
        } });
      }
    } else if (event.eventType === "run.result.proposed") {
      send({
        method: "paperclip/runResult",
        params: {
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId ?? "semantic-result",
          result: payload,
        },
      });
    } else if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
      const status = event.eventType.slice("turn.".length);
      send({ method: "turn/completed", params: { threadId: opened.ids().driverSessionId, turnId: event.turnId, turn: { id: event.turnId, status } } });
      activeTurnId = null;
    } else if (event.eventType === "harness.diagnostic") {
      send({ method: "warning", params: { threadId: opened.ids().driverSessionId, message: payload.message ?? payload.code } });
    }
  }
}

async function handle(message: RpcMessage): Promise<void> {
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
    else {
      const contentItems = record(message.result).contentItems;
      waiter.resolve(Array.isArray(contentItems) ? contentItems[0] ?? message.result : message.result);
    }
    return;
  }
  if (!message.method || message.id === undefined) return;
  const params = record(message.params);
  let result: unknown;
  switch (message.method) {
    case "initialize":
      result = { user: { sessionId: "opencode" }, serverInfo: { name: "opencode", version: "1.18.17" } };
      break;
    case "thread/start": result = await open(params, false); break;
    case "thread/resume": result = await open(params, true); break;
    case "turn/start": {
      if (!session) throw new Error("OpenCode thread is not open");
      const inputItems = Array.isArray(params.input) ? params.input.map(record) : [];
      const messageText = inputItems.map((entry) => text(entry.text)).filter(Boolean).join("\n");
      const turn = await session.startTurn({ message: { role: "user", text: messageText } });
      activeTurnId = turn.turnId;
      // OpenCode normally publishes session/turn startup over SSE, but a fast
      // completion can make the synchronous prompt response the only place the
      // authoritative turn id is observed. Emit the normalized notification
      // after this request's JSON-RPC response: runnerd's request reader ignores
      // notifications that arrive before the matching response. Clearing an
      // earlier SSE announcement guarantees one post-response signal, while
      // announceTurnStarted still deduplicates any later SSE echo.
      queueMicrotask(() => {
        announcedTurnIds.delete(turn.turnId);
        announceTurnStarted(session!, turn.turnId);
      });
      result = { turn: { id: turn.turnId, status: "inProgress" } };
      break;
    }
    case "turn/interrupt":
      if (!session?.interrupt) throw new Error("OpenCode interruption is unavailable");
      await session.interrupt({ turnId: text(params.turnId, activeTurnId ?? "") });
      result = true;
      break;
    case "thread/read":
      if (!session) throw new Error("OpenCode thread is not open");
      result = { thread: { id: session.ids().driverSessionId, cwd, turns: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [] }, transcript: await session.read?.() };
      break;
    default: throw new Error(`Unsupported OpenCode proxy method ${message.method}`);
  }
  send({ id: message.id, result });
}

input.on("line", (line) => {
  if (!line.trim()) return;
  let message: RpcMessage;
  try { message = JSON.parse(line) as RpcMessage; }
  catch (error) { process.stderr.write(`Invalid JSON-RPC input: ${String(error)}\n`); return; }
  void handle(message).catch((error) => send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
});

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    for (const waiter of pending.values()) waiter.reject(new Error("OpenCode proxy is shutting down"));
    pending.clear();
    await session?.close({ reason: "proxy_shutdown", force: true }).catch(() => {});
    await eventPump?.catch(() => {});
  })().finally(() => process.exit(0));
  return shutdownPromise;
}

input.on("close", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
