import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  getSandboxCallbackBridgeServerSource,
  SANDBOX_CALLBACK_BRIDGE_DUPLEX_MODE,
} from "./sandbox-callback-bridge.js";
import {
  DuplexFrameDecoder,
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DUPLEX_BODY_CHUNK_RAW_BYTES,
  DUPLEX_FRAME_VERSION,
  encodeDuplexFrame,
  type DuplexBodyChunkFrame,
  type DuplexFrame,
  type DuplexReadyFrame,
  type DuplexRequestFrame,
} from "./duplex-frame-codec.js";
import {
  createDuplexBridgeBroker,
  type DuplexBridgeBroker,
  type DuplexBrokerForwardResult,
} from "./duplex-bridge-broker.js";
import type { ReassembledBody } from "./duplex-body-spool.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";

/**
 * Local real-process end-to-end harness for the composed duplex path.
 *
 * The harness spawns the real generated gateway with plain `node` from a
 * temporary file, attaches the real host broker to the child stdin and stdout,
 * and forwards each request to a local fake API server on a real HTTP call. It
 * uses no provider credentials.
 *
 * The child stdio pipes are kernel pipes. They give partial reads, split a
 * multi-byte UTF-8 sequence across two chunks, apply backpressure, and give a
 * true end of file when the child dies. The harness proves the composed path
 * handles each of these real conditions.
 */

/** One recorded call the fake API server received. */
interface FakeApiRequest {
  method: string;
  url: string;
  auth: string | null;
  runId: string | null;
  body: string;
}

/** The responder the fake API server calls for each request. */
type FakeApiResponder = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** The handle for one fake API server. */
interface FakeApiServer {
  origin: string;
  requests: FakeApiRequest[];
  setResponder: (responder: FakeApiResponder) => void;
  /** The count of sockets the server holds open right now. */
  openSocketCount: () => number;
  /** True while the server still accepts connections. */
  listening: () => boolean;
  close: () => Promise<void>;
}

/**
 * Start a local fake API server. The forward handler targets it, so one real
 * HTTP call proves the composed path end to end. The server tracks each open
 * socket, so a test asserts teardown leaves no open socket handle.
 */
async function startFakeApiServer(): Promise<FakeApiServer> {
  const requests: FakeApiRequest[] = [];
  const sockets = new Set<net.Socket>();
  let responder: FakeApiResponder = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId:
          typeof req.headers["x-paperclip-run-id"] === "string"
            ? req.headers["x-paperclip-run-id"]
            : null,
        body,
      });
      responder(req, res, body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The fake API server did not expose a TCP port.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder: (next) => {
      responder = next;
    },
    openSocketCount: () => sockets.size,
    listening: () => server.listening,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy each open socket first. A keep-alive client socket keeps the
        // server open, so `server.close` alone could stall. The destroy makes the
        // close callback fire and drives the open socket count to zero.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The channel view over the spawned child, plus the frames the child sent host-ward. */
interface ChildDuplexChannel {
  channel: CommandManagedDuplexChannel;
  observedFrames: DuplexFrame[];
  stderr: () => string;
}

/**
 * Wrap the spawned child as a {@link CommandManagedDuplexChannel}. The broker
 * writes to the child stdin, reads the child stdout, and learns of the child
 * exit through this channel.
 *
 * The host end reads a byte stream from the stdout pipe. A pipe read can split
 * one multi-byte UTF-8 character across two chunks. The `StringDecoder` holds
 * the bytes of an incomplete character until the next chunk, so the broker only
 * ever reads whole characters. The channel keeps a second decoder for
 * observation only; it lets the harness assert the READY frame and the request
 * frames the child produced, and it never feeds the broker.
 */
function attachChildDuplexChannel(child: ChildProcessWithoutNullStreams): ChildDuplexChannel {
  const observed = new DuplexFrameDecoder();
  const observedFrames: DuplexFrame[] = [];
  const stdoutDecoder = new StringDecoder("utf8");
  let dataListener: ((chunk: string) => void) | null = null;
  let exitListener: ((exit: { exitCode: number | null }) => void) | null = null;
  let pendingText = "";
  let pendingExit: { exitCode: number | null } | null = null;
  let stderrText = "";

  child.stdout.on("data", (buffer: Buffer) => {
    for (const result of observed.push(buffer)) {
      if (result.ok) observedFrames.push(result.frame);
    }
    const text = stdoutDecoder.write(buffer);
    if (text.length === 0) return;
    if (dataListener) dataListener(text);
    else pendingText += text;
  });
  child.stderr.on("data", (buffer: Buffer) => {
    stderrText += buffer.toString("utf8");
  });
  child.on("exit", (code) => {
    const exit = { exitCode: code };
    if (exitListener) exitListener(exit);
    else pendingExit = exit;
  });
  // Swallow a stdin EPIPE. The broker can write one more frame while the child
  // exits; the write fails and the broker records the loss on its own path.
  child.stdin.on("error", () => undefined);

  const channel: CommandManagedDuplexChannel = {
    write: (data) => {
      child.stdin.write(data);
    },
    onData: (listener) => {
      dataListener = listener;
      if (pendingText.length > 0) {
        const replay = pendingText;
        pendingText = "";
        listener(replay);
      }
    },
    onExit: (listener) => {
      exitListener = listener;
      if (pendingExit) {
        const exit = pendingExit;
        pendingExit = null;
        listener(exit);
      }
    },
    stop: () => {
      child.kill("SIGKILL");
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Close the write side. The child stdin reaches end of file, so the
        // gateway sees a real EOF.
        child.stdin.end(() => resolve());
      }),
  };

  return { channel, observedFrames, stderr: () => stderrText };
}

