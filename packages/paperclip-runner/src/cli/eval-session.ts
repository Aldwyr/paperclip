#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { projectCapabilityDevtools } from "../devtools/index.js";
import { PAPERCLIP_RUNNER_BUILD_METADATA } from "../evals/build-metadata.js";
import { estimateModelCostNanodollars } from "../evals/model-pricing.js";
import { projectCapabilityIssueThread } from "../issue-thread/live-projection.js";
import {
  DurableEvalInfrastructureError,
  runDurableEvalSession,
} from "../mock-core/durable-recovery.js";
import {
  reconcileCapabilityLiveUsage,
  type CreateCapabilityLiveSessionInput,
} from "../live/live-session.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";

interface EvalSessionRequest {
  schema: "paperclip-runner/eval-session-request/v1";
  attemptId: string;
  prompt: string;
  model: string;
  provider?: "codex" | "opencode" | "aws_agentcore" | "acpx";
  driver?: "codex_app_server" | "opencode_server" | "aws_agentcore_harness_api" | "acpx_runtime";
  opencodeVersion?: string;
  acpxAgent?: QualifiedAcpxAgent;
  agentCoreProfile?: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    qualificationRevision: string;
    eventExpiryDays: 90;
    maxEstimatedSessionCostUsd: number;
    maxIterations: number;
    maxOutputTokens: number;
    timeoutSeconds: number;
  };
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
const acpxProfile = request.provider === "acpx"
  ? resolveQualifiedAcpxProfile(request.acpxAgent ?? "pi", request.model)
  : null;
const evalStartedAt = new Date().toISOString();
const evalStartedAtMs = Date.now();
if (request.schema !== "paperclip-runner/eval-session-request/v1") throw new Error("unsupported request schema");
const runnerdPath = resolve(request.runnerd.path);
const actualDigest = await sha256(runnerdPath);

function infrastructureCategory(failureClass: string): string {
  if (failureClass === "provider_turn_timeout") return "provider_lifecycle";
  if (failureClass === "runner_shutdown_timeout") return "runner_lifecycle";
  if (failureClass === "runner_exit_failure") return "runner_infrastructure";
  return "eval_orchestration";
}
if (actualDigest !== request.runnerd.sha256.replace(/^sha256:/, "")) {
  throw new Error(`runnerd digest mismatch: expected ${request.runnerd.sha256}, got sha256:${actualDigest}`);
}

try {
  const execution = await runDurableEvalSession({
    attemptId: request.attemptId,
    prompt: request.prompt,
    model: request.model,
    provider: request.provider ?? "codex",
    acpxAgent: request.acpxAgent,
    opencodeVersion: request.opencodeVersion,
    agentCoreProfile: request.agentCoreProfile,
    runnerBinaryPath: runnerdPath,
    seed: request.session.seed ?? {},
    actorId: request.session.actorId ?? "",
    taskId: request.session.taskId ?? "",
    capabilities: request.session.capabilities ?? [],
    explicitClaims: request.session.explicitClaims ?? [],
    turnTimeoutMs: request.limits.turnTimeoutMs,
    toolExposure: request.session.toolExposure,
  });
  const turn = execution.turn as Record<string, unknown>;
  const snapshot = execution.snapshot as Parameters<typeof reconcileCapabilityLiveUsage>[0];
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
    provider: request.provider ?? "codex",
    driver: request.driver ?? (request.provider === "opencode" ? "opencode_server" : request.provider === "aws_agentcore" ? "aws_agentcore_harness_api" : request.provider === "acpx" ? "acpx_runtime" : "codex_app_server"),
    providerVersion: request.provider === "opencode" ? request.opencodeVersion ?? "1.18.17" : request.provider === "aws_agentcore" ? request.agentCoreProfile?.harnessVersion ?? null : request.provider === "acpx" ? acpxProfile!.acpxVersion : null,
    ...(acpxProfile === null ? {} : { acpxAgent: acpxProfile.agent, acpxProfile }),
    turn,
    snapshot,
    devtools: projectCapabilityDevtools(snapshot),
    issueThread: projectCapabilityIssueThread({ snapshot, mode: "live", replaySource: "live" }),
    usage,
    timing: { startedAt: evalStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - evalStartedAtMs },
  }, null, 2)}\n`);
} catch (error) {
  const infrastructureFailure = error instanceof DurableEvalInfrastructureError
    ? {
        class: error.failureClass,
        category: infrastructureCategory(error.failureClass),
        retryable: error.retryable,
        diagnostics: error.diagnostics,
      }
    : {
        class: "eval_orchestration_failure",
        category: "eval_orchestration",
        retryable: false,
        diagnostics: {},
      };
  await writeFile(outputPath, `${JSON.stringify({
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId: request.attemptId,
    infrastructureError: error instanceof Error ? error.message : String(error),
    infrastructureFailure,
    build: PAPERCLIP_RUNNER_BUILD_METADATA,
    runnerd: { path: "[withheld]", sha256: `sha256:${actualDigest}` },
    requestedModel: request.model,
    provider: request.provider ?? "codex",
    driver: request.driver ?? (request.provider === "opencode" ? "opencode_server" : request.provider === "aws_agentcore" ? "aws_agentcore_harness_api" : request.provider === "acpx" ? "acpx_runtime" : "codex_app_server"),
    providerVersion: request.provider === "opencode" ? request.opencodeVersion ?? "1.18.17" : request.provider === "aws_agentcore" ? request.agentCoreProfile?.harnessVersion ?? null : request.provider === "acpx" ? acpxProfile!.acpxVersion : null,
    ...(acpxProfile === null ? {} : { acpxAgent: acpxProfile.agent, acpxProfile }),
    timing: { startedAt: evalStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - evalStartedAtMs },
  }, null, 2)}\n`);
  process.exitCode = 2;
}
