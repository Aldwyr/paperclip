import type {
  NativeRunIdentity,
  NativeSessionCapabilities,
  NativeUserMessage,
} from "./types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";
import type {
  HarnessRuntimeRequest,
  HarnessThreadLineageEntry,
  PersistedHarnessTurnTerminal,
} from "./harness-driver.js";

export interface NativeSessionBackendDescriptor {
  kind: "runner" | "remote" | "mock";
  name: string;
  version: string;
  capabilities: NativeSessionCapabilities;
}

export interface OpenNativeSessionInput {
  identity: NativeRunIdentity;
  workingDirectory?: string;
}

export interface PersistedNativeSession {
  backendKind: NativeSessionBackendDescriptor["kind"];
  driverKind?: string | null;
  sessionId: string;
  identity: NativeRunIdentity;
  providerSessionId?: string | null;
  cursor?: string | null;
  semanticResult?: PrpStructuredRunResult | null;
  terminal?: PrpTerminalState | null;
  activeTurnId?: string | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  lineage?: HarnessThreadLineageEntry[];
}

export interface NativeSessionRecoveryResult {
  recovered: boolean;
  session?: NativeSession;
  reason?: string;
}

export interface NativeSession {
  identity(): NativeRunIdentity;
  capabilities(): Promise<NativeSessionCapabilities>;
  attachRun?(input: { identity: NativeRunIdentity }): Promise<void>;
  events(input?: { afterCursor?: string | null }): AsyncIterable<PrpEvent>;
  startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{ turnId: string; effectiveCollaborationMode?: "default" | "plan" }>;
  steer?(input: { turnId: string; message: NativeUserMessage }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  cancel?(input: { reason: string }): Promise<void>;
  result(): Promise<{
    result: PrpStructuredRunResult;
    terminal: PrpTerminalState;
    turnId: string | null;
  } | null>;
  usage?(): Promise<Record<string, unknown> | null>;
  snapshot(): Promise<PersistedNativeSession>;
  close(input: { reason: string }): Promise<void>;
}

/** Normalized control-plane boundary shared by runner and hosted backends. */
export interface NativeSessionBackend {
  descriptor(): Promise<NativeSessionBackendDescriptor>;
  openSession(input: OpenNativeSessionInput): Promise<NativeSession>;
  recoverSession?(
    snapshot: PersistedNativeSession,
  ): Promise<NativeSessionRecoveryResult>;
}
