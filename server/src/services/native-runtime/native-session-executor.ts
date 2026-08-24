import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type {
  HarnessRuntimeRequestResolution,
  NativeExecutionInput,
  NativeSession,
  NativeSessionBackend,
  PaperclipQuestionSet,
  PersistedNativeSession,
  PrpEvent,
  PrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";
import {
  createNativeSessionBackend,
  createRunnerdCodexTransport,
  executeNativeSession,
  parsePaperclipQuestionSet,
} from "../../vendor/paperclip-runner/index.js";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  documentRevisions,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { documentService } from "../documents.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueService } from "../issues.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";
import { HttpError } from "../../errors.js";

type ActiveNativeSession = {
  session: NativeSession;
  cancelRequested: boolean;
};

const activeNativeSessions = new Map<string, ActiveNativeSession>();
const nativeRuntimeRequestResolutions = new Map<
  string,
  {
    fingerprint: string;
    commandId: string;
    pending: Promise<void>;
  }
>();

type WarmNativeSession = {
  session: NativeSession;
  configDigest: string;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivityAt: string;
};

const warmNativeSessions = new Map<string, WarmNativeSession>();

const NATIVE_PROVIDER_HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SystemRoot",
  "PATHEXT",
] as const;

/**
 * Provider bootstrap needs a small amount of host process context even when
 * the agent has no configured env. In particular, an empty environment makes
 * a bare `codex` command unresolvable. Agent-configured values remain
 * authoritative and may intentionally override the host defaults.
 */
export function buildNativeProviderEnvironment(
  configured: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    NATIVE_PROVIDER_HOST_ENV_KEYS.flatMap((key) => {
      const value = host[key];
      return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
    }),
  );
  return { ...inherited, ...configured };
}

type PlanSynchronization = {
  eventId: string;
  planId: string;
  providerRevision: number;
  status: "synchronized" | "already_synchronized" | "conflict" | "invalid" | "approval_failed";
  baseRevisionId: string | null;
  digest: string;
  documentRevision: number | null;
  currentRevisionId: string | null;
  confirmationId: string | null;
};

type RuntimeQuestionFallback = {
  kind: "ask_user_questions";
  idempotencyKey: string;
  sourceRunId: string;
  title: string | null;
  summary: string | null;
  continuationPolicy: "wake_assignee";
  payload: {
    version: 1;
    title?: string;
    submitLabel?: string;
    supersedeOnUserComment: false;
    questionSet: PaperclipQuestionSet;
    questions: Array<{
      id: string;
      prompt: string;
      helpText?: string;
      selectionMode: "single" | "multi";
      required: boolean;
      options: Array<{ id: string; label: string; description?: string; freeText?: boolean }>;
    }>;
  };
};

/** Translate only provider-loss expirations; cancellations and resolved inputs never fall back. */
export function runtimeQuestionFallbackFromEvent(
  event: Pick<PrpEvent, "eventType" | "payload" | "runId">,
): RuntimeQuestionFallback | null {
  if (event.eventType !== "runtime_request.expired") return null;
  const payload = record(event.payload);
  if (payload.reason !== "provider_process_lost" || payload.replayAllowed !== false) return null;
  const request = record(payload.request);
  if (
    request.schema !== "paperclip.runtime_request.v2"
    || request.requestKind !== "runtime"
    || request.type !== "input"
    || typeof request.requestId !== "string"
  ) return null;
  let questionSet: PaperclipQuestionSet;
  try {
    questionSet = parsePaperclipQuestionSet(request.input);
  } catch {
    return null;
  }
  const questions = questionSet.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    ...(question.helpText ? { helpText: question.helpText } : {}),
    selectionMode: question.answerMode === "multi_select" ? "multi" as const : "single" as const,
    required: question.required,
    options: question.answerMode === "text"
      ? [{
          id: "__paperclip_text__",
          label: question.textValidation?.inputType === "integer"
            ? "Enter an integer"
            : question.textValidation?.inputType === "number"
              ? "Enter a number"
              : "Enter your answer",
          freeText: true,
        }]
      : (question.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
  }));
  return {
    kind: "ask_user_questions",
    idempotencyKey: `runtime-input-fallback:v1:${event.runId}:${request.requestId}`,
    sourceRunId: event.runId,
    title: questionSet.title?.slice(0, 240) ?? null,
    summary: questionSet.description?.slice(0, 1000) ?? null,
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
      ...(questionSet.submitLabel ? { submitLabel: questionSet.submitLabel.slice(0, 120) } : {}),
      supersedeOnUserComment: false,
      questionSet,
      questions,
    },
  };
}

export function runtimeInputLifecycleMetric(
  event: Pick<PrpEvent, "eventType" | "payload">,
): { outcome: "normalized" | "rejected" | "resolved" | "expired" | "cancelled"; adapter: string; requestId: string | null } | null {
  const payload = record(event.payload);
  const request = record(payload.request);
  if (event.eventType === "runtime_request.created" && request.type === "input") {
    const origin = record(request.origin);
    return {
      outcome: "normalized",
      adapter: typeof origin.adapter === "string" ? origin.adapter : "unknown",
      requestId: typeof request.requestId === "string" ? request.requestId : null,
    };
  }
  if (event.eventType === "harness.diagnostic" && payload.code === "runtime_input_rejected") {
    return {
      outcome: "rejected",
      adapter: typeof payload.adapter === "string" ? payload.adapter : "unknown",
      requestId: null,
    };
  }
  const terminalOutcome = event.eventType === "runtime_request.resolved" ? "resolved"
    : event.eventType === "runtime_request.expired" ? "expired"
      : event.eventType === "runtime_request.cancelled" ? "cancelled"
        : null;
  const requestType = payload.requestType ?? request.type;
  if (!terminalOutcome || requestType !== "input") return null;
  const origin = record(request.origin);
  return {
    outcome: terminalOutcome,
    adapter: typeof payload.adapter === "string"
      ? payload.adapter
      : typeof origin.adapter === "string" ? origin.adapter : "unknown",
    requestId: typeof payload.requestId === "string"
      ? payload.requestId
      : typeof request.requestId === "string" ? request.requestId : null,
  };
}

export function providerPlanMarkdown(payload: Record<string, unknown>): string {
  const completedMarkdown = typeof payload.markdown === "string" ? payload.markdown.trim() : "";
  if (completedMarkdown) return completedMarkdown.slice(0, 256_000);
  const explanation = typeof payload.explanation === "string" ? payload.explanation.trim() : "";
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const lines = steps.slice(0, 256).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const step = value as Record<string, unknown>;
    const body = typeof step.body === "string" ? step.body.trim().slice(0, 4_000) : "";
    if (!body) return [];
    const status = step.status === "completed" ? "x" : " ";
    const suffix = step.status === "blocked" ? " _(blocked)_" : step.status === "in_progress" ? " _(in progress)_" : "";
    return [`- [${status}] ${body}${suffix}`];
  });
  return [explanation, lines.join("\n")].filter(Boolean).join("\n\n").slice(0, 256_000);
}