/** The forward-handler mode. `proxy` calls the fake API; `hang` blocks until abort. */
type ForwardMode = "proxy" | "hang";

/** The options for one harness. */
interface HarnessOptions {
  hostApiToken?: string;
  runId?: string;
  maxBodyBytes?: number;
  maxInflightBodyBytes?: number;
  responseTimeoutMs?: number;
  lossExitGraceMs?: number;
}

/** The full harness handle for one composed duplex path. */
interface DuplexE2EHarness {
  baseUrl: string;
  bridgeToken: string;
  hostApiToken: string;
  runId: string;
  nonce: string;
  broker: DuplexBridgeBroker;
  api: FakeApiServer;
  child: ChildProcessWithoutNullStreams;
  observedFrames: DuplexFrame[];
  forwardedRequests: DuplexRequestFrame[];
  setForwardMode: (mode: ForwardMode) => void;
  stderr: () => string;
  killChild: () => Promise<void>;
  waitFor: (predicate: () => boolean, message: string, timeoutMs?: number) => Promise<void>;
  teardown: () => Promise<void>;
}

/** Reserve one free loopback port. The host assigns it to the gateway. */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not reserve a loopback port.")));
        return;
      }
      const reserved = address.port;
      probe.close(() => resolve(reserved));
    });
  });
}

/**
 * Build the composed duplex path: a spawned gateway child, the real broker on
 * the child stdio, and a local fake API server as the forward target.
 */
async function createHarness(options: HarnessOptions = {}): Promise<DuplexE2EHarness> {
  const hostApiToken = options.hostApiToken ?? "real-run-jwt";
  const runId = options.runId ?? "run-e2e";
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const bridgeToken = "duplex-e2e-bridge-token";
  const nonce = "e2e112233445566778899aabbccddeeff";
  let forwardMode: ForwardMode = "proxy";
  const forwardedRequests: DuplexRequestFrame[] = [];

  const api = await startFakeApiServer();
  const assignedPort = await reserveLoopbackPort();

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplex-e2e-"));
  const entrypoint = path.join(tmpDir, "gateway.mjs");
  await writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");

  const child = spawn(process.execPath, [entrypoint], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PAPERCLIP_API_BRIDGE_MODE: SANDBOX_CALLBACK_BRIDGE_DUPLEX_MODE,
      PAPERCLIP_BRIDGE_HOST: "127.0.0.1",
      PAPERCLIP_BRIDGE_PORT: String(assignedPort),
      PAPERCLIP_BRIDGE_NONCE: nonce,
      PAPERCLIP_BRIDGE_TOKEN: bridgeToken,
      PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(maxBodyBytes),
      ...(options.maxInflightBodyBytes != null
        ? { PAPERCLIP_BRIDGE_MAX_INFLIGHT_BODY_BYTES: String(options.maxInflightBodyBytes) }
        : {}),
      ...(options.responseTimeoutMs != null
        ? { PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: String(options.responseTimeoutMs) }
        : {}),
      ...(options.lossExitGraceMs != null
        ? { PAPERCLIP_BRIDGE_LOSS_EXIT_GRACE_MS: String(options.lossExitGraceMs) }
        : {}),
    },
  }) as ChildProcessWithoutNullStreams;

  const { channel, observedFrames, stderr } = attachChildDuplexChannel(child);

  const forwardRequest = async (
    request: DuplexRequestFrame,
    opts: { signal: AbortSignal; body: ReassembledBody },
  ): Promise<DuplexBrokerForwardResult> => {
    forwardedRequests.push(request);
    // Keep the real route allowlist on the forward seam. The broker forwards
    // only an allowed route; it denies any other route with a 403.
    const denial = authorizeSandboxCallbackBridgeRequestWithRoutes(request);
    if (denial) {
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: denial }),
      };
    }
    if (forwardMode === "hang") {
      // Block until the broker aborts the forward. This lets a test hold an
      // outstanding request open while it forces a loss.
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error("The forward call was aborted."));
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    const method = request.method.trim().toUpperCase() || "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value.trim().length === 0) continue;
      headers.set(key, value);
    }
    // Apply the real host token and the run id, the same as the file bridge path.
    headers.set("authorization", `Bearer ${hostApiToken}`);
    headers.set("x-paperclip-run-id", runId);
    const target = new URL(`${request.path}${request.query ?? ""}`, api.origin);
    // Stream the reassembled request body to the host, the same as the real
    // forward. A streamed body needs `duplex: "half"`.
    const forwardInit: RequestInit & { duplex?: "half" } = { method, headers, signal: opts.signal };
    if (method !== "GET" && method !== "HEAD") {
      forwardInit.body = Readable.toWeb(
        opts.body.createReadStream(),
      ) as unknown as ReadableStream<Uint8Array>;
      forwardInit.duplex = "half";
    }
    const response = await fetch(target, forwardInit);
    const body = await response.text();
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return;
      outHeaders[key] = value;
    });
    return { status: response.status, headers: outHeaders, body };
  };

  const broker = await createDuplexBridgeBroker({
    channel,
    forwardRequest,
    logger: () => undefined,
  });
  broker.start();

  const waitFor = async (
    predicate: () => boolean,
    message: string,
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${message}. stderr: ${stderr()}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref?.();
      });
    }
  };

  const waitForExit = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

  const killChild = async (): Promise<void> => {
    child.kill("SIGKILL");
    await waitForExit();
  };

  let torndown = false;
  const teardown = async (): Promise<void> => {
    if (torndown) return;
    torndown = true;
    child.kill("SIGKILL");
    await waitForExit();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await api.close();
    await rm(tmpDir, { recursive: true, force: true });
  };

  return {
    baseUrl: `http://127.0.0.1:${assignedPort}`,
    bridgeToken,
    hostApiToken,
    runId,
    nonce,
    broker,
    api,
    child,
    observedFrames,
    forwardedRequests,
    setForwardMode: (mode) => {
      forwardMode = mode;
    },
    stderr,
    killChild,
    waitFor,
    teardown,
  };
}

