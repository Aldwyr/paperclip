#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.argv[2];
if (!statePath) throw new Error("state path is required");

function load() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      threadId: "thread-native-resume",
      sessionId: "session-native-resume",
      turnId: "turn-native-resume",
      pendingTool: null,
      completed: false,
    };
  }
}

let state = load();
let buffer = "";

function save() {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendPendingTool() {
  if (!state.pendingTool) return;
  send({
    id: state.pendingTool.requestId,
    method: "item/tool/call",
    params: {
      threadId: state.threadId,
      turnId: state.turnId,
      callId: state.pendingTool.callId,
      tool: "report_progress",
      arguments: {
        idempotencyKey: "native-resume-progress",
        body: "One native resume effect.",
      },
    },
  });
}

function handleRequest(message) {
  const { id, method } = message;
  if (method === "initialize") {
    send({ id, result: { user: { sessionId: state.sessionId } } });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    send({
      id,
      result: {
        model: "gpt-native-resume-fixture",
        modelProvider: "openai-fixture",
        thread: { id: state.threadId, sessionId: state.sessionId },
      },
    });
    if (method === "thread/resume") sendPendingTool();
    return;
  }
  if (method === "thread/read") {
    send({
      id,
      result: {
        thread: {
          id: state.threadId,
          sessionId: state.sessionId,
          turns: [{ id: state.turnId, status: state.completed ? "completed" : "inProgress" }],
          tokenUsage: {
            total: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
          },
        },
      },
    });
    return;
  }
  if (method === "turn/start") {
    state.pendingTool = {
      requestId: "rpc-native-resume",
      callId: "call-native-resume",
    };
    save();
    send({ id, result: { turn: { id: state.turnId, status: "inProgress" } } });
    send({
      method: "turn/started",
      params: {
        threadId: state.threadId,
        turn: { id: state.turnId, status: "inProgress" },
      },
    });
    sendPendingTool();
    return;
  }
  send({ id, error: { code: -32601, message: `unsupported method ${method}` } });
}

function handle(message) {
  if (message.method) {
    if (message.id !== undefined) handleRequest(message);
    return;
  }
  if (!state.pendingTool || String(message.id) !== state.pendingTool.requestId) return;
  const toolResult = message.result;
  state.pendingTool = null;
  state.completed = true;
  save();
  send({
    method: "item/completed",
    params: {
      threadId: state.threadId,
      turnId: state.turnId,
      item: {
        id: "message-native-resume",
        type: "agentMessage",
        text: `Tool result: ${JSON.stringify(toolResult)}`,
      },
    },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: state.threadId,
      turnId: state.turnId,
      tokenUsage: {
        total: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
        },
        runDelta: {
          requests: 1,
          inputTokens: 10,
          cacheReadTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          providerCostUsd: 0,
        },
      },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: state.threadId,
      turn: { id: state.turnId, status: "completed" },
    },
  });
}

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