export function semanticProviderPlanMarkdown(result: Record<string, unknown>): string | null {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  for (const value of artifacts) {
    const artifact = record(value);
    if (artifact.kind !== "native_provider_plan" || typeof artifact.ref !== "string") continue;
    const match = artifact.ref.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
    const completedMarkdown = match?.[1]?.trim();
    if (completedMarkdown) return completedMarkdown.slice(0, 256_000);

    const embedded = artifact.ref.match(/^native-provider-plan:([^\n]+)\n([\s\S]+)$/i);
    if (embedded) {
      const title = embedded[1]!
        .replace(/^(?:DOT-\d+-)?/i, "")
        .replace(/-v\d+$/i, "")
        .replace(/-/g, " ")
        .trim();
      const body = embedded[2]!.trim();
      if (title && body) {
        return [`# ${title.charAt(0).toUpperCase()}${title.slice(1)}`, "", body]
          .join("\n")
          .slice(0, 256_000);
      }
    }

    if (/^\s*1\.\s+/.test(artifact.ref)) {
      const numberedPlan = artifact.ref
        .split(/\s+\|\s+(?=\d+\.\s+)/)
        .join("\n")
        .trim();
      if (numberedPlan) return `# Plan\n\n${numberedPlan}`.slice(0, 256_000);
    }

    // Some qualified Codex builds use the artifact reference itself as a
    // compact, human-readable plan. Accept only an explicitly numbered form;
    // arbitrary opaque artifact references must never become plan documents.
    const inlineNumbered = artifact.ref.trim();
    if (/\(1\)\s+.+\(2\)\s+/s.test(inlineNumbered)) {
      const body = inlineNumbered
        .replace(/^DOT-\d+\s+plan:\s*/i, "")
        .replace(/^\(1\)\s*/, "1. ")
        .replace(/;\s*\((\d+)\)\s*/g, "\n$1. ")
        .trim();
      if (body) return `# Plan\n\n${body}`.slice(0, 256_000);
    }

    const compact = artifact.ref.match(/^native-provider-plan:([^#]+)#(.+)$/i)
      ?? artifact.ref.match(/^native-plan:\/\/[^/]+\/([^#]+)#(.+)$/i);
    if (!compact) continue;
    const humanize = (slug: string) => slug
      .replace(/\b(GET|POST|PUT|PATCH|DELETE)-([a-z0-9][a-z0-9-]*)/gi, (_whole, method: string, path: string) => `${method.toUpperCase()} /${path}`)
      .replace(/-/g, " ")
      .replace(/\bjson\b/gi, "JSON")
      .replace(/\bapi\b/gi, "API")
      .replace(/\s+/g, " ")
      .trim();
    const title = humanize(compact[1]!.replace(/-v\d+$/i, ""));
    const steps = compact[2]!.split(";").flatMap((encoded) => {
      const parsed = encoded.match(/^\d+-(.+)$/);
      const sentence = humanize(parsed?.[1] ?? encoded);
      return sentence ? [sentence.charAt(0).toUpperCase() + sentence.slice(1)] : [];
    });
    if (!title || steps.length === 0) continue;
    return [`# ${title.charAt(0).toUpperCase()}${title.slice(1)}`, "", ...steps.map((step, index) => `${index + 1}. ${step}`)]
      .join("\n")
      .slice(0, 256_000);

  }
  const hasNativePlanArtifact = artifacts.some((value) => record(value).kind === "native_provider_plan");
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  const summaryPlan = hasNativePlanArtifact ? summary.match(/(?:^|:\s*)(1\)\s+[\s\S]+;\s*2\)\s+[\s\S]+;\s*3\)\s+[\s\S]+)$/) : null;
  if (summaryPlan) {
    const body = summaryPlan[1]!
      .replace(/^1\)\s*/, "1. ")
      .replace(/;\s*(\d+)\)\s*/g, "\n$1. ")
      .trim();
    if (body) return `# Plan\n\n${body}`.slice(0, 256_000);
  }
  return null;
}

/**
 * Convert a server-owned pending interaction into the semantic wait that a
 * provider omitted. This is not a fabricated final response: it records that
 * the current turn intentionally yielded to a durable governance surface.
 */
export function nativeGovernedWaitResult(input: {
  interaction: { id: string; title: string | null; summary: string | null };
  completionContract: NativeExecutionInput["completionContract"]["contract"];
}): PrpStructuredRunResult {
  const interactionRef = `interaction:${input.interaction.id}`;
  const label = input.interaction.title?.trim()
    || input.interaction.summary?.trim()
    || "the requested response";
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "yielded",
    summary: `Waiting for ${label}.`,
    completionClaim: {
      contractRevision: input.completionContract.revision,
      objectiveSatisfied: false,
      criteria: input.completionContract.criteria.map((criterion) => ({
        criterionId: criterion.id,
        status: "unknown",
        evidenceRefs: [interactionRef],
      })),
      remainingWork: [{
        description: "Resume after the durable interaction is resolved.",
        blocksCompletion: true,
      }],
    },
    evidence: [{ ref: interactionRef }],
    verification: [],
    attentionRequests: [],
    artifacts: [{ kind: "issue_thread_interaction", ref: interactionRef }],
    continuation: {
      kind: "response_wake",
      summary: "Resume from the resolved interaction response without repeating prior work.",
      idempotencyKey: `interaction-response:${input.interaction.id}`,
    },
  };
}

/**
 * Partial item-verdict responses deliberately leave their original durable
 * interaction pending. They are already authority-checked before entering the
 * closed native envelope, so that exact interaction may park the continuation
 * run without requiring the model to recreate a second request.
 */
export function continuingPendingInteractionIds(execution: NativeExecutionInput): string[] {
  return execution.interactionResponses
    .filter((response) =>
      response.kind === "request_item_verdicts"
      && response.response.status === "pending")
    .map((response) => response.interactionId);
}

