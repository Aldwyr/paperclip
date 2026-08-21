#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.OPENROUTER_API_KEY) process.stderr.write(`fixture credential=${process.env.OPENROUTER_API_KEY}\n`);
const port = Number(args[args.indexOf("--port") + 1]);
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const session = { id: "ses_fake_1", title: "Paperclip fake" };
const clients = new Set();
let eventConnections = 0;
const runtimeConfig = JSON.parse(await readFile(join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
const mcp = runtimeConfig.mcp?.paperclip;
let mcpRequestId = 1;
const mcpEvidence = { tools: [], calls: [] };

await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
await writeFile(join(process.env.XDG_DATA_HOME, "fake-environment.json"), JSON.stringify({
  keys: Object.keys(process.env).sort(),
  home: process.env.HOME,
  configHome: process.env.XDG_CONFIG_HOME,
  projectConfigDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
}));

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function emit(value) {
  const frame = `data: ${JSON.stringify(value)}\n\n`;
  for (const response of clients) response.write(frame);
}

async function mcpRequest(method, params) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { ...mcp.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: mcpRequestId++, method, ...(params ? { params } : {}) }),
  });
  return response.json();
}

async function callFirstPaperclipTool() {
  if (!mcp?.url) return;
  await mcpRequest("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-opencode", version: "1" } });
  const listed = await mcpRequest("tools/list");
  mcpEvidence.tools = (listed.result?.tools ?? []).map((entry) => entry.name);
  const tool = listed.result?.tools?.find((entry) =>
    !["paperclip_finish", "paperclip_block"].includes(entry.name)
    && (entry.inputSchema?.required?.length ?? 0) === 0
  );
  if (tool) mcpEvidence.calls.push(await mcpRequest("tools/call", { name: `paperclip_${tool.name}`, arguments: {} }));
  await writeFile(join(process.env.XDG_DATA_HOME, "fake-mcp-evidence.json"), JSON.stringify(mcpEvidence));
}

async function callTerminalTool(promptBody) {
  const prompt = JSON.parse(promptBody.parts?.[0]?.text ?? "{}");
  const blocked = String(prompt.message ?? "").includes("block-result");
  const result = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: blocked ? "blocked" : "done",
    summary: blocked ? "Fake provider is blocked." : "Fake provider completed the task.",
    completionClaim: {
      contractRevision: prompt.task?.completionContract?.revision ?? "codex-demo-v1",
      objectiveSatisfied: !blocked,
      criteria: (prompt.task?.completionContract?.criteria ?? []).map((criterion) => ({
        criterionId: criterion.id,
        status: blocked ? "unknown" : "satisfied",
        evidenceRefs: [],
      })),
      remainingWork: blocked ? [{ description: "Waiting on a test dependency.", blocksCompletion: true }] : [],
    },
    evidence: [],
    verification: [],
    attentionRequests: blocked ? [{ kind: "blocker", summary: "Waiting on a test dependency." }] : [],
    artifacts: [],
    ...(blocked ? { blocker: {
      reasonCode: "test_dependency",
      owner: { kind: "external", name: "fixture" },
      unblockAction: "Release the fixture dependency.",
      scope: "current_track",
    } } : {}),
  };
  return mcpRequest("tools/call", {
    name: blocked ? "paperclip_block" : "paperclip_finish",
    arguments: result,
  });
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== expectedAuth) return json(response, 401, { error: "unauthorized" });
  if (request.url === "/global/health") return json(response, 200, { healthy: true, version: "1.18.17" });
  if (request.url === "/event") {
    eventConnections += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    if (eventConnections === 1) {
      response.end();
      return;
    }
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && request.url === "/session") return json(response, 200, session);
  if (request.method === "GET" && request.url === `/session/${session.id}`) return json(response, 200, session);
  if (request.method === "GET" && request.url === `/session/${session.id}/message`) return json(response, 200, []);
  if (request.method === "GET" && request.url === "/session/status") return json(response, 200, { [session.id]: { type: "idle" } });
  if (request.method === "POST" && request.url === `/session/${session.id}/abort`) return json(response, 200, true);
  if (request.method === "POST" && request.url === `/session/${session.id}/prompt_async`) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const promptPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (promptPayload.providerID !== "openrouter" || promptPayload.modelID !== "deepseek/deepseek-v4-flash-0731" || "model" in promptPayload) {
        return json(response, 400, { error: "OpenCode 1.18 prompt model fields must be top-level" });
      }
      json(response, 204, null);
      setTimeout(async () => {
        await callFirstPaperclipTool();
        await callTerminalTool(promptPayload);
        emit({ type: "message.updated", id: "event-user", properties: { sessionID: session.id, info: { id: "message-user", sessionID: session.id, role: "user" } } });
        emit({ type: "message.part.updated", id: "event-user-part", properties: { sessionID: session.id, part: { id: "part-user", messageID: "message-user", type: "text", text: "submitted prompt must not become assistant text" } } });
        emit({ type: "message.updated", id: "event-assistant", properties: { sessionID: session.id, info: { id: "message-assistant", sessionID: session.id, role: "assistant" } } });
        emit({ type: "message.part.updated", id: "event-patch", properties: { sessionID: session.id, part: { id: "part-patch", messageID: "message-assistant", type: "patch", files: ["src/index.ts"] } } });
        emit({ type: "message.part.updated", id: "event-1", properties: { sessionID: session.id, part: { id: "part-1", messageID: "message-assistant", type: "text", text: "done [guide](guide.md)" } } });
        emit({ type: "message.part.updated", id: "event-1", properties: { sessionID: session.id, part: { id: "part-1", messageID: "message-assistant", type: "text", text: "done" } } });
        emit({ type: "message.updated", id: "event-2", properties: { info: { sessionID: session.id, tokens: { input: 3, output: 2 }, cost: 0.001 } } });
        emit({ type: "session.idle", id: "event-3", properties: { sessionID: session.id } });
      }, 100);
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
