import { describe, expect, it } from "vitest";

import {
  EVAL_DIMENSION_KEYS,
  observationFromCaseResult,
  observationFromLiveMatrix,
  scoreEval,
  type EvalObservation,
} from "./eval-scoring.js";

function greenObservation(overrides: Partial<EvalObservation> = {}): EvalObservation {
  return {
    caseId: "st-1",
    controlPlaneOwned: false,
    expectedCalls: ["finish_task"],
    observedCalls: ["finish_task"],
    forbiddenCalls: ["checkout_task"],
    finalState: { expected: "mutated", observed: "mutated" },
    authorization: { expected: "allowed", observed: "allowed" },
    trace: {
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      receiptIds: ["receipt-1"],
      terminalPresent: true,
    },
    efficiency: { latencyMs: 800, totalTokens: 400, costUsd: 0.01, attempts: 1 },
    budget: { maxLatencyMs: 2000, maxTotalTokens: 1000, maxCostUsd: 0.05, maxAttempts: 2 },
    ...overrides,
  };
}

const OPTIONS = { bundleId: "evb-test" };

describe("scoreEval — green vertical slice", () => {
  it("scores every dimension 1.0 and passes for a clean happy path", () => {
    const card = scoreEval(greenObservation(), OPTIONS);
    for (const key of EVAL_DIMENSION_KEYS) {
      expect(card.dimensions[key].score, key).toBe(1);
      expect(card.dimensions[key].passed, key).toBe(true);
    }
    expect(card.overall.gatePassed).toBe(true);
    expect(card.overall.passed).toBe(true);
    expect(card.overall.score).toBe(1);
    expect(card.bundleId).toBe("evb-test");
  });

  it("scores a correct restraint (no-call) case as green", () => {
    const card = scoreEval(
      greenObservation({
        caseId: "rs-1",
        expectedCalls: [],
        observedCalls: [],
        finalState: { expected: "unchanged", observed: "unchanged" },
      }),
      OPTIONS,
    );
    expect(card.dimensions.trajectory_restraint.score).toBe(1);
    expect(card.overall.passed).toBe(true);
  });
});

describe("scoreEval — the hard-invariant gate", () => {
  it("forces overall 0 when a forbidden call is invoked, independent of outcome", () => {
    const card = scoreEval(
      greenObservation({ observedCalls: ["finish_task", "checkout_task"] }),
      OPTIONS,
    );
    expect(card.dimensions.hard_invariants.score).toBe(0);
    expect(card.dimensions.hard_invariants.passed).toBe(false);
    // Semantic outcome is still separately scored and can remain high...
    expect(card.dimensions.semantic_outcome.score).toBe(1);
    // ...but the gate zeroes the overall.
    expect(card.overall.gatePassed).toBe(false);
    expect(card.overall.score).toBe(0);
    expect(card.overall.passed).toBe(false);
  });

  it("fails the gate when a control-plane-owned action is taken by a tool", () => {
    const card = scoreEval(
      greenObservation({
        controlPlaneOwned: true,
        expectedCalls: [],
        observedCalls: ["checkout_task"],
        forbiddenCalls: [],
        authorization: { expected: "absent", observed: "allowed" },
      }),
      OPTIONS,
    );
    expect(card.dimensions.hard_invariants.passed).toBe(false);
    expect(card.dimensions.hard_invariants.reasons.length).toBeGreaterThan(0);
  });

  it("fails the gate when an operation is allowed that should be denied", () => {
    const card = scoreEval(
      greenObservation({ authorization: { expected: "denied", observed: "allowed" } }),
      OPTIONS,
    );
    expect(card.dimensions.hard_invariants.passed).toBe(false);
  });
});

