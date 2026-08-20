/**
 * Host broker for the sandbox duplex channel.
 *
 * The broker owns the host end of one persistent duplex channel to the sandbox
 * gateway. It reads request frames from the channel, forwards each one on the
 * existing Paperclip API path, and writes one response frame back. It sends a
 * heartbeat frame on an interval to prove liveness.
 *
 * The broker does not hold the route allowlist, the token replacement, or the
 * run attribution. The caller passes a forward handler, and the broker calls it
 * for each request. The handler applies the real token and the signed run
 * identifier, so those rules stay in one place on the existing forward path.
 *
 * The broker runs a set of nested timeout budgets:
 *   - forward budget: the deadline for one forward call.
 *   - response budget: the deadline for the broker to send one response frame.
 *   - gateway wait budget: the deadline the in-sandbox gateway waits for the
 *     response frame.
 * Each inner budget is smaller than its outer budget, so the broker aborts and
 * answers before the gateway gives up. The broker asserts this order at
 * construction and fails a configuration that breaks it.
 *
 * Loss is terminal. The broker detects loss through channel exit, a stream
 * write failure, a protocol failure, a heartbeat write failure, and a close
 * timeout. On loss the broker stops the heartbeat, aborts every in-flight
 * forward, records the loss, and dispatches nothing more. The broker never
 * reconnects and never replays a request. The broker records the loss for
 * metrics only and sends nothing about the loss to the sandbox.
 */

import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import {
  DUPLEX_FRAME_VERSION,
  DuplexFrameDecoder,
  encodeDuplexFrame,
  type DuplexFrame,
  type DuplexRequestFrame,
  type DuplexResponseFrame,
  type DuplexResponseOutcome,
} from "./duplex-frame-codec.js";

/** The lifecycle states of the broker. The broker moves through them in order. */
export type DuplexBrokerState = "opening" | "open" | "lost" | "closing" | "closed";

/** The reason the broker classified a loss. The broker records it for metrics only. */
export type DuplexBrokerLossReason =
  | "channel_exit"
  | "stream_failure"
  | "protocol_failure"
  | "heartbeat_write_failure"
  | "close_timeout";

/** The nested timeout budgets. Each inner budget is smaller than its outer budget. */
export interface DuplexBrokerBudgets {
  /** The deadline for one forward call, in milliseconds. */
  forwardTimeoutMs: number;
  /** The deadline for the broker to send one response frame, in milliseconds. */
  responseBudgetMs: number;
  /** The deadline the in-sandbox gateway waits for the response frame, in milliseconds. */
  gatewayWaitMs: number;
}

/** The default nested budgets: forward 30 s, response 32 s, gateway wait 35 s. */
export const DEFAULT_DUPLEX_BROKER_BUDGETS: DuplexBrokerBudgets = {
  forwardTimeoutMs: 30_000,
  responseBudgetMs: 32_000,
  gatewayWaitMs: 35_000,
};

/** The default interval between two heartbeat frames, in milliseconds. */
export const DEFAULT_DUPLEX_BROKER_HEARTBEAT_INTERVAL_MS = 5_000;

/** The default deadline for an orderly channel close, in milliseconds. */
export const DEFAULT_DUPLEX_BROKER_CLOSE_TIMEOUT_MS = 2_000;

/** The result of one forward call. The broker turns it into one response frame. */
export interface DuplexBrokerForwardResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The forward handler the broker calls for each request. The handler applies the
 * real token and the run attribution, then forwards the request on the existing
 * API path. The broker aborts `options.signal` when the forward budget ends or a
 * loss happens, so a handler that threads the signal into its work stops early.
 */
export type DuplexBrokerForwardHandler = (
  request: DuplexRequestFrame,
  options: { signal: AbortSignal },
) => Promise<DuplexBrokerForwardResult>;

