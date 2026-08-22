import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
  type DurablePrpControlPlane,
} from "../vendor/paperclip-runner/index.js";
import {
  queueRunnerPrpRuntimeRequestResolution,
  registerRunnerPrpAuthority,
  RunnerPrpRuntimeRequestResolutionError,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "./runner-prp-ws.js";

describe("runner PRP websocket route", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("routes the shared connect endpoint to the run-bound authority", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { port: 3210 });
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    const registration = await registerRunnerPrpAuthority({
      runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });
    expect(registration.connectUrl).toBe(`ws://127.0.0.1:3210/api/runner/v1/connect/${runId}`);

    const socket = new PassThrough();
    const request = { url: `/api/runner/v1/connect/${runId}`, headers: {} };
    server.emit("upgrade", request, socket, Buffer.alloc(0));
    expect(request).toMatchObject({ paperclipWebSocketHandled: true });
    expect(handleUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: `/api/runner/v1/connect/${runId}` }),
      socket,
      `/api/runner/v1/connect/${runId}`,
      expect.any(Buffer),
    );

    await registration.release();
    server.close();
  });

  it("fails closed for an unregistered run", () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { port: 3211 });
    const socket = new PassThrough();
    const writes: Buffer[] = [];
    socket.on("data", (chunk) => writes.push(Buffer.from(chunk)));
    server.emit("upgrade", {
      url: "/api/runner/v1/connect/00000000-0000-4000-8000-000000000778",
      headers: {},
    }, socket, Buffer.alloc(0));
    expect(Buffer.concat(writes).toString("utf8")).toContain("404 Not Found");
    server.close();
  });

  it("queues one idempotent, turn-bound runtime request resolution", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { port: 3212 });
    const queueCommand = vi.fn(() => ({ commandId: "command-resolution-1" }));
    const runId = "00000000-0000-4000-8000-000000000780";
    const registration = await registerRunnerPrpAuthority({
      runId,
      authority: { queueCommand } as unknown as DurablePrpControlPlane,
    });
    const input = {
      runId,
      requestId: "request-1",
      turnId: "turn-1",
      resolution: { action: "accept" as const },
    };

    expect(queueRunnerPrpRuntimeRequestResolution(input)).toEqual({ commandId: "command-resolution-1" });
    expect(queueRunnerPrpRuntimeRequestResolution(input)).toEqual({ commandId: "command-resolution-1" });
    expect(queueCommand).toHaveBeenCalledTimes(1);
    expect(queueCommand).toHaveBeenCalledWith("request.resolve", {
      requestId: "request-1",
      turnId: "turn-1",
      resolution: { action: "accept" },
    }, undefined, true);
    expect(() => queueRunnerPrpRuntimeRequestResolution({
      ...input,
      resolution: { action: "decline" },
    })).toThrowError(RunnerPrpRuntimeRequestResolutionError);

    await registration.release();
    expect(() => queueRunnerPrpRuntimeRequestResolution(input)).toThrowError(
      "runner_prp_authority_not_active",
    );
    server.close();
  });

  it("carries an authorized runnerd tool call over the shared Paperclip route", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
    setupRunnerPrpWebSocketServer(server, { port: address.port });
    const runId = "00000000-0000-4000-8000-000000000779";
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: resolve(import.meta.dirname, "../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server"),
      codexArgs: [],
      prpIdentity: {
        runnerInstanceId: "runner-server-route",
        environmentLeaseId: "lease-server-route",
        runId,
        normalizedSessionId: "session-server-route",
        turnId: "turn-server-route",
        itemId: "item-server-route",
      },
      controlPlaneRegistration: (authority) => registerRunnerPrpAuthority({ runId, authority }),
    });
    let toolCalls = 0;
    bundle.transport.setServerRequestHandler(async () => {
      toolCalls += 1;
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ task: { title: "Real route" } }) }],
      };
    });

    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [{
          name: "get_task_context",
          description: "Read the authorized task context.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      });
      await bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "Read the task context." }],
      });
      for await (const notification of bundle.transport.notifications()) {
        if (notification.method === "turn/completed") break;
      }
      expect(toolCalls).toBe(1);
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally {
      await bundle.transport.close();
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});