export async function synchronizeCompletedProviderPlan(input: {
  db: Db;
  execution: NativeExecutionInput;
  event: { sourceEventId: string; turnId?: string; eventType: string; payload: Record<string, unknown> };
}): Promise<PlanSynchronization | null> {
  if (input.event.eventType !== "plan.updated" || input.event.payload.complete !== true) return null;
  if (!("executionMode" in input.execution) || input.execution.executionMode !== "plan") return null;
  const planningContext = input.execution.planningContext;
  if (!planningContext) return null;
  const planId = typeof input.event.payload.planId === "string" ? input.event.payload.planId : "";
  const providerRevision = Number.isSafeInteger(input.event.payload.revision) ? Number(input.event.payload.revision) : 0;
  const body = providerPlanMarkdown(input.event.payload);
  const digest = createHash("sha256").update(body).digest("hex");
  if (!planId || providerRevision < 1 || !body) {
    return { eventId: input.event.sourceEventId, planId, providerRevision, status: "invalid", baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: null, currentRevisionId: null, confirmationId: null };
  }
  const provenance = `runner-plan-sync:v2 run=${input.execution.binding.runId} turn=${input.event.turnId ?? "unknown"} provider=${input.execution.provider.kind} plan=${planId} revision=${providerRevision} digest=${digest}`;
  const existingRevision = await input.db.select({ revisionNumber: documentRevisions.revisionNumber, id: documentRevisions.id })
    .from(documentRevisions)
    .innerJoin(issueDocuments, eq(issueDocuments.documentId, documentRevisions.documentId))
    .where(and(eq(issueDocuments.issueId, input.execution.binding.issueId), eq(issueDocuments.key, "plan"), eq(documentRevisions.changeSummary, provenance)))
    .orderBy(desc(documentRevisions.revisionNumber)).limit(1).then((rows) => rows[0] ?? null);
  const documents = documentService(input.db);
  let revision = existingRevision;
  let status: PlanSynchronization["status"] = existingRevision ? "already_synchronized" : "synchronized";
  if (!revision) {
    const latest = await documents.getIssueDocumentByKey(input.execution.binding.issueId, "plan");
    if (latest?.latestRevisionId && latest.body === body) {
      const sameRunRevision = await input.db.select({
        id: documentRevisions.id,
        revisionNumber: documentRevisions.revisionNumber,
        createdByRunId: documentRevisions.createdByRunId,
      }).from(documentRevisions)
        .where(eq(documentRevisions.id, latest.latestRevisionId))
        .limit(1).then((rows) => rows[0] ?? null);
      if (sameRunRevision?.createdByRunId === input.execution.binding.runId) {
        revision = sameRunRevision;
        status = "already_synchronized";
      }
    }
  }
  try {
    if (!revision) {
      const write = await documents.upsertIssueDocument({
        issueId: input.execution.binding.issueId,
        key: "plan",
        title: "Plan",
        format: "markdown",
        body,
        baseRevisionId: planningContext.baseRevisionId,
        changeSummary: provenance,
        createdByAgentId: input.execution.binding.agentId,
        createdByRunId: input.execution.binding.runId,
      });
      revision = { revisionNumber: write.document.latestRevisionNumber, id: write.document.latestRevisionId! };
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    const latest = await documents.getIssueDocumentByKey(input.execution.binding.issueId, "plan");
    return { eventId: input.event.sourceEventId, planId, providerRevision, status: "conflict", baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: latest?.latestRevisionNumber ?? null, currentRevisionId: latest?.latestRevisionId ?? null, confirmationId: null };
  }
  const current = await documents.getIssueDocumentByKey(input.execution.binding.issueId, "plan");
  if (!current || !revision?.id || current.latestRevisionId !== revision.id) {
    return { eventId: input.event.sourceEventId, planId, providerRevision, status: "conflict", baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: current?.latestRevisionNumber ?? null, currentRevisionId: current?.latestRevisionId ?? null, confirmationId: null };
  }
  let confirmationId: string;
  try {
    const confirmation = await issueThreadInteractionService(input.db).create(
      { id: input.execution.binding.issueId, companyId: input.execution.binding.companyId },
      {
        kind: "request_confirmation",
        idempotencyKey: `runner-plan-approval:v1:${input.execution.binding.runId}:${planId}:${providerRevision}:${digest}`,
        sourceRunId: input.execution.binding.runId,
        title: `Review plan revision ${revision.revisionNumber}`,
        summary: "Review the synchronized Paperclip plan.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: `Approve plan revision ${revision.revisionNumber}?`,
          detailsMarkdown: "The completed provider plan has been synchronized to the canonical Plan document.",
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          supersedeOnUserComment: false,
          target: {
            type: "issue_document",
            issueId: input.execution.binding.issueId,
            documentId: current.id,
            key: "plan",
            revisionId: revision.id,
            revisionNumber: revision.revisionNumber,
            label: `Plan v${revision.revisionNumber}`,
          },
        },
      } as never,
      { agentId: input.execution.binding.agentId, runId: input.execution.binding.runId },
    );
    confirmationId = confirmation.id;
  } catch {
    return { eventId: input.event.sourceEventId, planId, providerRevision, status: "approval_failed", baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: revision.revisionNumber, currentRevisionId: revision.id, confirmationId: null };
  }
  try {
    const currentIssue = await input.db.select({ status: issues.status }).from(issues)
      .where(eq(issues.id, input.execution.binding.issueId))
      .limit(1).then((rows) => rows[0] ?? null);
    if (currentIssue && currentIssue.status !== "in_review") {
      await issueService(input.db).update(input.execution.binding.issueId, {
        status: "in_review",
        actorAgentId: input.execution.binding.agentId,
      });
    }
  } catch {
    const settledIssue = await input.db.select({ status: issues.status }).from(issues)
      .where(eq(issues.id, input.execution.binding.issueId))
      .limit(1).then((rows) => rows[0] ?? null);
    if (settledIssue?.status !== "in_review") {
      return { eventId: input.event.sourceEventId, planId, providerRevision, status: "approval_failed", baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: revision.revisionNumber, currentRevisionId: revision.id, confirmationId };
    }
  }
  return { eventId: input.event.sourceEventId, planId, providerRevision, status, baseRevisionId: planningContext.baseRevisionId, digest, documentRevision: revision.revisionNumber, currentRevisionId: revision.id, confirmationId };
}

class SessionToolAuthorityRouter {
  #authority: PaperclipRunnerToolAuthority;

  constructor(authority: PaperclipRunnerToolAuthority) {
    this.#authority = authority;
  }

  bind(authority: PaperclipRunnerToolAuthority): void {
    this.#authority = authority;
  }

  definitions() {
    return this.#authority.definitions();
  }

  execute(call: Parameters<PaperclipRunnerToolAuthority["execute"]>[0]) {
    return this.#authority.execute(call);
  }
}

const sessionToolRouters = new Map<string, SessionToolAuthorityRouter>();

function nativeSessionKey(execution: NativeExecutionInput): string {
  return execution.session.normalizedSessionId ?? `session-${execution.binding.runId}`;
}

function runnerdStateRoot(execution: NativeExecutionInput): string {
  return resolve(
    process.env.PAPERCLIP_RUNNER_STATE_DIR ?? resolve(tmpdir(), "paperclip-runner"),
    createHash("sha256").update(nativeSessionKey(execution)).digest("hex"),
  );
}

function loadRunnerdDurableBinding(execution: NativeExecutionInput): {
  runnerInstanceId: string;
  environmentLeaseId: string;
} | null {
  const statePath = resolve(runnerdStateRoot(execution), "control-plane", "mock-core-state.json");
  if (!existsSync(statePath)) return null;
  try {
    const identity = record(record(JSON.parse(readFileSync(statePath, "utf8"))).identity);
    if (
      identity.normalizedSessionId !== nativeSessionKey(execution)
      || typeof identity.runnerInstanceId !== "string"
      || typeof identity.environmentLeaseId !== "string"
    ) return null;
    return {
      runnerInstanceId: identity.runnerInstanceId,
      environmentLeaseId: identity.environmentLeaseId,
    };
  } catch {
    return null;
  }
}

function nativeSessionConfigDigest(execution: NativeExecutionInput): string {
  const executionLocation = execution.provider.kind === "claude_managed" || execution.provider.kind === "aws_agentcore"
    ? { executionKind: "remote_service", workspace: null }
    : {
        executionKind: "local_process",
        workspaceId: execution.binding.executionWorkspaceId,
        cwd: execution.workspace.cwd,
      };
  return `sha256:${createHash("sha256").update(JSON.stringify({
    companyId: execution.binding.companyId,
    normalizedSessionId: nativeSessionKey(execution),
    executionLocation,
    provider: execution.provider,
    driverKind: execution.session.driverKind,
    lifecyclePolicy: execution.session.lifecyclePolicy,
    executionMode: "executionMode" in execution ? execution.executionMode : "default",
    runtimeContextDigest: "runtimeContext" in execution ? execution.runtimeContext.aggregateDigest : null,
  })).digest("hex")}`;
}