/** One request record. The broker captures the dispatch-start point for metrics only. */
export interface DuplexBrokerRequestRecord {
  id: string;
  method: string;
  path: string;
  /** The point the broker started to dispatch the request, in milliseconds. */
  dispatchStartMs: number;
}

/** One loss record. The broker reports it for metrics only. */
export interface DuplexBrokerLossRecord {
  reason: DuplexBrokerLossReason;
  message: string;
  /** The point the broker recorded the loss, in milliseconds. */
  atMs: number;
}

/** The options for {@link createDuplexBridgeBroker}. */
export interface DuplexBrokerOptions {
  /** The duplex channel to the sandbox gateway. */
  channel: CommandManagedDuplexChannel;
  /** The forward handler the broker calls for each request. */
  forwardRequest: DuplexBrokerForwardHandler;
  /** The nested timeout budgets. The default is {@link DEFAULT_DUPLEX_BROKER_BUDGETS}. */
  budgets?: Partial<DuplexBrokerBudgets>;
  /** The interval between two heartbeat frames, in milliseconds. */
  heartbeatIntervalMs?: number;
  /** The deadline for an orderly channel close, in milliseconds. */
  closeTimeoutMs?: number;
  /** The maximum size of one inbound frame, in bytes. Forwarded to the decoder. */
  maxFrameBytes?: number;
  /** The clock the broker reads for the metric timestamps. The default is `Date.now`. */
  now?: () => number;
  /** The metrics sink for the per-request dispatch record. */
  onRequestRecord?: (record: DuplexBrokerRequestRecord) => void;
  /** The metrics sink for the terminal loss record. */
  onLoss?: (record: DuplexBrokerLossRecord) => void;
  /** The sink for a state change. The broker reports every transition. */
  onStateChange?: (state: DuplexBrokerState) => void;
  /** The sink for a diagnostic message. The broker never writes diagnostics to the channel. */
  logger?: (message: string) => void;
}

/** The broker handle the factory returns. */
export interface DuplexBridgeBroker {
  /** The current state of the broker. */
  readonly state: DuplexBrokerState;
  /** The loss record, or `null` when the broker never lost the channel. */
  readonly lossRecord: DuplexBrokerLossRecord | null;
  /** Start the broker. It wires the channel listeners and moves to `open`. */
  start(): void;
  /** Close the channel cleanly. It moves through `closing` to `closed`. */
  close(): Promise<void>;
  /** Stop the sandbox child process. Safe to call more than one time. */
  stop(): void;
}

/**
 * Assert the nested budget order. Each inner budget must be smaller than its
 * outer budget, so the broker answers before the gateway gives up. The function
 * throws when the order breaks.
 */