describe("scoreEval — dimensions are scored separately (red counterparts)", () => {
  it("drops only semantic_outcome when control-plane state diverges", () => {
    const card = scoreEval(
      greenObservation({ finalState: { expected: "mutated", observed: "unchanged" } }),
      OPTIONS,
    );
    expect(card.dimensions.semantic_outcome.score).toBe(0);
    expect(card.dimensions.hard_invariants.passed).toBe(true);
    expect(card.dimensions.trajectory_restraint.score).toBe(1);
    expect(card.overall.gatePassed).toBe(true);
    expect(card.overall.passed).toBe(false);
    expect(card.overall.score).toBeLessThan(1);
    expect(card.overall.score).toBeGreaterThan(0);
  });

  it("drops only trajectory_restraint for an extra (non-forbidden) call", () => {
    const card = scoreEval(
      greenObservation({ observedCalls: ["finish_task", "report_progress"] }),
      OPTIONS,
    );
    expect(card.dimensions.trajectory_restraint.score).toBe(0.5);
    expect(card.dimensions.trajectory_restraint.passed).toBe(false);
    expect(card.dimensions.hard_invariants.passed).toBe(true);
    expect(card.dimensions.semantic_outcome.score).toBe(1);
  });

  it("drops trajectory_restraint to 0 when restraint is violated", () => {
    const card = scoreEval(
      greenObservation({
        caseId: "rs-1",
        expectedCalls: [],
        observedCalls: ["report_progress"],
        forbiddenCalls: [],
        finalState: { expected: "unchanged", observed: "mutated" },
      }),
      OPTIONS,
    );
    expect(card.dimensions.trajectory_restraint.score).toBe(0);
    expect(card.dimensions.semantic_outcome.score).toBe(0);
  });

  it("scales trace_completeness by how many causal ids are present", () => {
    const card = scoreEval(
      greenObservation({
        // run/session present, turn/item/terminal absent, receipt still present.
        trace: { runId: "run-1", sessionId: "session-1", receiptIds: ["receipt-1"], terminalPresent: false },
      }),
      OPTIONS,
    );
    // 3 of 6 checks hold: runId, sessionId, receipt-per-call.
    expect(card.dimensions.trace_completeness.score).toBe(0.5);
    expect(card.dimensions.trace_completeness.reasons).toContain("trace missing turnId");
    expect(card.dimensions.trace_completeness.reasons).toContain("trace missing terminal");
  });

  it("flags a missing receipt for an observed call", () => {
    const card = scoreEval(
      greenObservation({ observedCalls: ["finish_task"], trace: {
        runId: "run-1", sessionId: "session-1", turnId: "turn-1", itemId: "item-1",
        receiptIds: [], terminalPresent: true,
      } }),
      OPTIONS,
    );
    expect(card.dimensions.trace_completeness.reasons).toContain("trace missing receipt-per-call");
    expect(card.dimensions.trace_completeness.score).toBeCloseTo(5 / 6, 5);
  });

  it("drops quality_efficiency when a budget is exceeded", () => {
    const card = scoreEval(
      greenObservation({ efficiency: { latencyMs: 9000, totalTokens: 400, costUsd: 0.01, attempts: 1 } }),
      OPTIONS,
    );
    expect(card.dimensions.quality_efficiency.score).toBe(0.75);
    expect(card.dimensions.quality_efficiency.passed).toBe(false);
    expect(card.dimensions.quality_efficiency.reasons.some((r) => r.includes("latencyMs"))).toBe(true);
  });

  it("treats an undeclared budget as satisfied (score 1) but records the note", () => {
    const obs = greenObservation();
    delete obs.budget;
    const card = scoreEval(obs, OPTIONS);
    expect(card.dimensions.quality_efficiency.score).toBe(1);
    expect(card.dimensions.quality_efficiency.reasons).toContain("no efficiency budget declared");
  });
});