function nativeSessionCheckpointPath(sessionId: string): string {
  const directory = resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return resolve(directory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function persistWarmNativeCheckpoint(
  sessionId: string,
  configDigest: string,
  snapshot: PersistedNativeSession,
): void {
  const path = nativeSessionCheckpointPath(sessionId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    schema: "paperclip.native-session-supervisor.v1",
    configDigest,
    updatedAt: new Date().toISOString(),
    snapshot,
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadWarmNativeCheckpoint(
  execution: NativeExecutionInput,
  configDigest: string,
): PersistedNativeSession | null {
  const path = nativeSessionCheckpointPath(nativeSessionKey(execution));
  if (!existsSync(path)) return null;
  const envelope = JSON.parse(readFileSync(path, "utf8")) as {
    schema?: string;
    configDigest?: string;
    snapshot?: PersistedNativeSession;
  };
  if (envelope.schema !== "paperclip.native-session-supervisor.v1" || envelope.configDigest !== configDigest || !envelope.snapshot) {
    throw new Error("native_session_supervisor_checkpoint_mismatch");
  }
  return {
    ...envelope.snapshot,
    identity: {
      runId: execution.binding.runId,
      sessionId: nativeSessionKey(execution),
      companyId: execution.binding.companyId,
      issueId: execution.binding.issueId,
      agentId: execution.binding.agentId,
    },
    semanticResult: null,
    terminal: null,
    activeTurnId: null,
    terminalTurns: [],
    pendingRuntimeRequests: [],
  };
}

async function releaseWarmNativeSession(
  sessionId: string,
  idleTimeoutMs: number,
  failed: boolean,
): Promise<void> {
  const entry = warmNativeSessions.get(sessionId);
  if (!entry) return;
  entry.busy = false;
  entry.lastActivityAt = new Date().toISOString();
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  if (failed) {
    warmNativeSessions.delete(sessionId);
    await entry.session.close({ reason: "warm native session failed" }).catch(() => undefined);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    const current = warmNativeSessions.get(sessionId);
    if (!current || current.busy) return;
    warmNativeSessions.delete(sessionId);
    void current.session.close({ reason: "warm native session idle timeout" });
  }, idleTimeoutMs);
  entry.idleTimer.unref();
}

export function nativeSessionFailureDisposition(attempt: number, now = new Date()) {
  const exhausted = attempt >= 3;
  return {
    phase: exhausted ? "terminal_failure" as const : "retryable_failure" as const,
    failureCode: exhausted ? "native_session_retry_exhausted" as const : "native_session_interrupted" as const,
    nextAttemptAt: exhausted ? null : new Date(now.getTime() + 30_000),
  };
}

export function nativeSessionRecoveryProjection(input: {
  phase: "retryable_failure" | "terminal_failure";
  failureCode: "native_session_interrupted" | "native_session_retry_exhausted";
  agentId: string;
}) {
  const exhausted = input.phase === "terminal_failure";
  return {
    exhausted,
    issueStatus: exhausted ? "in_review" as const : null,
    recoveryOwner: exhausted
      ? { kind: "board" as const }
      : { kind: "agent" as const, agentId: input.agentId },
    recoveryActionOwnerType: exhausted ? "board" as const : "agent" as const,
    recoveryActionOwnerAgentId: exhausted ? null : input.agentId,
    recoveryActionCause: input.failureCode,
    supersedeOnIdentityChange: true as const,
  };
}

export function nativeSessionFailureSourceCode(error: unknown):
  | "provider_frame_too_large"
  | "provider_transport_failed"
  | "native_runner_process_exited"
  | "planning_mode_unsupported"
  | "native_session_interrupted" {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider_frame_too_large|stdout frame exceeded/i.test(message)) {
    return "provider_frame_too_large";
  }
  if (/provider_transport_failed|invalid JSON-RPC|provider failed/i.test(message)) {
    return "provider_transport_failed";
  }
  if (/native_runner_process_exited|runnerd exited|runner process failed/i.test(message)) {
    return "native_runner_process_exited";
  }
  if (/planning_mode_unsupported/i.test(message)) {
    return "planning_mode_unsupported";
  }
  return "native_session_interrupted";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type NativeSessionSteeringState = {
  disposition: "available" | "unsupported" | "temporarily_unavailable";
  activeTurnId: string | null;
};

export class NativeSessionSteeringError extends Error {
  constructor(
    readonly code:
      | "steering_unsupported"
      | "steering_temporarily_unavailable"
      | "steering_stale_turn"
      | "steering_timeout"
      | "steering_rejected",
    message: string,
  ) {
    super(message);
    this.name = "NativeSessionSteeringError";
  }
}

export class NativeRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code:
      | "native_session_not_active"
      | "runtime_request_resolution_unsupported"
      | "runtime_request_stale_turn"
      | "runtime_request_resolution_conflict",
    message: string,
  ) {
    super(message);
    this.name = "NativeRuntimeRequestResolutionError";
  }
}

/** Resolve a provider runtime request on an in-process native backend. */
export async function resolveNativeRuntimeRequest(input: {
  runId: string;
  requestId: string;
  turnId: string;
  resolution: HarnessRuntimeRequestResolution;
}): Promise<{ commandId: string }> {
  const active = activeNativeSessions.get(input.runId);
  if (!active) {
    throw new NativeRuntimeRequestResolutionError(
      "native_session_not_active",
      "The active native session is not attached.",
    );
  }
  const capabilities = await active.session.capabilities();
  if (
    !capabilities.runtimeRequestResolution
    || active.session.resolveRuntimeRequest === undefined
  ) {
    throw new NativeRuntimeRequestResolutionError(
      "runtime_request_resolution_unsupported",
      "This native session does not resolve runtime requests in-process.",
    );
  }
  const snapshot = await active.session.snapshot();
  if (snapshot.activeTurnId !== input.turnId) {
    throw new NativeRuntimeRequestResolutionError(
      "runtime_request_stale_turn",
      "The runtime request belongs to a turn that is no longer active.",
    );
  }

  const key = `${input.runId}:${input.requestId}`;
  const fingerprint = JSON.stringify({
    turnId: input.turnId,
    resolution: input.resolution,
  });
  const prior = nativeRuntimeRequestResolutions.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new NativeRuntimeRequestResolutionError(
        "runtime_request_resolution_conflict",
        "A different response was already submitted for this runtime request.",
      );
    }
    await prior.pending;
    return { commandId: prior.commandId };
  }

  const commandId = `native-runtime-response:${randomUUID()}`;
  const pending = active.session.resolveRuntimeRequest({
    requestId: input.requestId,
    turnId: input.turnId,
    resolution: input.resolution,
  });
  nativeRuntimeRequestResolutions.set(key, {
    fingerprint,
    commandId,
    pending,
  });
  try {
    await pending;
    return { commandId };
  } catch (error) {
    if (nativeRuntimeRequestResolutions.get(key)?.pending === pending) {
      nativeRuntimeRequestResolutions.delete(key);
    }
    throw error;
  }
}