/**
 * Build a large body of multi-byte UTF-8 characters. "€" uses three UTF-8 bytes
 * and "😀" uses four. A pipe read boundary at a 65536-byte multiple lands inside
 * a "€" sequence, because 65536 is not a multiple of three. This guarantees a
 * multi-byte character split across two pipe chunks.
 */
function buildMultiByteBody(targetBytes: number): string {
  const marker = "😀-start-😀";
  const filler = "€".repeat(Math.ceil(targetBytes / 3));
  return `${marker}${filler}${marker}`;
}

describe("duplex bridge local end-to-end harness", () => {
  const harnesses: DuplexE2EHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (harness) await harness.teardown();
    }
  });

  const readyPredicate = (harness: DuplexE2EHarness) => () =>
    harness.observedFrames.some((frame) => frame.type === "ready");

  it("delivers a valid READY frame from the spawned gateway child to the attached broker", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.waitFor(readyPredicate(harness), "a READY frame from the gateway child");

    const ready = harness.observedFrames.find(
      (frame) => frame.type === "ready",
    ) as DuplexReadyFrame;
    expect(ready.version).toBe(2);
    expect(ready.nonce).toBe(harness.nonce);
    // READY is liveness only. It carries no address data.
    expect((ready as unknown as Record<string, unknown>).address).toBeUndefined();
    expect((ready as unknown as Record<string, unknown>).port).toBeUndefined();
    // The broker read the READY frame and stayed open with no loss.
    expect(harness.broker.state).toBe("open");
    expect(harness.broker.lossRecord).toBeNull();
  }, 20000);

  it("carries one real HTTP request through the child and the broker to the fake API unchanged", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echoedPath: url.pathname }));
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, echoedPath: "/api/agents/me" });

    // The fake API saw one request with the real host token and the run id. The
    // broker replaced the bridge token, so the fake API never saw it.
    expect(harness.api.requests).toHaveLength(1);
    expect(harness.api.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/agents/me",
      auth: `Bearer ${harness.hostApiToken}`,
      runId: harness.runId,
    });
  }, 20000);

  it("reassembles a large response that spans many pipe chunks", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // The body is larger than the pipe buffer, so the response frame crosses the
    // child stdin pipe in many chunks. An ASCII body isolates the chunk-span
    // behavior from the multi-byte behavior the next test covers.
    const largeBody = "x".repeat(256 * 1024);
    expect(Buffer.byteLength(largeBody, "utf8")).toBeGreaterThan(200 * 1024);
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(largeBody);
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    const received = await response.text();
    // The whole body returns complete after it crossed the pipe in many chunks.
    expect(received.length).toBe(largeBody.length);
    expect(received).toBe(largeBody);
  }, 20000);

  it("decodes a multi-byte UTF-8 sequence split across chunk borders", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    const multiByteBody = buildMultiByteBody(256 * 1024);
    expect(Buffer.byteLength(multiByteBody, "utf8")).toBeGreaterThan(200 * 1024);
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(multiByteBody);
    });

    const response = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(response.status).toBe(200);
    const received = await response.text();
    // A multi-byte character split across a pipe chunk border decodes to the
    // same character, so the whole body returns unchanged.
    expect(received.length).toBe(multiByteBody.length);
    expect(received).toBe(multiByteBody);
  }, 20000);

  it("matches each concurrent request through one child to its own response", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: url.pathname }));
    });

    const ids = Array.from({ length: 8 }, (_unused, index) => `issue-${index}`);
    const responses = await Promise.all(
      ids.map((id) =>
        fetch(`${harness.baseUrl}/api/issues/${id}`, {
          headers: { authorization: `Bearer ${harness.bridgeToken}` },
        }).then(async (response) => ({ status: response.status, body: await response.json() })),
      ),
    );

    responses.forEach((result, index) => {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ path: `/api/issues/${ids[index]}` });
    });
    expect(harness.api.requests).toHaveLength(8);
  }, 20000);

  it("answers 409 to outstanding and 503 to new requests when the broker closes its write side", async () => {
    const harness = await createHarness({ lossExitGraceMs: 3000 });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold the forward open, so the broker sends no response frame. The gateway
    // keeps the request outstanding until the loss.
    harness.setForwardMode("hang");
    const outstanding = fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    void outstanding.catch(() => undefined);
    await harness.waitFor(
      () => harness.forwardedRequests.length >= 1,
      "the broker to receive the forwarded request",
    );

    // The broker closes its write side, so the child stdin reaches a real EOF.
    await harness.broker.close();

    const lossResponse = await outstanding;
    expect(lossResponse.status).toBe(409);
    expect(lossResponse.headers.get("x-paperclip-bridge-outcome")).toBe("indeterminate");
    await expect(lossResponse.json()).resolves.toEqual({ error: "outcome_indeterminate" });

    const afterLoss = await fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    expect(afterLoss.status).toBe(503);
    await expect(afterLoss.json()).resolves.toEqual({ error: "bridge_unavailable" });
  }, 20000);

  it("moves the broker to lost on a child kill, dispatches nothing more, and leaks no handle after teardown", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold one forward open, so a request is in flight when the child dies.
    harness.setForwardMode("hang");
    const outstanding = fetch(`${harness.baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${harness.bridgeToken}` },
    });
    void outstanding.catch(() => undefined);
    await harness.waitFor(
      () => harness.forwardedRequests.length >= 1,
      "the broker to receive the forwarded request",
    );
    const forwardedBeforeKill = harness.forwardedRequests.length;

    // A real process kill closes the stdout pipe and ends the child.
    await harness.killChild();
    await harness.waitFor(
      () => harness.broker.state === "lost",
      "the broker to record the channel loss",
    );
    expect(harness.broker.lossRecord?.reason).toBe("channel_exit");

    // The broker dispatches nothing more after the loss.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref?.();
    });
    expect(harness.forwardedRequests.length).toBe(forwardedBeforeKill);
    // The outstanding fetch fails because the child died before it answered.
    await expect(outstanding).rejects.toThrow();

    await harness.teardown();
    // Teardown left no open pipe or socket handle.
    expect(harness.child.stdin.destroyed).toBe(true);
    expect(harness.child.stdout.destroyed).toBe(true);
    expect(harness.child.stderr.destroyed).toBe(true);
    expect(harness.api.listening()).toBe(false);
    expect(harness.api.openSocketCount()).toBe(0);
  }, 20000);

  it("fails a request with a local 502 when the host sends a malformed response chunk", async () => {
    const RAW = DUPLEX_BODY_CHUNK_RAW_BYTES;
    // Each case declares one malformed body_chunk a broken or hostile host could
    // send. The gateway must reject it at once with a local 502. It must not grow
    // its response reassembly buffer until the response timeout. `bodyByteCount`
    // sets the declared body size on the response envelope. `data` is the base64
    // payload of the one injected chunk.
    const cases: Array<{ name: string; bodyByteCount: number; data: string; error: string }> = [
      { name: "an empty chunk", bodyByteCount: RAW, data: "", error: "duplex response body_chunk is empty" },
      {
        name: "an undersized non-final chunk",
        bodyByteCount: RAW + 8,
        data: Buffer.alloc(4, 1).toString("base64"),
        error: "duplex response body_chunk has the wrong size",
      },
      {
        name: "an oversized chunk",
        bodyByteCount: RAW + 8,
        data: Buffer.alloc(RAW + 4, 1).toString("base64"),
        error: "duplex response body_chunk has the wrong size",
      },
      {
        name: "an overrun past the declared size",
        bodyByteCount: 10,
        data: Buffer.alloc(200, 1).toString("base64"),
        error: "duplex response body overruns the declared size",
      },
      {
        name: "a non-canonical base64 chunk",
        bodyByteCount: 10,
        data: "AB==",
        error: "duplex response body_chunk is not canonical base64",
      },
    ];

    const harness = await createHarness();
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Hold the broker forward open, so only the injected frames answer each
    // request. The gateway reassembles the response body itself, so a raw
    // malformed chunk on its stdin drives the reject path under test.
    harness.setForwardMode("hang");

    for (const testCase of cases) {
      const forwardedBefore = harness.forwardedRequests.length;
      const pendingFetch = fetch(`${harness.baseUrl}/api/agents/me`, {
        headers: { authorization: `Bearer ${harness.bridgeToken}` },
      });
      void pendingFetch.catch(() => undefined);
      await harness.waitFor(
        () => harness.forwardedRequests.length > forwardedBefore,
        `the broker to receive the forwarded request for ${testCase.name}`,
      );
      const id = harness.forwardedRequests[harness.forwardedRequests.length - 1].id;

      // Inject the response envelope, then the one malformed body_chunk, straight
      // to the gateway stdin. This bypasses the broker response encoder, so the
      // gateway sees the exact bytes a broken or hostile host could send.
      harness.child.stdin.write(
        encodeDuplexFrame({
          version: DUPLEX_FRAME_VERSION,
          type: "response",
          id,
          status: 200,
          headers: {},
          bodyByteCount: testCase.bodyByteCount,
          outcome: "completed",
        }),
      );
      harness.child.stdin.write(
        encodeDuplexFrame({
          version: DUPLEX_FRAME_VERSION,
          type: "body_chunk",
          id,
          seq: 0,
          data: testCase.data,
        }),
      );

      const response = await pendingFetch;
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: testCase.error });
    }
  }, 20000);
  it("carries a request body of exactly the API limit through the bridge to the API", async () => {
    // The bridge cap is the API JSON body limit plus one byte. A body of exactly
    // the API limit must pass through the bridge and reach the API. The bridge is
    // a buffering backstop, not the policy limit, so it must not reject an in-spec
    // body one byte early.
    const apiLimitBytes = 10 * 1024 * 1024;
    const bridgeCapBytes = apiLimitBytes + 1;
    const harness = await createHarness({ maxBodyBytes: bridgeCapBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    let receivedBodyLength = -1;
    harness.api.setResponder((_req, res, body) => {
      receivedBodyLength = Buffer.byteLength(body, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const body = "a".repeat(apiLimitBytes);
    expect(Buffer.byteLength(body, "utf8")).toBe(apiLimitBytes);
    const response = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body,
    });
    // The bridge did not reject the body. It reached the API unchanged.
    expect(response.status).toBe(200);
    expect(receivedBodyLength).toBe(apiLimitBytes);
  }, 30000);

  it("answers 413 from the declared length alone, before it reserves or reads any body byte", async () => {
    // Regression test: the body-size overflow path threw a generic Error that
    // unwound to the 502 catch. A 502 is retryable and leaked the internal
    // message. The overflow must answer a clean 413 request_too_large. Assert the
    // status code specifically, because the wrong 502 stood for a long time.
    const maxBodyBytes = 4096;
    const laterBodySize = "small".length;
    // Just enough admission budget for the later small read below (its
    // declared size plus the fixed in-flight frame allowance), with no
    // margin. If the gateway reserved the oversize request's declared length
    // before it rejected the request, this budget would stay exhausted and
    // the later request would be shed with a 503 instead of admitted.
    const maxInflightBodyBytes = laterBodySize + DEFAULT_MAX_DUPLEX_FRAME_BYTES;
    const harness = await createHarness({ maxBodyBytes, maxInflightBodyBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    let apiWasCalled = false;
    harness.api.setResponder((_req, res) => {
      apiWasCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const body = "a".repeat(maxBodyBytes + 1024);
    const response = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_too_large" });
    // The oversize body never reached the API, and the response leaked no
    // internal message.
    expect(apiWasCalled).toBe(false);

    // The rejected request reserved nothing, so a small request right after
    // is still admitted -- proving the gateway answered the 413 from the
    // declared length header alone, before it ever reserved or read a byte.
    const later = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(later.status).toBe(200);
    expect(apiWasCalled).toBe(true);
  }, 20000);

  it("reserves the worst case and answers 413 for a chunked request with no declared length that overruns the cap", async () => {
    // A request with no Content-Length header -- for example a chunked
    // request -- gives the gateway no declared size ahead of time. The
    // gateway must fall back to the worst case (maxBodyBytes) for its
    // reserve, and it must still answer a clean 413 once the body it
    // actually reads exceeds the cap.
    const maxBodyBytes = 4096;
    const harness = await createHarness({ maxBodyBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    let apiWasCalled = false;
    harness.api.setResponder((_req, res) => {
      apiWasCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const oversizeBody = "a".repeat(maxBodyBytes + 1024);
    // A ReadableStream body sends with chunked transfer-encoding and no
    // Content-Length header, so the gateway cannot know the real size ahead
    // of time.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversizeBody));
        controller.close();
      },
    });
    const response = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_too_large" });
    expect(apiWasCalled).toBe(false);

    // The rejected read released its reserve, so a later request is admitted
    // again and reaches the API.
    const later = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(later.status).toBe(200);
  }, 20000);

  it("charges a bodyless DELETE the zero-length reserve, not the worst-case maxBodyBytes charge", async () => {
    // Regression coverage for PAP-5046. A DELETE with no body sends neither a
    // Content-Length header nor a Transfer-Encoding header. Before the fix,
    // declaredBodyBytes returned null for that shape and the gateway charged
    // the worst-case maxBodyBytes reserve, the same charge as an unknown-size
    // chunked body. This pins maxInflightBodyBytes to fit the zero-length
    // charge (0 + DEFAULT_MAX_DUPLEX_FRAME_BYTES) but not the worst-case
    // charge (maxBodyBytes + DEFAULT_MAX_DUPLEX_FRAME_BYTES), so only the
    // fixed classification admits the request.
    const maxBodyBytes = 4096;
    const maxInflightBodyBytes = DEFAULT_MAX_DUPLEX_FRAME_BYTES;
    const harness = await createHarness({ maxBodyBytes, maxInflightBodyBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    let apiWasCalled = false;
    harness.api.setResponder((_req, res) => {
      apiWasCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    // /api/routine-triggers/{id} is the one DELETE route the host allowlist
    // admits; a DELETE elsewhere gets a 403 before it reaches the API,
    // regardless of this fix, so this path isolates the admission charge.
    const response = await fetch(`${harness.baseUrl}/api/routine-triggers/t-1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${harness.bridgeToken}`, "content-type": "application/json" },
    });
    expect(response.status).not.toBe(503);
    expect(apiWasCalled).toBe(true);
  }, 20000);

  it("admits many small concurrent requests that the old flat 10 MiB charge would have shed with 503", async () => {
    // Production constants. Under the old flat charge every active read
    // reserved maxBodyBytes (about 10 MiB) regardless of the real body size,
    // so the 64 MiB inflight bound admitted at most
    // floor(64 MiB / (10 MiB + 1)) = 6 concurrent reads. Charging the
    // declared body size instead means a control-plane-sized body reserves
    // only its own few hundred bytes plus the fixed frame allowance, so the
    // same bound admits far more than 6 concurrent small reads at once.
    const maxBodyBytes = 10 * 1024 * 1024 + 1;
    const maxInflightBodyBytes = 64 * 1024 * 1024;
    const concurrency = 20;
    const harness = await createHarness({ maxBodyBytes, maxInflightBodyBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const body = JSON.stringify({ body: "a small status comment" });
    const post = () =>
      fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bridgeToken}`,
          "content-type": "application/json",
        },
        body,
      });
    const responses = await Promise.all(Array.from({ length: concurrency }, () => post()));
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: concurrency }, () => 200),
    );
  }, 20000);

  it("sheds a concurrent body read past the admission bound, then releases the reserve", async () => {
    // The gateway reserves the declared body size plus the fixed in-flight
    // frame allowance for each active read against the local admission
    // bound. With the bound set to exactly one such reserve, the first read
    // is admitted and the second read is shed with a 503. The gateway
    // releases the reserve on the response timeout, so a later request is
    // admitted again.
    const maxBodyBytes = 4096;
    const bodySize = 1024;
    const reservePerRead = bodySize + DEFAULT_MAX_DUPLEX_FRAME_BYTES;
    const harness = await createHarness({
      maxBodyBytes,
      // The bound admits exactly one concurrent body read at bodySize.
      maxInflightBodyBytes: reservePerRead,
      // A short response deadline releases the first (hung) read fast.
      responseTimeoutMs: 700,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // The first admitted request hangs on the forward until it times out. The
    // second request cannot reserve, so the gateway sheds it with a 503.
    harness.setForwardMode("hang");
    const body = "a".repeat(bodySize);
    const post = () =>
      fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bridgeToken}`,
          "content-type": "application/json",
        },
        body,
      });
    const [first, second] = await Promise.all([post(), post()]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    // One request was admitted (it later times out with a 502). One request was
    // shed with a 503 before it could buffer a second body.
    expect(statuses).toEqual([502, 503]);
    const shed = first.status === 503 ? first : second;
    await expect(shed.json()).resolves.toEqual({ error: "bridge_busy" });

    // The admitted read timed out and released its reserve. A later request is
    // admitted again and reaches the API.
    harness.setForwardMode("proxy");
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const later = await post();
    expect(later.status).toBe(200);
  }, 20000);

  it("forwards a cap-sized malformed-UTF-8 body byte-for-byte and emits no expanded frame", async () => {
    // Regression test for the admission-bypass block. The gateway used to decode
    // the raw body to a UTF-8 string, then re-encode it. Each invalid byte
    // became the three-byte U+FFFD replacement, so a cap-sized malformed body
    // expanded to about three times the bytes that admission charged. The gateway
    // now preserves the raw bytes, so the body rides base64 frames unchanged and
    // no frame carries more than the charged bytes.
    const maxBodyBytes = 700 * 1024;
    const harness = await createHarness({ maxBodyBytes });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    // 0xFF is never a valid UTF-8 byte. A cap-sized body of 0xFF bytes is the
    // worst case for the old expansion path.
    const malformed = Buffer.alloc(maxBodyBytes, 0xff);
    const response = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: new Uint8Array(malformed),
    });
    expect(response.status).toBe(200);

    // The observed frames are the exact bytes the gateway sent to the host. The
    // envelope reports the raw byte count, not an expanded count.
    const requestFrame = harness.observedFrames.find(
      (frame): frame is DuplexRequestFrame => frame.type === "request",
    );
    expect(requestFrame?.bodyByteCount).toBe(maxBodyBytes);

    // The body_chunk frames decode to the exact source bytes. No frame carried an
    // expanded body, so no body larger than the charged bytes reached the host.
    const bodyChunks = harness.observedFrames.filter(
      (frame): frame is DuplexBodyChunkFrame => frame.type === "body_chunk",
    );
    const reassembled = Buffer.concat(
      bodyChunks.map((frame) => Buffer.from(frame.data, "base64")),
    );
    expect(reassembled.length).toBe(maxBodyBytes);
    expect(reassembled.equals(malformed)).toBe(true);

    // The route stays usable after the malformed body.
    const later = await fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });
    expect(later.status).toBe(200);
  }, 30000);

  it("caps concurrent body reads at the retained-byte model, then releases the reserve", async () => {
    // Production-size accounting. The gateway charges each active read the
    // declared body size plus the fixed in-flight frame allowance, not the
    // flat body cap, so the bound admits
    // floor(inflightBound / (declaredBytes + frameAllowance)) reads. The
    // declared body here is well under the cap, so this model admits far
    // more than the old flat-charge model's 6 -- but the test still keeps
    // the count under the gateway's separate maxQueueDepth bound (64), so
    // that unrelated queue-depth gate does not also shed a request and
    // confound the assertions below.
    const maxBodyBytes = 10 * 1024 * 1024 + 1;
    const maxInflightBodyBytes = 64 * 1024 * 1024;
    const bodySize = 1024 * 1024;
    const reservePerRead = bodySize + DEFAULT_MAX_DUPLEX_FRAME_BYTES;
    const admitCount = Math.floor(maxInflightBodyBytes / reservePerRead);
    expect(admitCount).toBe(32);
    const harness = await createHarness({
      maxBodyBytes,
      maxInflightBodyBytes,
      // A short response deadline releases each hung read fast.
      responseTimeoutMs: 800,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Each admitted read hangs on the forward until it times out, so all admitted
    // reads hold their reserve at once and the next read cannot reserve.
    harness.setForwardMode("hang");
    const body = "a".repeat(bodySize);
    const post = () =>
      fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bridgeToken}`,
          "content-type": "application/json",
        },
        body,
      });
    const responses = await Promise.all(
      Array.from({ length: admitCount + 1 }, () => post()),
    );
    const statuses = responses.map((response) => response.status);
    // The model admits exactly admitCount reads. Each admitted read times out
    // with a 502. The one read past the model is shed with a 503 before it
    // buffers a body.
    const shedCount = statuses.filter((status) => status === 503).length;
    const admittedTimedOut = statuses.filter((status) => status === 502).length;
    expect(shedCount).toBe(1);
    expect(admittedTimedOut).toBe(admitCount);
    const shed = responses.find((response) => response.status === 503);
    await expect(shed?.json()).resolves.toEqual({ error: "bridge_busy" });

    // The admitted reads released their reserve on timeout. A later request is
    // admitted again and reaches the API.
    harness.setForwardMode("proxy");
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const later = await post();
    expect(later.status).toBe(200);
  }, 30000);

  it("bounds the outbound writer to about one frame per active send while the pipe backpressures", async () => {
    // Regression test for the backpressure block. The gateway used to call
    // stdout.write() for every frame in a tight loop and ignore the return
    // value, so a slow reader let one admitted read queue its whole body's
    // worth of encoded frames. Pause the pipe read side, so every later write
    // meets a full pipe, then post several concurrent cap-sized bodies at
    // once and prove the writer never reports more than about one bounded
    // frame stuck behind the full pipe.
    const maxBodyBytes = 4 * 1024 * 1024;
    const concurrency = 4;
    const harness = await createHarness({
      maxBodyBytes,
      // Each concurrent read charges its declared body size plus the fixed
      // in-flight frame allowance, so the bound must admit all four at once.
      maxInflightBodyBytes: (maxBodyBytes + DEFAULT_MAX_DUPLEX_FRAME_BYTES) * concurrency,
      responseTimeoutMs: 20000,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Stop reading the child's stdout, so the OS pipe fills and the gateway's
    // writes meet real backpressure, the same as a slow host reader would
    // cause in production.
    harness.child.stdout.pause();

    const body = "a".repeat(maxBodyBytes);
    const posts = Array.from({ length: concurrency }, (_unused, index) =>
      fetch(`${harness.baseUrl}/api/issues/issue-${index}/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bridgeToken}`,
          "content-type": "application/json",
        },
        body,
      }).catch(() => undefined),
    );

    // Give the gateway time to read every body and drive its sends into
    // backpressure.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const backpressureLines = harness
      .stderr()
      .split("\n")
      .filter((line) => line.includes("stdout frame write backpressured"));
    expect(backpressureLines.length).toBeGreaterThan(0);
    const reportedLengths = backpressureLines.map((line) => {
      const match = /writableLength=(\d+)/.exec(line);
      if (!match) throw new Error("backpressure diagnostic is missing writableLength: " + line);
      return Number(match[1]);
    });
    // One buffered frame is at most DEFAULT_MAX_DUPLEX_FRAME_BYTES (1 MB). An
    // unbounded queue would report a writableLength close to one whole body's
    // worth of encoded frames -- several megabytes for a 4 MiB body. A
    // generous multiple of one frame proves the writer never queued anywhere
    // near that, regardless of how long the pipe stays full.
    const oneFrameBound = DEFAULT_MAX_DUPLEX_FRAME_BYTES * 2;
    for (const length of reportedLengths) {
      expect(length).toBeLessThan(oneFrameBound);
    }

    // Resume so the harness can read the outstanding frames and tear down
    // cleanly.
    harness.child.stdout.resume();
    await Promise.allSettled(posts);
  }, 20000);

  it("keeps one request's frames in sequence while a concurrent request interleaves its own", async () => {
    const harness = await createHarness({
      maxBodyBytes: 2 * 1024 * 1024,
      maxInflightBodyBytes: 8 * 1024 * 1024,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    // Each body is large enough to split into several body_chunk frames, so a
    // correct sequence is not a coincidence of a one-frame body.
    const bodyA = "a".repeat(1_500_000);
    const bodyB = "b".repeat(1_500_000);
    const post = (body: string) =>
      fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.bridgeToken}`,
          "content-type": "application/json",
        },
        body,
      });

    const [responseA, responseB] = await Promise.all([post(bodyA), post(bodyB)]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    const requestFrames = harness.observedFrames.filter(
      (frame): frame is DuplexRequestFrame => frame.type === "request",
    );
    expect(requestFrames).toHaveLength(2);
    for (const requestFrame of requestFrames) {
      const chunkSeqs = harness.observedFrames
        .filter(
          (frame): frame is DuplexBodyChunkFrame =>
            frame.type === "body_chunk" && frame.id === requestFrame.id,
        )
        .map((frame) => frame.seq);
      expect(chunkSeqs.length).toBeGreaterThan(1);
      // This request's own chunks arrive in increasing sequence order, even
      // though the other request's frames may interleave between them.
      expect(chunkSeqs).toEqual(Array.from({ length: chunkSeqs.length }, (_unused, index) => index));
    }
  }, 20000);

  it("holds the admission reserve while a send is stalled behind a full pipe, then releases it once the send drains", async () => {
    const maxBodyBytes = 2 * 1024 * 1024;
    const harness = await createHarness({
      maxBodyBytes,
      // Admits exactly one concurrent body read at maxBodyBytes: the declared
      // body size plus the fixed in-flight frame allowance.
      maxInflightBodyBytes: maxBodyBytes + DEFAULT_MAX_DUPLEX_FRAME_BYTES,
      responseTimeoutMs: 15000,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");
    harness.setForwardMode("hang");

    // Stop reading the child's stdout, so the first request's send stalls
    // mid-flight, well before it ever reaches the host.
    harness.child.stdout.pause();

    const body = "a".repeat(maxBodyBytes);
    const first = fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body,
    });
    void first.catch(() => undefined);

    // Give the gateway time to read the body and drive its send into
    // backpressure.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The reserve is still held: a second request cannot reserve, so the
    // gateway sheds it with a clean 503.
    const shed = await fetch(`${harness.baseUrl}/api/issues/issue-2/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(shed.status).toBe(503);
    await expect(shed.json()).resolves.toEqual({ error: "bridge_busy" });

    // Resume the pipe and let the host answer. The stalled send drains and
    // finishes, and the first request's response settles.
    harness.child.stdout.resume();
    harness.setForwardMode("proxy");
    harness.api.setResponder((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);

    // The reserve released once the send finished. A later request is
    // admitted again.
    const later = await fetch(`${harness.baseUrl}/api/issues/issue-3/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(later.status).toBe(200);
  }, 20000);

  it("ends a stalled send when the outbound pipe breaks, and releases the reserve for a later request", async () => {
    const maxBodyBytes = 2 * 1024 * 1024;
    const harness = await createHarness({
      maxBodyBytes,
      // Admits exactly one concurrent body read at maxBodyBytes: the declared
      // body size plus the fixed in-flight frame allowance.
      maxInflightBodyBytes: maxBodyBytes + DEFAULT_MAX_DUPLEX_FRAME_BYTES,
      responseTimeoutMs: 1200,
    });
    harnesses.push(harness);
    await harness.waitFor(readyPredicate(harness), "the gateway to become ready");

    // Stop reading the child's stdout, so the first request's send is
    // genuinely in flight -- stalled behind a full pipe -- when the pipe
    // breaks.
    harness.child.stdout.pause();

    const body = "a".repeat(maxBodyBytes);
    const first = fetch(`${harness.baseUrl}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body,
    });
    void first.catch(() => undefined);

    // Give the gateway time to read the body and start writing frames into
    // the full pipe.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Confirm the reserve is held before the pipe breaks: a second request
    // cannot reserve, so the gateway sheds it with a clean 503.
    const shedBeforeBreak = await fetch(`${harness.baseUrl}/api/issues/issue-2/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(shedBeforeBreak.status).toBe(503);

    // Break the pipe. The stalled write meets a stream error, which ends the
    // wait for drain -- the only other end condition the writer accepts.
    harness.child.stdout.destroy();

    const firstResponse = await first;
    // No response frame can ever arrive over a broken pipe. The gateway's own
    // wait budget ends the request with its local 502 timeout.
    expect(firstResponse.status).toBe(502);

    // The reserve released once the failed send and the timed-out response
    // both finished. A later request is admitted again -- it is not shed with
    // 503, even though it can never complete over the broken pipe either.
    const later = await fetch(`${harness.baseUrl}/api/issues/issue-3/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.bridgeToken}`,
        "content-type": "application/json",
      },
      body: "small",
    });
    expect(later.status).toBe(502);
  }, 20000);
});