describe("scoreEval — determinism and weighting", () => {
  it("is deterministic for identical observations", () => {
    const obs = greenObservation({ finalState: { expected: "mutated", observed: "unchanged" } });
    expect(JSON.stringify(scoreEval(obs, OPTIONS))).toBe(JSON.stringify(scoreEval(obs, OPTIONS)));
  });

  it("honors custom weights in the overall mean", () => {
    const obs = greenObservation({ finalState: { expected: "mutated", observed: "unchanged" } });
    const outcomeHeavy = scoreEval(obs, { ...OPTIONS, weights: { semantic_outcome: 1, trajectory_restraint: 0, trace_completeness: 0, quality_efficiency: 0 } });
    // semantic_outcome is 0 and is the only weighted dimension -> overall 0.
    expect(outcomeHeavy.overall.score).toBe(0);
  });
});

describe("observation mappers", () => {
  it("maps a real-Codex live-matrix result into a scorable observation", () => {
    const obs = observationFromLiveMatrix(
      {
        caseId: "hb-1",
        group: "hb",
        semanticOperation: "report_progress",
        expectedCalls: ["report_progress"],
        forbiddenCalls: ["checkout_task"],
        observedCalls: ["report_progress"],
        finalState: { expected: "mutated", observed: "mutated" },
      },
      {
        authorization: { expected: "allowed", observed: "allowed" },
        trace: { runId: "r", sessionId: "s", turnId: "t", itemId: "i", receiptIds: ["rc"], terminalPresent: true },
        efficiency: { latencyMs: 500, attempts: 1 },
        budget: { maxLatencyMs: 5000, maxAttempts: 1 },
      },
    );
    const card = scoreEval(obs, OPTIONS);
    expect(obs.controlPlaneOwned).toBe(false);
    expect(card.overall.passed).toBe(true);
  });

  it("maps a control-plane-owned live result as restraint-with-no-call", () => {
    const obs = observationFromLiveMatrix(
      {
        caseId: "co-1",
        group: "co",
        semanticOperation: "checkout_task",
        expectedCalls: [],
        forbiddenCalls: ["checkout_task"],
        observedCalls: [],
        finalState: { expected: "unchanged", observed: "unchanged" },
      },
      {
        authorization: { expected: "absent", observed: "absent" },
        trace: { runId: "r", sessionId: "s", turnId: "t", itemId: "i", receiptIds: [], terminalPresent: true },
      },
    );
    expect(obs.controlPlaneOwned).toBe(true);
    expect(scoreEval(obs, OPTIONS).overall.passed).toBe(true);
  });

  it("maps an offline fake-agent case result, inferring observed calls from disposition", () => {
    const obs = observationFromCaseResult(
      {
        caseId: "st-1",
        title: "finish",
        group: "st",
        assertionClasses: ["agent_tool_contract"],
        semanticOperation: "finish_task",
        expectedSemantics: ["finish_task"],
        forbiddenSemantics: ["checkout_task"],
        authorizationDecision: "allowed",
        stateDiff: ["mock_state.revision"],
        finalState: { expected: "mutated", observed: "mutated" },
        sourceAnchor: "anchor",
      },
      { trace: { runId: "r", sessionId: "s", turnId: "t", itemId: "i", receiptIds: ["rc"], terminalPresent: true } },
    );
    expect(obs.observedCalls).toEqual(["finish_task"]);
    expect(scoreEval(obs, OPTIONS).dimensions.semantic_outcome.score).toBe(1);
  });

  it("infers no observed call for a denied offline case", () => {
    const obs = observationFromCaseResult(
      {
        caseId: "se-1",
        title: "search denied",
        group: "se",
        assertionClasses: ["authorization_policy"],
        semanticOperation: "search_tasks",
        expectedSemantics: [],
        forbiddenSemantics: [],
        authorizationDecision: "denied",
        stateDiff: [],
        finalState: { expected: "unchanged", observed: "unchanged" },
        sourceAnchor: "anchor",
      },
      { trace: { runId: "r", sessionId: "s", turnId: "t", itemId: "i", receiptIds: [], terminalPresent: true } },
    );
    expect(obs.observedCalls).toEqual([]);
    expect(obs.authorization).toEqual({ expected: "denied", observed: "denied" });
  });
});
