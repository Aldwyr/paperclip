import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  RUN_LIVENESS_CONTINUATION_REASON,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
} from "../services/run-continuations.ts";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";
const runId = "run-1";
const correctionAgentId = "11111111-1111-4111-8111-111111111111";
const correctionStageId = "22222222-2222-4222-8222-222222222222";
const correctionDecisionId = "33333333-3333-4333-8333-333333333333";

const correctionStage = {
  wakeRole: "executor",
  stageId: correctionStageId,
  stageType: "review",
  currentParticipant: { type: "user", agentId: null, userId: "local-board" },
  returnAssignee: { type: "agent", agentId: correctionAgentId, userId: null },
  reviewRequest: { instructions: "Apply the requested correction." },
  decisionId: correctionDecisionId,
  lastDecisionOutcome: "changes_requested",
  allowedActions: ["address_changes", "resubmit"],
} as const;

function correctionRun(
  contextOverrides: Record<string, unknown> = {},
  runOverrides: Record<string, unknown> = {},
) {
  return run({
    agentId: correctionAgentId,
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "execution_changes_requested",
      source: "issue.execution_stage",
      executionStage: correctionStage,
      ...contextOverrides,
    },
    ...runOverrides,
  });
}

function correctionIssue() {
  return issue({
    assigneeAgentId: correctionAgentId,
    executionState: {
      status: "changes_requested",
      currentStageId: correctionStageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: correctionStage.currentParticipant,
      returnAssignee: correctionStage.returnAssignee,
      reviewRequest: correctionStage.reviewRequest,
      completedStageIds: [],
      lastDecisionId: correctionDecisionId,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
    },
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId,
    agentId,
    continuationAttempt: 0,
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-1577",
    title: "Add bounded liveness continuation wakes",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionState: null,
    projectId: null,
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    status: "idle",
    ...overrides,
  } as never;
}

describe("run liveness continuations", () => {
  it("enqueues the first plan_only continuation for the same issue and assignee", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action now.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildRunLivenessContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        livenessState: "plan_only",
        nextAttempt: 1,
      }),
    );
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      continuationAttempt: 1,
      maxContinuationAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      instruction: "Take the first concrete action now.",
    });
    expect(decision.payload).not.toHaveProperty("modelProfile");
    expect(decision.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: 1,
      livenessContinuationMaxAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      livenessContinuationSourceRunId: runId,
      livenessContinuationState: "plan_only",
      livenessContinuationReason: "Planned without acting",
      livenessContinuationInstruction: "Take the first concrete action now.",
    });
    expect(decision.contextSnapshot).not.toHaveProperty("modelProfile");
  });

  it("enqueues the second empty_response continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(2);
  });

  it("leaves advanced terminal runs to stranded issue recovery instead of bounded liveness continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: created an issue comment",
      nextAction: "Resume the implementation from the remaining acceptance criteria.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });

  it("enqueues one advanced correction when the exact changes-requested workflow state is unchanged", () => {
    const decision = decideRunLivenessContinuation({
      run: correctionRun(),
      issue: correctionIssue(),
      agent: agent({ id: correctionAgentId }),
      livenessState: "advanced",
      livenessReason: "Run produced incidental comment and tool activity without resubmitting",
      nextAction: "Apply the requested correction and resubmit.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      livenessState: "advanced",
      continuationAttempt: 1,
      maxContinuationAttempts: 1,
      boundedChangesRequestedCorrection: true,
    });
  });

  it("does not enqueue a third continuation and returns an exhaustion comment", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 2 }),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Still planning",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.comment).toContain("Bounded liveness continuation exhausted");
    expect(decision.comment).toContain("Attempts used: 2/2");
  });

  it("skips non-actionable and guarded issues", () => {
    const guardedCases = [
      { livenessState: "advanced" as const },
      { issue: issue({ status: "done" }) },
      { issue: issue({ assigneeAgentId: "other-agent" }) },
      { issue: issue({ executionState: { status: "pending" } }) },
      { agent: agent({ status: "paused" }) },
      { budgetBlocked: true },
      { idempotentWakeExists: true },
    ];

    for (const guarded of guardedCases) {
      const decision = decideRunLivenessContinuation({
        run: run(),
        issue: guarded.issue ?? issue(),
        agent: guarded.agent ?? agent(),
        livenessState: guarded.livenessState ?? "plan_only",
        livenessReason: "No progress",
        nextAction: null,
        budgetBlocked: guarded.budgetBlocked ?? false,
        idempotentWakeExists: guarded.idempotentWakeExists ?? false,
      });

      expect(decision.kind).toBe("skip");
    }
  });

  it.each([
    ["decision id", { decisionId: "44444444-4444-4444-8444-444444444444" }],
    ["current participant", { currentParticipant: { type: "user", agentId: null, userId: "other-user" } }],
    ["return assignee", { returnAssignee: { type: "agent", agentId: "55555555-5555-4555-8555-555555555555", userId: null } }],
    ["review request", { reviewRequest: { instructions: "A stale correction request." } }],
    ["decision outcome", { lastDecisionOutcome: "approved" }],
    ["allowed actions", { allowedActions: ["address_changes"] }],
  ])("rejects a changes-requested wake with a mismatched %s", (_label, stageOverride) => {
    const decision = decideRunLivenessContinuation({
      run: correctionRun({
        executionStage: { ...correctionStage, ...stageOverride },
      }),
      issue: correctionIssue(),
      agent: agent({ id: correctionAgentId }),
      livenessState: "needs_followup",
      livenessReason: "No concrete correction evidence",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("skip");
  });

  it.each([
    ["missing resume link", { resumeFromRunId: undefined }],
    ["wrong resume link", { resumeFromRunId: "wrong-run" }],
    ["wrong liveness source", { livenessContinuationSourceRunId: "wrong-run" }],
    ["wrong context attempt", { livenessContinuationAttempt: 2 }],
  ])("rejects an unverified correction continuation with a %s", (_label, contextOverride) => {
    const decision = decideRunLivenessContinuation({
      run: correctionRun({
        wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
        boundedChangesRequestedCorrection: true,
        resumeFromRunId: runId,
        livenessContinuationSourceRunId: runId,
        livenessContinuationAttempt: 1,
        livenessContinuationMaxAttempts: 1,
        ...contextOverride,
      }, {
        continuationAttempt: 1,
      }),
      issue: correctionIssue(),
      agent: agent({ id: correctionAgentId }),
      livenessState: "needs_followup",
      livenessReason: "No concrete correction evidence",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      correctionContinuationSourceVerified: true,
    });

    expect(decision.kind).toBe("skip");
  });

  it("rejects a correction continuation without verified source provenance", () => {
    const decision = decideRunLivenessContinuation({
      run: correctionRun({
        wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
        boundedChangesRequestedCorrection: true,
        resumeFromRunId: runId,
        livenessContinuationSourceRunId: runId,
        livenessContinuationAttempt: 1,
        livenessContinuationMaxAttempts: 1,
      }, {
        continuationAttempt: 1,
      }),
      issue: correctionIssue(),
      agent: agent({ id: correctionAgentId }),
      livenessState: "needs_followup",
      livenessReason: "No concrete correction evidence",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("skip");
  });
});