export function assertNestedDuplexBrokerBudgets(budgets: DuplexBrokerBudgets): void {
  if (!(budgets.forwardTimeoutMs < budgets.responseBudgetMs)) {
    throw new Error(
      `Duplex broker forward budget ${budgets.forwardTimeoutMs}ms must be smaller than the response budget ${budgets.responseBudgetMs}ms.`,
    );
  }
  if (!(budgets.responseBudgetMs < budgets.gatewayWaitMs)) {
    throw new Error(
      `Duplex broker response budget ${budgets.responseBudgetMs}ms must be smaller than the gateway wait budget ${budgets.gatewayWaitMs}ms.`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The internal bookkeeping for one in-flight request. */
interface PendingRequest {
  controller: AbortController;
  responded: boolean;
  forwardTimer: ReturnType<typeof setTimeout>;
  responseTimer: ReturnType<typeof setTimeout>;
}

/**
 * Create the host duplex bridge broker. The factory asserts the budget order and
 * returns a handle. Call `start` to wire the channel and open the broker.
 */
export function createDuplexBridgeBroker(options: DuplexBrokerOptions): DuplexBridgeBroker {
  const budgets: DuplexBrokerBudgets = {
    ...DEFAULT_DUPLEX_BROKER_BUDGETS,
    ...options.budgets,
  };
  assertNestedDuplexBrokerBudgets(budgets);

  const channel = options.channel;
  const forwardRequest = options.forwardRequest;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_DUPLEX_BROKER_HEARTBEAT_INTERVAL_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_DUPLEX_BROKER_CLOSE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const decoder = new DuplexFrameDecoder(
    options.maxFrameBytes ? { maxFrameBytes: options.maxFrameBytes } : undefined,
  );

  let state: DuplexBrokerState = "opening";
  let stopped = false;
  let started = false;
  let closePromise: Promise<void> | null = null;
  let lossRecord: DuplexBrokerLossRecord | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // The ids the broker already dispatched. The broker forwards one id one time,
  // so a repeated frame never reaches the API twice.
  const seenRequestIds = new Set<string>();
  const pending = new Map<string, PendingRequest>();

  const setState = (next: DuplexBrokerState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearPending = (): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.forwardTimer);
      clearTimeout(entry.responseTimer);
      entry.controller.abort(new Error("Duplex broker stopped."));
    }
    pending.clear();
  };

  const recordLoss = (reason: DuplexBrokerLossReason, message: string): void => {
    // Loss is terminal. Record it one time and stop every activity.
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    clearPending();
    lossRecord = { reason, message, atMs: now() };
    setState("lost");
    options.logger?.(`Duplex broker lost the channel (${reason}): ${message}`);
    options.onLoss?.(lossRecord);
  };

  const writeFrame = (frame: DuplexFrame): boolean => {
    try {
      channel.write(encodeDuplexFrame(frame));
      return true;
    } catch (error) {
      recordLoss("stream_failure", errorMessage(error));
      return false;
    }
  };

  const respond = (
    id: string,
    result: DuplexBrokerForwardResult,
    outcome: DuplexResponseOutcome,
  ): void => {
    const entry = pending.get(id);
    if (!entry || entry.responded) return;
    entry.responded = true;
    clearTimeout(entry.forwardTimer);
    clearTimeout(entry.responseTimer);
    pending.delete(id);
    // Do not write on a lost or closed channel. The gateway answers its own
    // outstanding request on loss, so a late write would go to a dead channel.
    if (state !== "open") return;
    const frame: DuplexResponseFrame = {
      version: DUPLEX_FRAME_VERSION,
      type: "response",
      id,
      status: result.status,
      headers: result.headers ?? {},
      body: result.body ?? "",
      outcome,
    };
    writeFrame(frame);
  };

  const dispatch = (frame: DuplexRequestFrame): void => {
    // Dispatch only while open. After loss or close the broker forwards nothing.
    if (state !== "open") return;
    // Forward one id one time. A repeated id never reaches the API twice.
    if (seenRequestIds.has(frame.id)) return;
    seenRequestIds.add(frame.id);

    const record: DuplexBrokerRequestRecord = {
      id: frame.id,
      method: frame.method,
      path: frame.path,
      dispatchStartMs: now(),
    };
    options.onRequestRecord?.(record);

    const controller = new AbortController();
    const forwardTimer = setTimeout(() => {
      controller.abort(new Error("Duplex broker forward budget exceeded."));
    }, budgets.forwardTimeoutMs);
    const responseTimer = setTimeout(() => {
      // Response-budget backstop. The forward rejection normally answers first,
      // well before this deadline. This backstop answers a request whose forward
      // rejection handling itself stalls, so the request never strands.
      respond(
        frame.id,
        {
          status: 504,
          headers: {
            "content-type": "application/json",
            "x-paperclip-bridge-outcome": "indeterminate",
          },
          body: JSON.stringify({
            error: "Duplex broker response budget exceeded.",
            outcome: "indeterminate",
            retryable: false,
          }),
        },
        "indeterminate",
      );
    }, budgets.responseBudgetMs);
    forwardTimer.unref?.();
    responseTimer.unref?.();
    pending.set(frame.id, { controller, responded: false, forwardTimer, responseTimer });

    forwardRequest(frame, { signal: controller.signal }).then(
      (result) => {
        // Keep the outcome classification consistent with the file path. A
        // possibly-committed mutation carries the indeterminate marker header, so
        // map it to the indeterminate outcome. Any other result is completed.
        const outcome: DuplexResponseOutcome =
          result.headers?.["x-paperclip-bridge-outcome"] === "indeterminate"
            ? "indeterminate"
            : "completed";
        respond(frame.id, result, outcome);
      },
      (error) => {
        if (controller.signal.aborted) {
          // The forward budget aborted the call after the request may have
          // committed. Return a non-retryable 504 and mark the outcome
          // indeterminate, so a caller does not retry a committed mutation.
          respond(
            frame.id,
            {
              status: 504,
              headers: {
                "content-type": "application/json",
                "x-paperclip-bridge-outcome": "indeterminate",
              },
              body: JSON.stringify({
                error: errorMessage(error),
                outcome: "indeterminate",
                retryable: false,
              }),
            },
            "indeterminate",
          );
          return;
        }
        // A plain forward failure did not start a host mutation, so a retry is
        // safe. Return a 502 with the completed outcome, so the gateway passes it
        // through as a retryable status.
        respond(
          frame.id,
          {
            status: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: errorMessage(error) }),
          },
          "completed",
        );
      },
    );
  };

  const handleFrame = (frame: DuplexFrame): void => {
    switch (frame.type) {
      case "request":
        dispatch(frame);
        return;
      case "close":
        // The gateway asked for an orderly close. Close the channel.
        void close();
        return;
      case "ready":
      case "heartbeat":
        // Liveness frames. The broker reads them and dispatches nothing.
        return;
      case "response":
      case "error":
        // The host never expects these on the read path. Ignore them.
        return;
      default:
        return;
    }
  };

  const onData = (chunk: string): void => {
    if (stopped) return;
    const results = decoder.push(chunk);
    for (const result of results) {
      if (stopped) return;
      if (!result.ok) {
        recordLoss("protocol_failure", result.error.message);
        return;
      }
      handleFrame(result.frame);
    }
  };

  const onExit = (): void => {
    recordLoss("channel_exit", "The sandbox channel process exited.");
  };

  const sendHeartbeat = (): void => {
    if (state !== "open") return;
    try {
      channel.write(encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "heartbeat" }));
    } catch (error) {
      recordLoss("heartbeat_write_failure", errorMessage(error));
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (stopped) return Promise.resolve();
    closePromise = (async () => {
      setState("closing");
      clearHeartbeat();
      clearPending();
      // Send an orderly close frame. Ignore a write failure here; the broker is
      // already closing, so a dead channel needs no loss record.
      try {
        channel.write(encodeDuplexFrame({ version: DUPLEX_FRAME_VERSION, type: "close" }));
      } catch (error) {
        options.logger?.(`Duplex broker could not send the close frame: ${errorMessage(error)}`);
      }
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => {
          reject(new Error("Duplex broker channel close timed out."));
        }, closeTimeoutMs);
        closeTimer.unref?.();
      });
      try {
        await Promise.race([channel.close(), timeout]);
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        stopped = true;
        setState("closed");
      } catch (error) {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        recordLoss("close_timeout", errorMessage(error));
      }
    })();
    return closePromise;
  };

  const start = (): void => {
    if (started) return;
    started = true;
    channel.onData(onData);
    channel.onExit(onExit);
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    setState("open");
  };

  const stop = (): void => {
    try {
      channel.stop();
    } catch (error) {
      options.logger?.(`Duplex broker could not stop the channel: ${errorMessage(error)}`);
    }
  };

  return {
    get state() {
      return state;
    },
    get lossRecord() {
      return lossRecord;
    },
    start,
    close,
    stop,
  };
}
