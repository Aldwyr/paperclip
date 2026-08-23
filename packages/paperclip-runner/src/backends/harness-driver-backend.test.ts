import { describe, expect, it } from "vitest";

import type { HarnessDriver, HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent, PrpStructuredRunResult } from "../protocol/replay-contract.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Backend adapter completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "fake", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const providerIdentity = {
  kind: "acpx" as const,
  normalizedSessionId: "session-1",
  acpxRecordId: "driver-1",
  backendSessionId: "backend-1",
  agentSessionId: "provider-1",
  profileDigest: "sha256:profile",
  workspaceDigest: "sha256:workspace",
  requestedModel: "claude-sonnet-4-20250514",
  effectiveModel: "claude-sonnet-4-20250514",
};

function prpEvent(sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `fake:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "fake",
    sourceKind: "runner",
    runId: "run-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: `2026-08-09T00:00:0${sourceSeq}.000Z`,
    payload,
  };
}

const runtimeResolutions: unknown[] = [];

class FakeHarnessSession implements HarnessSession {
  ids() { return { driverSessionId: "driver-1", providerSessionId: "provider-1" }; }
  async *events() {
    yield prpEvent(1, "run.result.proposed", result);
    yield prpEvent(2, "turn.completed", { status: "completed" });
  }
  async startTurn() { return { turnId: "turn-1" }; }
  async resolveRuntimeRequest(input: unknown) {
    runtimeResolutions.push(structuredClone(input));
  }
  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "fake",
      driverSessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      semanticResult: { result, fingerprint: "fingerprint", turnId: "turn-1" },
      lastSourceSequence: 2,
    };
  }
  async close() {}
}

const driver: HarnessDriver = {
  async descriptor() {
    return {
      kind: "fake",
      displayName: "Fake harness",
      version: "1",
      capabilities: {
        resume: false,
        typedEvents: true,
        steering: false,
        interruption: false,
        structuredResult: true,
      },
    };
  },
  async openSession() { return new FakeHarnessSession(); },
};

describe("HarnessDriverBackend", () => {
  it("normalizes harness events, result, terminal, and snapshot", async () => {
    const backend = new HarnessDriverBackend(driver);
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toHaveLength(2);
    await expect(session.result()).resolves.toMatchObject({ result, turnId: "turn-1", terminal: { runTerminalState: "succeeded" } });
    await expect(session.snapshot()).resolves.toMatchObject({
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
    });
  });

  it("passes the persisted harness driver kind through recovery", async () => {
    let recoveredDriverKind: string | null = null;
    let recoveredProviderIdentity: PersistedHarnessSession["providerIdentity"];
    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession(snapshot) {
        recoveredDriverKind = snapshot.driverKind;
        recoveredProviderIdentity = snapshot.providerIdentity;
        return { recovered: true, session: new FakeHarnessSession() };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      identity: { runId: "run-2", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
    });
    expect(recovery.recovered).toBe(true);
    expect(recoveredDriverKind).toBe("fake");
    expect(recoveredProviderIdentity).toEqual(providerIdentity);
  });

  it("delegates native runtime-request resolutions to the harness session", async () => {
    runtimeResolutions.length = 0;
    const backend = new HarnessDriverBackend(driver);
    const session = await backend.openSession({
      identity: {
        runId: "run-1",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      workingDirectory: "/workspace",
    });

    await session.resolveRuntimeRequest?.({
      requestId: "permission-1",
      turnId: "turn-1",
      resolution: { action: "accept_for_session" },
    });

    expect(runtimeResolutions).toEqual([
      {
        requestId: "permission-1",
        turnId: "turn-1",
        resolution: { action: "accept_for_session" },
      },
    ]);
  });
});
