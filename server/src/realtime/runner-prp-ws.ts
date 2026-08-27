import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type {
  DurablePrpControlPlane,
  HarnessRuntimeRequestResolution,
} from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";

const CONNECT_PATH_PREFIX = "/api/runner/v1/connect/";

type Registration = {
  authority: DurablePrpControlPlane;
  companyId: string | null;
  generation: symbol;
  runtimeRequestResolutions: Map<string, { fingerprint: string; commandId: string }>;
};

const registrations = new Map<string, Registration>();
let loopbackOrigin: string | null = null;

type IncomingMessageWithUpgradeOwnership = IncomingMessage & {
  paperclipWebSocketHandled?: boolean;
};

function rejectUpgrade(socket: Duplex, status: 400 | 404 | 409, message: string): void {
  if (socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

export function setupRunnerPrpWebSocketServer(
  server: Server,
  options: { port: number } | { apiUrl: string },
): void {
  if ("apiUrl" in options) {
    const apiUrl = new URL(options.apiUrl);
    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
      throw new Error("runner_prp_websocket_api_url_invalid");
    }
    apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    apiUrl.username = "";
    apiUrl.password = "";
    apiUrl.pathname = "";
    apiUrl.search = "";
    apiUrl.hash = "";
    loopbackOrigin = apiUrl.toString().replace(/\/$/, "");
  } else {
    loopbackOrigin = `ws://127.0.0.1:${options.port}`;
  }
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://paperclip.invalid");
    if (!url.pathname.startsWith(CONNECT_PATH_PREFIX)) return;
    (request as IncomingMessageWithUpgradeOwnership).paperclipWebSocketHandled = true;
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
  companyId?: string;
  runId: string;
  authority: DurablePrpControlPlane;
}): Promise<{ connectUrl: string; release: () => Promise<void> }> {
  if (loopbackOrigin === null) throw new Error("runner_prp_websocket_server_not_configured");
  if (registrations.has(input.runId)) throw new Error("runner_prp_authority_already_registered");
  const generation = Symbol(input.runId);
  registrations.set(input.runId, {
    authority: input.authority,
    companyId: input.companyId ?? null,
    generation,
    runtimeRequestResolutions: new Map(),
  });
  return {
    connectUrl: `${loopbackOrigin}${CONNECT_PATH_PREFIX}${input.runId}`,
    release: async () => {
      if (registrations.get(input.runId)?.generation === generation) registrations.delete(input.runId);
    },
  };
}

export class RunnerPrpRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code: "runner_prp_authority_not_active" | "runtime_request_resolution_conflict",
  ) {
    super(code);
    this.name = "RunnerPrpRuntimeRequestResolutionError";
  }
}

/**
 * Queues one turn-bound runtime response on the active durable PRP authority.
 * Replayed identical browser submissions return the original command instead
 * of answering the provider twice; a different answer for the same request
 * fails closed.
 */
export function queueRunnerPrpRuntimeRequestResolution(input: {
  runId: string;
  requestId: string;
  turnId: string;
  resolution: HarnessRuntimeRequestResolution;
}): { commandId: string } {
  const registration = registrations.get(input.runId);
  if (!registration) {
    throw new RunnerPrpRuntimeRequestResolutionError("runner_prp_authority_not_active");
  }
  const fingerprint = JSON.stringify({ turnId: input.turnId, resolution: input.resolution });
  const previous = registration.runtimeRequestResolutions.get(input.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      throw new RunnerPrpRuntimeRequestResolutionError("runtime_request_resolution_conflict");
    }
    return { commandId: previous.commandId };
  }
  const command = registration.authority.queueCommand("request.resolve", {
    requestId: input.requestId,
    turnId: input.turnId,
    resolution: input.resolution,
  }, undefined, true);
  registration.runtimeRequestResolutions.set(input.requestId, {
    fingerprint,
    commandId: command.commandId,
  });
  return { commandId: command.commandId };
}

export const runnerPrpWebSocketInternals = {
  connectPathPrefix: CONNECT_PATH_PREFIX,
  activeRegistration(input: { companyId: string; runId: string }): boolean {
    return registrations.get(input.runId)?.companyId === input.companyId;
  },
  resetForTests(): void {
    registrations.clear();
    loopbackOrigin = null;
  },
};
