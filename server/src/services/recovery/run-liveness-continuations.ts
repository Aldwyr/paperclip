import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { issueExecutionStateSchema, type RunLivenessState } from "@paperclipai/shared";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import { RECOVERY_REASON_KINDS } from "./origins.js";

export const RUN_LIVENESS_CONTINUATION_REASON = RECOVERY_REASON_KINDS.runLivenessContinuation;
export const DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2;

const ACTIONABLE_LIVENESS_STATES = new Set<RunLivenessState>(["plan_only", "empty_response"]);
const CORRECTION_LIVENESS_STATES = new Set<RunLivenessState>([
  "plan_only",
  "empty_response",
  "needs_followup",
]);
const CONTINUATION_ACTIVE_ISSUE_STATUSES = new Set(["todo", "in_progress"]);
// A prior adapter error should not permanently suppress bounded liveness
// continuations; the max-attempt/idempotency guards prevent unbounded retries.
const CONTINUATION_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);
const IDEMPOTENT_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "executionState" | "projectId"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

export type RunContinuationDecision =
  | {
      kind: "enqueue";
      nextAttempt: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | {
      kind: "exhausted";
      attempt: number;
      maxAttempts: number;
      comment: string;
      requiresVisibleRecovery: boolean;
    }
  | {
      kind: "skip";
      reason: string;
    };

export function readContinuationAttempt(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function executionPrincipalMatches(
  value: unknown,
  expected: { type: "agent" | "user"; agentId?: string | null; userId?: string | null },
) {
  const candidate = readRecord(value);
  return candidate.type === expected.type &&
    (candidate.agentId ?? null) === (expected.agentId ?? null) &&
    (candidate.userId ?? null) === (expected.userId ?? null);
}

function reviewRequestMatches(value: unknown, expected: { instructions: string }) {
  const candidate = readRecord(value);
  return candidate.instructions === expected.instructions && Object.keys(candidate).length === 1;
}

function allowedCorrectionActionsMatch(value: unknown) {
  return Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "address_changes" &&
    value[1] === "resubmit";
}

export function resolveBoundedChangesRequestedCorrection(input: {
  run: Pick<HeartbeatRunRow, "agentId" | "contextSnapshot" | "continuationAttempt">;
  issue: Pick<IssueRow, "assigneeAgentId" | "executionState">;
  livenessState: RunLivenessState | null;
  correctionContinuationSourceVerified?: boolean;
}) {
  if (!input.livenessState || !CORRECTION_LIVENESS_STATES.has(input.livenessState)) return null;
  if (input.issue.assigneeAgentId !== input.run.agentId) return null;

  const parsedState = issueExecutionStateSchema.safeParse(input.issue.executionState);
  if (!parsedState.success) return null;
  const state = parsedState.data;
  if (
    state.status !== "changes_requested" ||
    state.lastDecisionOutcome !== "changes_requested" ||
    !state.lastDecisionId ||
    !state.currentStageId ||
    !state.currentStageType ||
    !state.currentParticipant ||
    state.returnAssignee?.type !== "agent" ||
    state.returnAssignee.agentId !== input.run.agentId ||
    !state.reviewRequest
  ) {
    return null;
  }

  const context = readRecord(input.run.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const contextStage = readRecord(context.executionStage);
  const isInitialCorrection =
    wakeReason === "execution_changes_requested" &&
    readNonEmptyString(context.source) === "issue.execution_stage";
  const sourceRunId = readNonEmptyString(context.livenessContinuationSourceRunId);
  const isBoundedContinuation =
    wakeReason === RUN_LIVENESS_CONTINUATION_REASON &&
    context.boundedChangesRequestedCorrection === true &&
    input.correctionContinuationSourceVerified === true &&
    readContinuationAttempt(input.run.continuationAttempt) === 1 &&
    Boolean(sourceRunId) &&
    readNonEmptyString(context.resumeFromRunId) === sourceRunId &&
    readContinuationAttempt(context.livenessContinuationAttempt) === 1 &&
    readContinuationAttempt(context.livenessContinuationMaxAttempts) === 1;
  if (!isInitialCorrection && !isBoundedContinuation) return null;
  if (
    readNonEmptyString(contextStage.wakeRole) !== "executor" ||
    readNonEmptyString(contextStage.stageId) !== state.currentStageId ||
    readNonEmptyString(contextStage.stageType) !== state.currentStageType ||
    readNonEmptyString(contextStage.decisionId) !== state.lastDecisionId ||
    !executionPrincipalMatches(contextStage.currentParticipant, state.currentParticipant) ||
    !executionPrincipalMatches(contextStage.returnAssignee, state.returnAssignee) ||
    !reviewRequestMatches(contextStage.reviewRequest, state.reviewRequest) ||
    readNonEmptyString(contextStage.lastDecisionOutcome) !== state.lastDecisionOutcome ||
    !allowedCorrectionActionsMatch(contextStage.allowedActions)
  ) {
    return null;
  }

  return {
    wakeRole: "executor" as const,
    stageId: state.currentStageId,
    stageType: state.currentStageType,
    decisionId: state.lastDecisionId,
    currentParticipant: state.currentParticipant,
    returnAssignee: state.returnAssignee,
    reviewRequest: state.reviewRequest,
    lastDecisionOutcome: state.lastDecisionOutcome,
    allowedActions: ["address_changes", "resubmit"],
  };
}

export function buildRunLivenessContinuationIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  livenessState: RunLivenessState;
  nextAttempt: number;
}) {
  return [
    RUN_LIVENESS_CONTINUATION_REASON,
    input.issueId,
    input.sourceRunId,
    input.livenessState,
    String(input.nextAttempt),
  ].join(":");
}

export async function findExistingRunLivenessContinuationWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function decideRunLivenessContinuation(input: {
  run: HeartbeatRunRow;
  issue: IssueRow | null;
  agent: AgentRow | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  nextAction: string | null;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  correctionContinuationSourceVerified?: boolean;
  maxAttempts?: number;
}): RunContinuationDecision {
  const {
    run,
    issue,
    agent,
    livenessState,
    livenessReason,
    nextAction,
    budgetBlocked,
    idempotentWakeExists,
  } = input;
  if (!livenessState) return { kind: "skip", reason: "liveness state is not actionable for continuation" };
  if (!issue) return { kind: "skip", reason: "issue not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (issue.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (issue.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "issue is no longer assigned to the source run agent" };
  }
  if (!CONTINUATION_ACTIVE_ISSUE_STATUSES.has(issue.status)) {
    return { kind: "skip", reason: `issue status ${issue.status} is not continuable` };
  }
  const correctionContext = resolveBoundedChangesRequestedCorrection({
    run,
    issue,
    livenessState,
    correctionContinuationSourceVerified: input.correctionContinuationSourceVerified,
  });
  if (!ACTIONABLE_LIVENESS_STATES.has(livenessState) && !correctionContext) {
    return { kind: "skip", reason: "liveness state is not actionable for continuation" };
  }
  if (issue.executionState && !correctionContext) {
    return { kind: "skip", reason: "issue is blocked by execution policy state" };
  }
  if (!CONTINUATION_AGENT_STATUSES.has(agent.status)) {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (budgetBlocked) {
    return { kind: "skip", reason: "budget hard stop blocks continuation" };
  }
  const maxAttempts = correctionContext
    ? 1
    : input.maxAttempts ?? DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS;
  const currentAttempt = readContinuationAttempt(run.continuationAttempt);
  if (currentAttempt >= maxAttempts) {
    return {
      kind: "exhausted",
      attempt: currentAttempt,
      maxAttempts,
      requiresVisibleRecovery: Boolean(correctionContext),
      comment: [
        "Bounded liveness continuation exhausted",
        "",
        `- Last liveness state: \`${livenessState}\``,
        `- Attempts used: ${currentAttempt}/${maxAttempts}`,
        `- Reason: ${livenessReason ?? "Run ended without concrete progress"}`,
        correctionContext
          ? "- Next action: Paperclip blocked the issue and opened a board-owned recovery action; no further automatic correction run will be started."
          : "- Next action: a human or manager should inspect the run and either clarify the task, mark it blocked, or assign a concrete follow-up.",
      ].join("\n"),
    };
  }

  const nextAttempt = currentAttempt + 1;
  const idempotencyKey = buildRunLivenessContinuationIdempotencyKey({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    nextAttempt,
  });
  if (idempotentWakeExists) {
    return { kind: "skip", reason: "continuation wake already exists for this source run and attempt" };
  }

  const instruction = correctionContext
    ? `Apply the requested changes now and resubmit the same issue for review. Review request: ${correctionContext.reviewRequest.instructions}`
    : nextAction ??
      "The previous run ended without concrete progress. Take the first concrete action now or mark the issue blocked with a specific unblock request.";
  const correctionPayload = correctionContext
    ? {
        boundedChangesRequestedCorrection: true,
        resumeIntent: true,
        followUpRequested: true,
        resumeFromRunId: run.id,
        executionStage: correctionContext,
      }
    : {};
  const payload = withRecoveryModelProfileHint({
    issueId: issue.id,
    sourceRunId: run.id,
    livenessState,
    livenessReason,
    continuationAttempt: nextAttempt,
    maxContinuationAttempts: maxAttempts,
    ...correctionPayload,
    instruction,
  }, "normal_model");

  return {
    kind: "enqueue",
    nextAttempt,
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryModelProfileHint({
      issueId: issue.id,
      taskId: issue.id,
      taskKey: issue.id,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: nextAttempt,
      livenessContinuationMaxAttempts: maxAttempts,
      livenessContinuationSourceRunId: run.id,
      livenessContinuationState: livenessState,
      livenessContinuationReason: livenessReason,
      livenessContinuationInstruction: payload.instruction,
      ...correctionPayload,
    }, "normal_model"),
  };
}
