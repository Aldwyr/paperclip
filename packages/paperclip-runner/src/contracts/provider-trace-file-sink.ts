import { createHash } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_RECORDS = 1_024;

type TraceRecord = Record<string, unknown>;
type ProviderTraceDirection =
  | "client_to_provider"
  | "provider_to_client"
  | "provider_stderr";
type ProviderTraceDisposition =
  | "mapped"
  | "generic"
  | "ignored"
  | "rejected"
  | "operator_only";
type ProviderTraceFieldMapping = {
  inputPath?: string;
  outputPath?: string;
  action: "copied" | "renamed" | "normalized" | "derived" | "dropped" | "redacted";
  reason?: string;
};

/**
 * A bounded, fire-and-forget file spool for native providers implemented in
 * TypeScript. Provider execution never awaits writes on its hot path; a slow
 * or failed sidecar becomes an incomplete trace instead of run backpressure.
 */
export class ProviderTraceFileSink {
  readonly #path: string;
  readonly #provider: string;
  readonly #channel: string;
  readonly #maxBytes: number;
  readonly #queue: string[] = [];
  #nextFrameId: number;
  #nextDebugSequence: number;
  #capturedBytes: number;
  #draining: Promise<void> | null = null;
  #closed = false;
  #truncated = false;
  #incompleteReason: string | null = null;

  constructor(input: {
    path: string;
    provider: string;
    channel: string;
    maxBytes?: number;
    nextFrameId?: number;
    nextDebugSequence?: number;
    capturedBytes?: number;
  }) {
    this.#path = input.path;
    this.#provider = input.provider;
    this.#channel = input.channel;
    this.#maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#nextFrameId = input.nextFrameId ?? 1;
    this.#nextDebugSequence = input.nextDebugSequence ?? 1;
    this.#capturedBytes = input.capturedBytes ?? 0;
  }

  frame(input: {
    direction: ProviderTraceDirection;
    raw: Uint8Array | string;
    transport: string;
    nativeMethod?: string;
  }): number | null {
    if (this.#closed) return null;
    const raw = typeof input.raw === "string" ? Buffer.from(input.raw) : Buffer.from(input.raw);
    if (this.#capturedBytes + raw.byteLength > this.#maxBytes) {
      this.#truncated = true;
      return null;
    }
    const frameId = this.#nextFrameId++;
    this.#capturedBytes += raw.byteLength;
    this.#append({
      kind: "frame",
      schema: "paperclip.provider_trace_frame.v1",
      frameId,
      timestamp: new Date().toISOString(),
      direction: input.direction,
      transport: input.transport,
      provider: this.#provider,
      ...(input.nativeMethod ? { nativeMethod: input.nativeMethod } : {}),
      byteLength: raw.byteLength,
      digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      rawBase64: raw.toString("base64"),
    });
    return frameId;
  }

  interpretation(input: {
    frameId: number;
    stage: string;
    ruleId: string;
    disposition: ProviderTraceDisposition;
    emittedEventIds?: string[];
    droppedFields?: string[];
    fieldMappings?: ProviderTraceFieldMapping[];
    reason: string;
  }): void {
    if (this.#closed) return;
    this.#append({
      kind: "interpretation",
      schema: "paperclip.provider_trace_interpretation.v1",
      frameId: input.frameId,
      stage: input.stage,
      ruleId: input.ruleId,
      disposition: input.disposition,
      emittedEventIds: input.emittedEventIds ?? [],
      droppedFields: input.droppedFields ?? [],
      fieldMappings: input.fieldMappings ?? [],
      reason: input.reason,
    });
  }

  async finish(input: { reason?: string | null } = {}): Promise<void> {
    if (this.#closed) {
      await this.#draining;
      return;
    }
    const reason = input.reason ?? this.#incompleteReason;
    const status = reason
      ? "incomplete"
      : this.#truncated
        ? "truncated"
        : "complete";
    const acknowledgedDebugSequence = this.#nextDebugSequence - 1;
    this.#append({
      kind: "trace_status",
      status,
      acknowledgedDebugSequence,
      reason: reason ?? (this.#truncated ? "provider_trace_max_bytes_exceeded" : null),
    });
    this.#closed = true;
    await this.#draining;
    await chmod(this.#path, 0o600).catch(() => undefined);
  }

  #append(value: TraceRecord): void {
    const record = {
      ...value,
      debugChannel: this.#channel,
      debugSequence: this.#nextDebugSequence++,
    };
    if (this.#queue.length >= MAX_PENDING_RECORDS) {
      this.#incompleteReason ??= "trace_sidecar_spool_full";
      return;
    }
    this.#queue.push(`${JSON.stringify(record)}\n`);
    if (this.#draining === null) this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if (this.#queue.length > 0) this.#scheduleDrain();
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const line = this.#queue.shift()!;
      try {
        await appendFile(this.#path, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        this.#incompleteReason ??= "trace_sidecar_write_failed";
        this.#queue.length = 0;
        return;
      }
    }
  }
}

export async function createProviderTraceFileSink(input: {
  path?: string;
  provider: string;
  channel: string;
  maxBytes?: string | number;
}): Promise<ProviderTraceFileSink | null> {
  if (!input.path) return null;
  const maxBytes = typeof input.maxBytes === "number"
    ? input.maxBytes
    : Number.parseInt(input.maxBytes ?? "", 10);
  const existing = await readFile(input.path, "utf8").catch(() => "");
  let nextFrameId = 1;
  let nextDebugSequence = 1;
  let capturedBytes = 0;
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.kind === "frame") {
        nextFrameId = Math.max(nextFrameId, Number(entry.frameId) + 1 || 1);
        capturedBytes += Number(entry.byteLength) || 0;
      }
      if (entry.debugChannel === input.channel) {
        nextDebugSequence = Math.max(
          nextDebugSequence,
          Number(entry.debugSequence) + 1 || 1,
        );
      }
    } catch {
      // The server-side integrity pass will classify a malformed prior record.
    }
  }
  return new ProviderTraceFileSink({
    path: input.path,
    provider: input.provider,
    channel: input.channel,
    maxBytes: Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    nextFrameId,
    nextDebugSequence,
    capturedBytes,
  });
}