export async function getNativeSessionSteeringState(runId: string): Promise<NativeSessionSteeringState> {
  const active = activeNativeSessions.get(runId);
  if (!active) return { disposition: "temporarily_unavailable", activeTurnId: null };
  const capabilities = await active.session.capabilities();
  if (!capabilities.steering || !active.session.steer) {
    return { disposition: "unsupported", activeTurnId: null };
  }
  const snapshot = await active.session.snapshot();
  return {
    disposition: snapshot.activeTurnId ? "available" : "temporarily_unavailable",
    activeTurnId: snapshot.activeTurnId ?? null,
  };
}

/** Dispatches a true same-turn steering message and resolves only after ack. */
export async function steerNativeSession(input: {
  runId: string;
  message: string;
  correlationId: string;
  timeoutMs?: number;
}): Promise<{ turnId: string }> {
  const active = activeNativeSessions.get(input.runId);
  if (!active) {
    throw new NativeSessionSteeringError(
      "steering_temporarily_unavailable",
      "The active native session is not attached.",
    );
  }
  const capabilities = await active.session.capabilities();
  if (!capabilities.steering || !active.session.steer) {
    throw new NativeSessionSteeringError(
      "steering_unsupported",
      "This provider does not support same-turn steering.",
    );
  }
  const snapshot = await active.session.snapshot();
  const turnId = snapshot.activeTurnId ?? null;
  if (!turnId) {
    throw new NativeSessionSteeringError(
      "steering_stale_turn",
      "The target turn is no longer active.",
    );
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      active.session.steer({
        turnId,
        message: { role: "user", text: input.message },
        correlationId: input.correlationId,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new NativeSessionSteeringError(
          "steering_timeout",
          "The provider did not acknowledge steering in time.",
        )), input.timeoutMs ?? 10_000);
      }),
    ]);
    return { turnId };
  } catch (error) {
    if (error instanceof NativeSessionSteeringError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/stale|terminal|active turn/i.test(message)) {
      throw new NativeSessionSteeringError("steering_stale_turn", "The target turn is no longer active.");
    }
    if (/unsupported|unavailable|capability/i.test(message)) {
      throw new NativeSessionSteeringError("steering_unsupported", "This provider does not support same-turn steering.");
    }
    throw new NativeSessionSteeringError("steering_rejected", "The provider rejected the steering message.");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function cancelNativeSession(runId: string, reason: string): Promise<boolean>;
export function cancelNativeSession(
  runId: string,
  reason: string,
  options: { db: Db; scope?: "turn" | "run" | "issue"; replacementAccepted?: boolean },
): Promise<{ dispatched: boolean; decision: NativeStatusDecision | null; decisionId: string | null; auditId: string | null }>;
export async function cancelNativeSession(
  runId: string,
  reason: string,
  options?: { db: Db; scope?: "turn" | "run" | "issue"; replacementAccepted?: boolean },
): Promise<boolean | { dispatched: boolean; decision: NativeStatusDecision | null; decisionId: string | null; auditId: string | null }> {
  let decision: NativeStatusDecision | null = null;
  let decisionContext: {
    companyId: string;
    issueId: string;
    assessmentId: string | null;
    priorStatus: string;
    priorStatusVersion: number;
    priorDecisionId: string | null;
    agentId: string;
  } | null = null;
  if (options) {
    const run = await options.db.select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      runtimeMode: heartbeatRuns.runtimeMode,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1).then((rows) => rows[0] ?? null);
    const context = record(run?.contextSnapshot);
    const issueId = typeof context.issueId === "string"
      ? context.issueId
      : typeof context.taskId === "string" ? context.taskId : null;
    const issue = run && issueId
      ? await options.db.select({
          status: issues.status,
          statusVersion: issues.statusVersion,
          lastStatusDecisionId: issues.lastStatusDecisionId,
        }).from(issues).where(and(
          eq(issues.id, issueId),
          eq(issues.companyId, run.companyId),
        )).limit(1).then((rows) => rows[0] ?? null)
      : null;
    if (run && issue && issueId && run.runtimeMode === "native") {
      decision = resolveNativeCancellationStatus({
        scope: options.scope ?? "run",
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: run.agentId,
        replacementAccepted: options.replacementAccepted,
      });
      const coordinator = await options.db.select({
        assessmentId: nativeRunFinalizations.assessmentId,
      }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.runId, runId),
        eq(nativeRunFinalizations.companyId, run.companyId),
        eq(nativeRunFinalizations.issueId, issueId),
      )).limit(1).then((rows) => rows[0] ?? null);
      decisionContext = {
        companyId: run.companyId,
        issueId,
        assessmentId: coordinator?.assessmentId ?? null,
        priorStatus: issue.status,
        priorStatusVersion: Number(issue.statusVersion),
        priorDecisionId: issue.lastStatusDecisionId,
        agentId: run.agentId,
      };
    }
  }
  const active = activeNativeSessions.get(runId);
  let dispatched = false;
  if (active) {
    dispatched = true;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      try {
        if (active.session.cancel) await active.session.cancel({ reason });
        else if (active.session.interrupt) await active.session.interrupt({ reason });
      } catch (error) {
        active.cancelRequested = false;
        throw error;
      }
    }
  }
  if (!options) return dispatched;

  let decisionId: string | null = null;
  let auditId: string | null = null;
  if (decision && decisionContext) {
    if (decisionContext.assessmentId && decision.reasonCode !== null) {
      const committed = await commitNativeStatusDecision({
        db: options.db,
        companyId: decisionContext.companyId,
        issueId: decisionContext.issueId,
        runId,
        assessmentId: decisionContext.assessmentId,
        priorStatus: decisionContext.priorStatus,
        priorStatusVersion: decisionContext.priorStatusVersion,
        priorDecisionId: decisionContext.priorDecisionId,
        decision,
      });
      decisionId = committed.decision.id;
    } else if (options.replacementAccepted && decision.effects.some((effect) => effect.kind === "accept_replacement_turn")) {
      await options.db.update(heartbeatRuns).set({
        status: "running",
        continuationAttempt: sql`${heartbeatRuns.continuationAttempt} + 1`,
        nextAction: "Accept a replacement native turn on the existing run.",
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, runId));
    }
    const currentRun = await options.db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1).then((rows) => rows[0] ?? null);
    await options.db.update(heartbeatRuns).set({
      resultJson: {
        ...record(currentRun?.resultJson),
        nativeCancellation: {
          scope: options.scope ?? "run",
          reasonCode: decision.reasonCode,
          effects: decision.effects.map((effect) => effect.kind),
          dispatched,
          decisionId,
        },
      },
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, runId));
    const activity = await persistActivity(options.db, {
      companyId: decisionContext.companyId,
      actorType: "system",
      actorId: "native-session-cancellation",
      action: decisionId ? "issue.status_decision_recorded" : "native.cancellation_audited",
      entityType: "heartbeat_run",
      entityId: runId,
      agentId: decisionContext.agentId,
      runId,
      issueId: decisionContext.issueId,
      details: {
        scope: options.scope ?? "run",
        reasonCode: decision.reasonCode,
        effects: decision.effects.map((effect) => effect.kind),
        dispatched,
        decisionId,
      },
    });
    auditId = activity.activity?.id ?? null;
    publishActivity(activity.publication);
  }
  return { dispatched, decision, decisionId, auditId };
}

