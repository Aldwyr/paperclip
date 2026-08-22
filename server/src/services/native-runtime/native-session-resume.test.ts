import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { rebindNativeSessionCheckpoint } from "./native-session-resume.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
const previousRunId = "40000000-0000-4000-8000-000000000004";
const currentRunId = "50000000-0000-4000-8000-000000000005";
const normalizedSessionId = "60000000-0000-4000-8000-000000000006";

function execution(runId: string, cwd = "/workspace") {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: { id: issueId, identifier: "DOT-2", title: "Test", description: null, workMode: "standard" },
    taskPrompt: "Only the current turn",
    agentId,
    workspace: { id: runId, cwd, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId,
    provider: "codex",
    completionContract: {
      id: "70000000-0000-4000-8000-000000000007",
      sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1",
      contract: {
        revision: "1",
        objective: "Test session resumption",
        criteria: [{ id: "objective", requirement: "Answer the current turn" }],
      },
    },
  });
}

function planningExecution(runId: string, revisionId: string) {
  return buildNativeExecutionInput({
    companyId,
    runId,
    issue: { id: issueId, identifier: "DOT-2", title: "Test", description: null, workMode: "planning" },
    taskPrompt: "Revise the plan",
    agentId,
    workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId,
    provider: "codex",
    executionMode: "plan",
    planningContext: {
      documentId: "80000000-0000-4000-8000-000000000008",
      baseRevisionId: revisionId,
      baseRevisionNumber: revisionId.endsWith("9") ? 9 : 8,
      markdown: `Plan at ${revisionId}`,
      sha256: `sha256:${"b".repeat(64)}`,
      reviewContext: {},
    },
    completionContract: execution(runId).completionContract,
  });
}

function previousRun(overrides: Record<string, unknown> = {}) {
  return {
    id: previousRunId,
    companyId,
    agentId,
    nativeSessionId: normalizedSessionId,
    runnerProfileJson: {
      nativeExecutionInput: execution(previousRunId),
      sessionCheckpoint: {
        backendKind: "runner",
        driverKind: "codex_app_server",
        sessionId: "provider-thread-123",
        providerSessionId: "provider-thread-123",
        cursor: "42",
        identity: { runId: previousRunId, sessionId: normalizedSessionId, companyId, issueId, agentId },
        semanticResult: { schema: "paperclip.run-result.v1", reportedWorkDisposition: "done", summary: "old" },
        terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" },
        activeTurnId: "old-turn",
        terminalTurns: [{ turnId: "old-turn", state: "completed" }],
        pendingRuntimeRequests: [{ requestId: "old-request" }],
        lineage: [{ threadId: "provider-thread-123" }],
      },
      ...overrides,
    },
  };
}

describe("rebindNativeSessionCheckpoint", () => {
  it("retains provider identity but clears prior turn and event state", () => {
    const rebound = rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: execution(currentRunId),
    });
    expect(rebound).toMatchObject({
      sessionId: "provider-thread-123",
      providerSessionId: "provider-thread-123",
      driverKind: "codex_app_server",
      cursor: null,
      semanticResult: null,
      terminal: null,
      activeTurnId: null,
      terminalTurns: [],
      pendingRuntimeRequests: [],
      identity: { runId: currentRunId, sessionId: normalizedSessionId, companyId, issueId, agentId },
    });
  });

  it("refuses to resume when the workspace changes", () => {
    expect(rebindNativeSessionCheckpoint({
      previousRun: previousRun(),
      currentExecution: execution(currentRunId, "/different-workspace"),
    })).toBeNull();
  });

  it("refuses a checkpoint whose prior-run binding was rewritten", () => {
    const source = previousRun();
    const profile = source.runnerProfileJson as Record<string, unknown>;
    const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
    checkpoint.identity = { ...(checkpoint.identity as Record<string, unknown>), runId: currentRunId };
    expect(rebindNativeSessionCheckpoint({ previousRun: source, currentExecution: execution(currentRunId) })).toBeNull();
  });

  it("reuses plan mode across canonical revisions but never across a mode change", () => {
    const source = previousRun({ nativeExecutionInput: planningExecution(previousRunId, "revision-8") });
    expect(rebindNativeSessionCheckpoint({
      previousRun: source,
      currentExecution: planningExecution(currentRunId, "revision-9"),
    })).not.toBeNull();
    expect(rebindNativeSessionCheckpoint({
      previousRun: source,
      currentExecution: execution(currentRunId),
    })).toBeNull();
  });
});
