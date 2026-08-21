import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";

const CONNECT_PATH_PREFIX = "/api/runner/v1/connect/";

type Registration = {
  authority: DurablePrpControlPlane;
  generation: symbol;
};

const registrations = new Map<string, Registration>();
let loopbackOrigin: string | null = null;

function rejectUpgrade(socket: Duplex, status: 400 | 404 | 409, message: string): void {
  if (socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

export function setupRunnerPrpWebSocketServer(server: Server, options: { port: number }): void {
  loopbackOrigin = `ws://127.0.0.1:${options.port}`;
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://paperclip.invalid");
    if (!url.pathname.startsWith(CONNECT_PATH_PREFIX)) return;
    socket.on("error", (err) => {
      logger.warn({ err }, "runner PRP websocket upgrade socket error");
    });
    const runId = url.pathname.slice(CONNECT_PATH_PREFIX.length);
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const registration = registrations.get(runId);
    if (!registration) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    registration.authority.handleUpgrade(request, socket, url.pathname, head);
  });
}

export async function registerRunnerPrpAuthority(input: {
  runId: string;
  authority: DurablePrpControlPlane;
}): Promise<{ connectUrl: string; release: () => Promise<void> }> {
  if (loopbackOrigin === null) throw new Error("runner_prp_websocket_server_not_configured");
  if (registrations.has(input.runId)) throw new Error("runner_prp_authority_already_registered");
  const generation = Symbol(input.runId);
  registrations.set(input.runId, { authority: input.authority, generation });
  return {
    connectUrl: `${loopbackOrigin}${CONNECT_PATH_PREFIX}${input.runId}`,
    release: async () => {
      if (registrations.get(input.runId)?.generation === generation) registrations.delete(input.runId);
    },
  };
}

export const runnerPrpWebSocketInternals = {
  connectPathPrefix: CONNECT_PATH_PREFIX,
  resetForTests(): void {
    registrations.clear();
    loopbackOrigin = null;
  },
};