/** Authenticated cancellation scope projected through the shared arbiter. */
export function resolveNativeCancellationStatus(input: {
  scope: "turn" | "run" | "issue";
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  replacementAccepted?: boolean;
}): NativeStatusDecision {
  if (input.scope === "turn") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: input.replacementAccepted ? null : "cancellation_turn_only",
      unblockDescriptor: null,
      effects: [{ kind: "accept_replacement_turn" }],
    };
  }
  if (input.scope === "run") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "cancellation_run_only",
      unblockDescriptor: null,
      effects: [{ kind: "release_run_resources" }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "cancelled",
    toStatus: "cancelled",
    reasonCode: "cancellation_issue_authorized",
    unblockDescriptor: null,
    effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
  };
}

export async function executePaperclipNativeSession(input: {
  db: Db;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  leaseOwner?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Test seam at the provider boundary; production always uses the package Codex backend. */
  backend?: NativeSessionBackend;
  useRunnerd?: boolean;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** Resolved adapter env; the runner transport applies a provider allowlist before spawn. */
  runnerEnvironment?: NodeJS.ProcessEnv;
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment";
    triggerDetail: "system";
    reason: "issue_assigned";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "agent";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<unknown>;
}): Promise<AdapterExecutionResult> {
  const durableRunnerBinding = input.useRunnerd ? loadRunnerdDurableBinding(input.execution) : null;
  const effectiveRunnerInstanceId = durableRunnerBinding?.runnerInstanceId ?? input.runnerInstanceId;
  if (effectiveRunnerInstanceId !== input.runnerInstanceId) {
    await input.db.update(heartbeatRuns).set({
      runnerInstanceId: effectiveRunnerInstanceId,
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.id, input.execution.binding.runId),
      eq(heartbeatRuns.companyId, input.execution.binding.companyId),
      eq(heartbeatRuns.agentId, input.execution.binding.agentId),
    ));
  }
  const leaseOwner = input.leaseOwner ?? `${effectiveRunnerInstanceId}:${randomUUID()}`;
  const leaseNow = new Date();
  const leaseExpiresAt = new Date(leaseNow.getTime() + 20 * 60_000);
  const attempt = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations)
      .where(and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.companyId, input.execution.binding.companyId),
        eq(nativeRunFinalizations.issueId, input.execution.binding.issueId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new Error("native_finalization_coordinator_missing");
    if (["committed", "applied"].includes(coordinator.phase)) throw new Error("native_run_already_committed");
    if (
      coordinator.leaseOwner
      && coordinator.leaseOwner !== leaseOwner
      && coordinator.leaseExpiresAt
      && coordinator.leaseExpiresAt > leaseNow
    ) throw new Error("native_finalization_lease_busy");
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.resultId ? coordinator.phase : "observed",
      attempt: coordinator.attempt + 1,
      leaseOwner,
      leaseExpiresAt,
      failureCode: null,
      failureDetail: null,
      nextAttemptAt: null,
      updatedAt: leaseNow,
    }).where(eq(nativeRunFinalizations.runId, coordinator.runId));
    await tx.update(heartbeatRuns).set({
      nativePhase: coordinator.resultId ? coordinator.phase : "observed",
      nativePhaseUpdatedAt: leaseNow,
      updatedAt: leaseNow,
    }).where(eq(heartbeatRuns.id, coordinator.runId));
    return coordinator.attempt + 1;
  });
  const controlPlaneInstanceId = `${effectiveRunnerInstanceId}:control`;
  const planSynchronizations: PlanSynchronization[] = [];
  const recordPlanSynchronization = async (event: {
    sourceEventId: string;
    turnId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  }) => {
    const synchronization = await synchronizeCompletedProviderPlan({
      db: input.db,
      execution: input.execution,
      event,
    });
    if (!synchronization) return;
    planSynchronizations.push(synchronization);
    const activity = await persistActivity(input.db, {
      companyId: input.execution.binding.companyId,
      actorType: "agent",
      actorId: input.execution.binding.agentId,
      agentId: input.execution.binding.agentId,
      runId: input.execution.binding.runId,
      issueId: input.execution.binding.issueId,
      action: "issue.document_updated",
      entityType: "issue",
      entityId: input.execution.binding.issueId,
      details: { key: "plan", source: "native_plan_synchronization", synchronization },
    });
    publishActivity(activity.publication);
    if (input.onLog) await input.onLog("stdout", `${JSON.stringify({ type: "paperclip.plan.synchronization", synchronization })}\n`);
  };
  const controlPlane = new PaperclipControlPlanePort(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    completionContractId: input.execution.completionContract.id,
    completionContractSha256: input.execution.completionContract.sha256,
    sourceInstanceId: effectiveRunnerInstanceId,
    controlPlaneSourceInstanceId: controlPlaneInstanceId,
  }, {
    onCommittedEvent: async (event) => {
      if (input.onLog) await input.onLog("stdout", `${JSON.stringify({ type: "paperclip.prp.event", event })}\n`);
      const inputMetric = runtimeInputLifecycleMetric(event);
      if (inputMetric && input.onLog) {
        await input.onLog("stdout", `${JSON.stringify({
          type: "paperclip.runtime_input.metric",
          ...inputMetric,
        })}\n`);
      }
      const questionFallback = runtimeQuestionFallbackFromEvent(event);
      if (questionFallback) {
        const interaction = await issueThreadInteractionService(input.db).create(
          {
            id: input.execution.binding.issueId,
            companyId: input.execution.binding.companyId,
          },
          questionFallback as never,
          {
            agentId: input.execution.binding.agentId,
            runId: input.execution.binding.runId,
            systemId: "native-runtime-question-fallback",
          },
        );
        if (input.onLog) {
          const origin = record(record(record(event.payload).request).origin);
          await input.onLog("stdout", `${JSON.stringify({
            type: "paperclip.runtime_input.metric",
            outcome: "fallback_materialized",
            requestId: record(event.payload).requestId,
            interactionId: interaction.id,
            adapter: typeof origin.adapter === "string" ? origin.adapter : "unknown",
          })}\n`);
        }
      }
      await recordPlanSynchronization(event as {
        sourceEventId: string;
        turnId?: string;
        eventType: string;
        payload: Record<string, unknown>;
      });
    },
  });
  let native: Awaited<ReturnType<typeof executeNativeSession>>;
  const lifecyclePolicy = input.execution.session?.lifecyclePolicy
    ?? { mode: "per_turn" as const, idleTimeoutMs: null };
  const warmSessionId = lifecyclePolicy.mode === "warm" ? nativeSessionKey(input.execution) : null;
  const warmConfigDigest = lifecyclePolicy.mode === "warm" ? nativeSessionConfigDigest(input.execution) : null;
  let existingWarmSession: NativeSession | undefined;
  let persistedWarmSession: PersistedNativeSession | null | undefined;
  if (warmSessionId !== null && warmConfigDigest !== null) {
    const entry = warmNativeSessions.get(warmSessionId);
    if (entry) {
      if (entry.configDigest !== warmConfigDigest) throw new Error("native_session_supervisor_config_mismatch");
      if (entry.busy) throw new Error("native_session_supervisor_busy");
      entry.busy = true;
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      existingWarmSession = entry.session;
    } else {
      persistedWarmSession = loadWarmNativeCheckpoint(input.execution, warmConfigDigest);
    }
  }
  const resolvePendingGovernedWait = async () => {
    const continuingInteractionIds = continuingPendingInteractionIds(input.execution);
    const interaction = await input.db.select({
      id: issueThreadInteractions.id,
      title: issueThreadInteractions.title,
      summary: issueThreadInteractions.summary,
    }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.execution.binding.companyId),
      eq(issueThreadInteractions.issueId, input.execution.binding.issueId),
      or(
        eq(issueThreadInteractions.sourceRunId, input.execution.binding.runId),
        ...(continuingInteractionIds.length > 0
          ? [inArray(issueThreadInteractions.id, continuingInteractionIds)]
          : []),
      ),
      eq(issueThreadInteractions.status, "pending"),
    )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return interaction
      ? nativeGovernedWaitResult({
          interaction,
          completionContract: input.execution.completionContract.contract,
        })
      : null;
  };
  try {
    const runnerdBackend = input.useRunnerd && input.backend === undefined
      ? createRunnerdBackend({
          ...input,
          runnerInstanceId: effectiveRunnerInstanceId,
          durableEnvironmentLeaseId: durableRunnerBinding?.environmentLeaseId,
        })
      : null;
    native = await executeNativeSession({
      input: input.execution,
      backend: input.backend
        ?? runnerdBackend
        ?? createNativeSessionBackend(input.execution, {
          runnerInstanceId: input.runnerInstanceId,
          onSpawn: input.onSpawn,
          environment: input.runnerEnvironment ?? process.env,
          opencodeRuntimeDirectory: resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "opencode"),
          acpxRuntimeDirectory: resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "acpx"),
        }),
      controlPlane,
      runnerInstanceId: effectiveRunnerInstanceId,
      controlPlaneInstanceId,
      resolveGovernedWait: async ({ event }) =>
        event.eventType === "item.completed"
          ? resolvePendingGovernedWait()
          : null,
      resolveMissingResult: async ({ terminalEvent }) => {
        // A model may correctly create a durable question/confirmation and
        // then end its provider turn without also invoking paperclip_finish.
        // Recover only completed turns with a pending interaction created by
        // this exact run; unrelated or failed turns still fail closed.
        if (terminalEvent.eventType !== "turn.completed") return null;
        return resolvePendingGovernedWait();
      },
      existingSession: existingWarmSession,
      persistedSession: persistedWarmSession,
      keepSessionOpen: warmSessionId !== null,
      onCheckpoint: warmSessionId !== null && warmConfigDigest !== null
        ? async (snapshot) => persistWarmNativeCheckpoint(warmSessionId, warmConfigDigest, snapshot)
        : undefined,
      onSession: (session) => {
        if (session && warmSessionId !== null && warmConfigDigest !== null) {
          const existing = warmNativeSessions.get(warmSessionId);
          if (existing) existing.session = session;
          else warmNativeSessions.set(warmSessionId, {
            session,
            configDigest: warmConfigDigest,
            busy: true,
            idleTimer: null,
            lastActivityAt: new Date().toISOString(),
          });
        }
        if (session) activeNativeSessions.set(input.execution.binding.runId, {
          session,
          cancelRequested: false,
        });
        else activeNativeSessions.delete(input.execution.binding.runId);
      },
    });
    activeNativeSessions.delete(input.execution.binding.runId);
  } catch (error) {
    activeNativeSessions.delete(input.execution.binding.runId);
    if (warmSessionId !== null && lifecyclePolicy.mode === "warm") {
      await releaseWarmNativeSession(warmSessionId, lifecyclePolicy.idleTimeoutMs, true);
    }
    const now = new Date();
    const { phase, failureCode, nextAttemptAt } = nativeSessionFailureDisposition(attempt, now);
    const recoveryProjection = nativeSessionRecoveryProjection({
      phase,
      failureCode,
      agentId: input.execution.binding.agentId,
    });
    const { exhausted } = recoveryProjection;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    const sourceFailureCode = nativeSessionFailureSourceCode(error);
    await input.db.transaction(async (tx) => {
      const updated = await tx.update(nativeRunFinalizations).set({
        phase,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode,
        failureDetail: {
          message,
          originalFailureCode: sourceFailureCode,
          recoveryOwner: recoveryProjection.recoveryOwner,
          nextAction: exhausted
            ? "Inspect the persisted native session after its bounded resume budget was exhausted."
            : "Resume this same run from its persisted native provider checkpoint after the retry delay.",
        },
        nextAttemptAt,
        updatedAt: now,
      }).where(and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.leaseOwner, leaseOwner),
      )).returning({ runId: nativeRunFinalizations.runId }).then((rows) => rows[0] ?? null);
      if (!updated) throw new Error("native_session_lease_lost");
      await tx.update(heartbeatRuns).set({
        nativePhase: phase,
        nativePhaseUpdatedAt: now,
        error: message,
        errorCode: sourceFailureCode,
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, input.execution.binding.runId));
      if (recoveryProjection.issueStatus) {
        await issueService(tx as unknown as Db).update(
          input.execution.binding.issueId,
          { status: recoveryProjection.issueStatus },
          tx,
        );
      }
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: input.execution.binding.companyId,
        sourceIssueId: input.execution.binding.issueId,
        kind: "active_run_watchdog",
        ownerType: recoveryProjection.recoveryActionOwnerType,
        ownerAgentId: recoveryProjection.recoveryActionOwnerAgentId,
        returnOwnerAgentId: input.execution.binding.agentId,
        cause: recoveryProjection.recoveryActionCause,
        fingerprint: createHash("sha256")
          .update(`${input.execution.binding.runId}:${failureCode}`)
          .digest("hex"),
        evidence: {
          runId: input.execution.binding.runId,
          coordinatorAttempt: attempt,
          sourceFailureCode,
          recoveryDisposition: failureCode,
        },
        nextAction: exhausted
          ? "Inspect the provider trace and explicitly choose a replacement run or provider configuration; automatic provider work is stopped."
          : "Resume the persisted native session on the same heartbeat run.",
        wakePolicy: nextAttemptAt
          ? { kind: "resume_native_run", runId: input.execution.binding.runId, notBefore: nextAttemptAt.toISOString() }
          : null,
        maxAttempts: 3,
        supersedeOnIdentityChange: recoveryProjection.supersedeOnIdentityChange,
      });
    });
    throw error;
  }
  if (
    planSynchronizations.length === 0
    && "executionMode" in input.execution
    && input.execution.executionMode === "plan"
  ) {
    const markdown = semanticProviderPlanMarkdown(native.result as unknown as Record<string, unknown>);
    if (markdown) {
      const digest = createHash("sha256").update(markdown).digest("hex");
      await recordPlanSynchronization({
        sourceEventId: `semantic-plan:${input.execution.binding.runId}:${digest}`,
        ...(native.turnId ? { turnId: native.turnId } : {}),
        eventType: "plan.updated",
        payload: {
          schema: "paperclip.plan.updated.v1",
          planId: `semantic:${native.turnId ?? input.execution.binding.runId}`,
          revision: 1,
          complete: true,
          markdown,
          source: "semantic_result_artifact",
        },
      });
    }
  }
  await input.db.update(nativeRunFinalizations).set({
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(nativeRunFinalizations.runId, input.execution.binding.runId),
    eq(nativeRunFinalizations.leaseOwner, leaseOwner),
  ));
  const finalization: NativeFinalizationResult = {
    schema: "paperclip.native-finalization.v1",
    runtimeMode: "native",
    runId: input.execution.binding.runId,
    issueId: input.execution.binding.issueId,
    companyId: input.execution.binding.companyId,
    result: native.result as unknown as Record<string, unknown>,
    terminal: native.terminal,
    turnId: native.turnId,
    sourceInstanceId: effectiveRunnerInstanceId,
    normalizedSessionId: native.normalizedSessionId,
    providerSessionId: native.providerSessionId,
    driverKind: native.driverKind,
    driverVersion: native.driverVersion,
    nativeEventCount: native.nativeEventCount,
    highestContiguousSourceSeq: native.highestContiguousSourceSeq,
    workspaceFinalizeStatus: "pending",
  };
  // A following run cannot attach until the prior run's durable finalization
  // is committed. Provider completion alone is not an authority boundary.
  if (warmSessionId !== null && lifecyclePolicy.mode === "warm") {
    await releaseWarmNativeSession(warmSessionId, lifecyclePolicy.idleTimeoutMs, false);
  }
  return {
    exitCode: native.terminal.runTerminalState === "succeeded" ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: native.terminal.runTerminalState === "succeeded"
      ? null
      : `Native session ${native.terminal.runTerminalState}`,
    resultJson: {
      nativeResult: native.result as unknown as Record<string, unknown>,
      nativeTerminal: native.terminal as unknown as Record<string, unknown>,
      planSynchronizations,
    },
    summary: native.result.summary,
    sessionId: native.normalizedSessionId,
    sessionDisplayId: native.providerSessionId ?? native.normalizedSessionId,
    provider: input.execution.provider.kind === "claude_managed"
      ? "anthropic"
      : input.execution.provider.kind === "aws_agentcore"
      ? "amazon-bedrock"
      : input.execution.provider.kind === "opencode"
      ? input.execution.provider.model?.split("/", 1)[0] ?? "opencode"
      : input.execution.provider.kind === "acpx"
      ? input.execution.provider.agent === "pi"
        ? "openrouter"
        : input.execution.provider.agent === "claude"
          ? "anthropic"
          : "openai"
      : "openai",
    model: input.execution.provider.model,
    usage: normalizeNativeUsage(native.usage),
    costUsd: numericUsageField(native.usage, ["providerCostUsd", "costUsd", "cost"]),
    usageBasis: "per_run",
    nativeFinalization: finalization,
  };
}

