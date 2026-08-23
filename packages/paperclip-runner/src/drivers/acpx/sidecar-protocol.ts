import type { QualifiedAcpxAgent } from "./qualified-profiles.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import {
  GENERATED_ACPX_SIDECAR_COMMANDS,
  GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
  type GeneratedAcpxSidecarCommand,
  type GeneratedAcpxSidecarEventType,
} from "./generated-sidecar-contract.js";

export const ACPX_SIDECAR_PROTOCOL_VERSION = GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION;
export const ACPX_SIDECAR_MAX_FRAME_BYTES = 1024 * 1024;

export interface AcpxSidecarRequest {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  id: number;
  command: GeneratedAcpxSidecarCommand;
  params: Record<string, unknown>;
}

export interface AcpxSidecarResponse {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface AcpxSidecarEvent {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  sequence: number;
  eventType: GeneratedAcpxSidecarEventType;
  runId: string | null;
  turnId: string | null;
  payload: Record<string, unknown>;
}

export interface AcpxSidecarOpenParams {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  systemInstructions: string;
  runtimeContext: NativeRuntimeContextSnapshot | null;
  tools: readonly Readonly<Record<string, unknown>>[];
  expectedIdentity?: AcpxExpectedSessionIdentity;
}

export interface AcpxExpectedSessionIdentity {
  kind: "acpx";
  normalizedSessionId: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  profileDigest: string;
  workspaceDigest: string;
  requestedModel: string;
  effectiveModel: string;
}

export function parseAcpxSidecarRequest(value: unknown): AcpxSidecarRequest {
  const request = record(value);
  if (request.protocolVersion !== ACPX_SIDECAR_PROTOCOL_VERSION) {
    throw new Error("unsupported ACPX sidecar protocol version");
  }
  if (!Number.isSafeInteger(request.id) || Number(request.id) < 1) throw new Error("sidecar request id must be a positive integer");
  const command = text(request.command);
  if (!(GENERATED_ACPX_SIDECAR_COMMANDS as readonly string[]).includes(command)) throw new Error("unsupported ACPX sidecar command");
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id: Number(request.id),
    command: command as AcpxSidecarRequest["command"],
    params: structuredClone(record(request.params)),
  };
}

export function boundedSidecarValue(value: unknown, maxBytes = 64 * 1024): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > maxBytes) return { omitted: true, reason: "payload_limit" };
  return record(JSON.parse(serialized));
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
