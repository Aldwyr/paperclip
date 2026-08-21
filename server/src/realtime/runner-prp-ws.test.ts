import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import {
  registerRunnerPrpAuthority,
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
    server.emit("upgrade", { url: `/api/runner/v1/connect/${runId}`, headers: {} }, socket, Buffer.alloc(0));
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
});