function numericUsageField(
  usage: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function normalizeNativeUsage(usage: Record<string, unknown> | null) {
  if (!usage) return undefined;
  const cache = record(usage.cache);
  const cachedInputTokens = numericUsageField(usage, ["cachedInputTokens", "cacheReadInputTokens"])
    ?? numericUsageField(cache, ["read"]);
  return {
    inputTokens: numericUsageField(usage, ["inputTokens", "input", "promptTokens"]) ?? 0,
    outputTokens: numericUsageField(usage, ["outputTokens", "output", "completionTokens"]) ?? 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

/** Production runnerd backend seam, exported so provider wiring can be regression tested. */
export function createRunnerdBackend(input: {
  db: Db;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  durableEnvironmentLeaseId?: string;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  runnerEnvironment?: NodeJS.ProcessEnv;
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment";
    triggerDetail: "system";
    reason: "issue_assigned";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "agent";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<unknown>;
}): NativeSessionBackend {
  const authority = new PaperclipRunnerToolAuthority(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    workMode: input.execution.task.workMode,
    acceptedPlanContinuation:
      input.execution.task.workMode === "planning"
      && "executionMode" in input.execution
      && input.execution.executionMode === "default",
    enqueueWakeup: input.enqueueWakeup,
  });
  const sessionId = nativeSessionKey(input.execution);
  const existingRouter = sessionToolRouters.get(sessionId);
  const authorityRouter = existingRouter ?? new SessionToolAuthorityRouter(authority);
  authorityRouter.bind(authority);
  sessionToolRouters.set(sessionId, authorityRouter);
  const root = runnerdStateRoot(input.execution);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return createNativeSessionBackend(input.execution, {
    runnerInstanceId: input.runnerInstanceId,
    onSpawn: input.onSpawn,
    dynamicTools: authorityRouter.definitions(),
    dynamicToolHandler: (call) => authorityRouter.execute(call),
    environment: input.runnerEnvironment ?? process.env,
    opencodeRuntimeDirectory: resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "opencode"),
    acpxRuntimeDirectory: resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "acpx"),
    codexTransportFactory: () => createRunnerdCodexTransport({
      provider: input.execution.provider.kind === "codex"
        ? "codex"
        : input.execution.provider.kind === "opencode"
          ? "opencode"
          : input.execution.provider.kind === "claude_managed"
            ? "claude_managed"
            : input.execution.provider.kind === "aws_agentcore"
              ? "aws_agentcore"
              : input.execution.provider.kind === "acpx"
                ? "acpx"
                : undefined,
      ...(input.execution.provider.kind === "acpx" ? {
        acpxAgent: input.execution.provider.agent,
        acpxRuntimeDirectory: resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "acpx"),
      } : {}),
      ...(input.execution.provider.kind === "claude_managed" ? {
        managedProfile: {
          ...input.execution.provider.managedProfile,
          maxSessionListCostUsd: input.execution.provider.maxSessionListCostUsd,
          model: input.execution.provider.model,
        },
      } : {}),
      ...(input.execution.provider.kind === "aws_agentcore" ? {
        agentCoreProfile: {
          ...input.execution.provider.agentCoreProfile,
          maxEstimatedSessionCostUsd: input.execution.provider.maxEstimatedSessionCostUsd,
          maxIterations: input.execution.provider.invocationLimits.maxIterations,
          maxOutputTokens: input.execution.provider.invocationLimits.maxOutputTokens,
          timeoutSeconds: input.execution.provider.invocationLimits.timeoutSeconds,
          model: input.execution.provider.model,
        },
      } : {}),
      stateDirectory: root,
      environment: input.runnerEnvironment ?? process.env,
      lifecyclePolicy: input.execution.session.lifecyclePolicy,
      runtimeContext: "runtimeContext" in input.execution ? input.execution.runtimeContext : null,
      resumeDynamicTools: authorityRouter.definitions(),
      prpIdentity: {
        runnerInstanceId: input.runnerInstanceId,
        environmentLeaseId: input.durableEnvironmentLeaseId ?? input.execution.binding.executionWorkspaceId,
        runId: input.execution.binding.runId,
        normalizedSessionId: input.execution.session.normalizedSessionId ?? `session-${input.execution.binding.runId}`,
        turnId: `turn-${input.execution.binding.runId}`,
        itemId: `item-${input.execution.binding.runId}`,
      },
      controlPlaneRegistration: (authority) => registerRunnerPrpAuthority({
        runId: input.execution.binding.runId,
        authority,
      }),
    }).transport,
  });
}
