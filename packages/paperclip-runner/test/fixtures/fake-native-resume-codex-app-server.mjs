#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const [mode, socketPath, statePath] = process.argv.slice(2);
if (!mode || !socketPath) throw new Error("mode and socket path are required");

if (mode === "proxy") {
  const socket = createConnection(socketPath);
  socket.once("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} else if (mode === "server") {
  if (!statePath) throw new Error("state path is required in server mode");

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

  function save() {
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  function send(socket, value) {
    socket.write(`${JSON.stringify(value)}\n`);
  }

  function sendPendingTool(socket) {
    if (!state.pendingTool) return;
    send(socket, {
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

  function handleRequest(socket, message) {
    const { id, method } = message;
    if (method === "initialize") {
      send(socket, { id, result: { user: { sessionId: state.sessionId } } });
      return;
    }
    if (method === "thread/start" || method === "thread/resume") {
      send(socket, {
        id,
        result: {
          model: "gpt-native-resume-fixture",
          modelProvider: "openai-fixture",
          thread: { id: state.threadId, sessionId: state.sessionId },
        },
      });
      if (method === "thread/resume") sendPendingTool(socket);
      return;
    }
    if (method === "thread/read") {
      send(socket, {
        id,
        result: {
          thread: {
            id: state.threadId,
            sessionId: state.sessionId,
            turns: [{
              id: state.turnId,
              status: state.completed ? "completed" : "inProgress",
            }],
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
      send(socket, {
        id,
        result: { turn: { id: state.turnId, status: "inProgress" } },
      });
      send(socket, {
        method: "turn/started",
        params: {
          threadId: state.threadId,
          turn: { id: state.turnId, status: "inProgress" },
        },
      });
      sendPendingTool(socket);
      return;
    }
    send(socket, {
      id,
      error: { code: -32601, message: `unsupported method ${method}` },
    });
  }

  function handle(socket, message) {
    if (message.method) {
      if (message.id !== undefined) handleRequest(socket, message);
      return;
    }
    if (!state.pendingTool || String(message.id) !== state.pendingTool.requestId)
      return;
    const toolResult = message.result;
    state.pendingTool = null;
    state.completed = true;
    save();
    send(socket, {
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
    send(socket, {
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
    send(socket, {
      method: "turn/completed",
      params: {
        threadId: state.threadId,
        turn: { id: state.turnId, status: "completed" },
      },
    });
  }

  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handle(socket, JSON.parse(line));
      }
    });
  });
  server.listen(socketPath);
  process.once("SIGTERM", () => server.close());
} else {
  throw new Error(`unsupported mode ${mode}`);
}
