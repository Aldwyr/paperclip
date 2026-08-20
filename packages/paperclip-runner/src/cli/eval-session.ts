#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { projectCapabilityDevtools } from "../devtools/index.js";
import { PAPERCLIP_RUNNER_BUILD_METADATA } from "../evals/build-metadata.js";
import { estimateModelCostNanodollars } from "../evals/model-pricing.js";
import { projectCapabilityIssueThread } from "../issue-thread/live-projection.js";
import {
  CapabilityLiveSessionService,
  reconcileCapabilityLiveUsage,
  type CreateCapabilityLiveSessionInput,
} from "../live/live-session.js";

interface EvalSessionRequest {
  schema: "paperclip-runner/eval-session-request/v1";
  attemptId: string;
  prompt: string;
  model: string;
  runnerd: { path: string; sha256: string };
  limits: { turnTimeoutMs: number; maxAgentTurns: number; maxEstimatedCostNanodollars: number };
  session: CreateCapabilityLiveSessionInput;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const requestPath = argument("--request");
const outputPath = argument("--output");
const request = JSON.parse(await readFile(requestPath, "utf8")) as EvalSessionRequest;
if (request.schema !== "paperclip-runner/eval-session-request/v1") throw new Error("unsupported request schema");
const runnerdPath = resolve(request.runnerd.path);
const actualDigest = await sha256(runnerdPath);
if (actualDigest !== request.runnerd.sha256.replace(/^sha256:/, "")) {
  throw new Error(`runnerd digest mismatch: expected ${request.runnerd.sha256}, got sha256:${actualDigest}`);
}

const service = new CapabilityLiveSessionService({ transportOptions: { runnerBinary: runnerdPath } });
let sessionId: string | null = null;
try {
  const session = await service.create({
    ...request.session,
    attemptId: request.attemptId,
    runId: request.session.runId ?? request.attemptId,
    requestedModel: request.model,
    turnTimeoutMs: request.limits.turnTimeoutMs,
  });
  sessionId = session.id;
  const turn = await session.sendMessage(request.prompt);
  await session.completeAttempt(turn.status === "completed" ? "succeeded" : "failed", `turn_${turn.status}`);
  const snapshot = session.snapshot();
  const reconciled = reconcileCapabilityLiveUsage(snapshot);
  if ((snapshot.usageLedger ?? []).length === 0) throw new Error("completed turn omitted usage accounting");
  const estimate = estimateModelCostNanodollars(request.model, reconciled);
  const usage = {
    agentTurns: reconciled.providerCalls,
    providerRequests: reconciled.providerRequests,
    inputTokens: reconciled.inputTokens,
    outputTokens: reconciled.outputTokens,
    cachedInputTokens: reconciled.cachedInputTokens,
    reasoningTokens: reconciled.reasoningTokens,
    ...estimate,
  };
  if (usage.agentTurns > request.limits.maxAgentTurns) throw new Error("agent turn limit exceeded");
  if (usage.estimatedCostNanodollars > request.limits.maxEstimatedCostNanodollars) throw new Error("estimated cost limit exceeded");
  await writeFile(outputPath, `${JSON.stringify({
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId: request.attemptId,
    build: PAPERCLIP_RUNNER_BUILD_METADATA,
    runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
    requestedModel: request.model,
    turn,
    snapshot,
    devtools: projectCapabilityDevtools(snapshot),
    issueThread: projectCapabilityIssueThread({ snapshot, mode: "live", replaySource: "live" }),
    usage,
  }, null, 2)}\n`);
} catch (error) {
  await writeFile(outputPath, `${JSON.stringify({
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId: request.attemptId,
    infrastructureError: error instanceof Error ? error.message : String(error),
    build: PAPERCLIP_RUNNER_BUILD_METADATA,
    runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
    requestedModel: request.model,
  }, null, 2)}\n`);
  process.exitCode = 2;
} finally {
  if (sessionId !== null) await service.shutdown(sessionId).catch(() => undefined);
}
