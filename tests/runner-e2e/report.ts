import path from "node:path";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { runnerMatrix } from "./catalog.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import type { RunnerE2EResult } from "./types.js";

interface EvidenceManifest {
  files?: string[];
  leaks?: Array<{ file: string; reason: string }>;
  missing?: string[];
}

interface AggregatedResult {
  result: RunnerE2EResult;
  evidence: EvidenceManifest | null;
  directory: string;
  valid: boolean;
  errors: string[];
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function xml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validate(result: RunnerE2EResult, evidence: EvidenceManifest | null) {
  const errors: string[] = [];
  if (result.status !== "passed")
    errors.push(result.error ?? result.failureClass ?? "execution failed");
  if (result.cleanup !== "passed") errors.push(`cleanup=${result.cleanup}`);
  if (!evidence) errors.push("evidence manifest missing");
  if (evidence?.leaks?.length)
    errors.push(`secret leaks=${evidence.leaks.length}`);
  if (evidence?.missing?.length)
    errors.push(`missing evidence=${evidence.missing.join(",")}`);
  if (
    result.status === "passed" &&
    !evidence?.files?.includes("final-state.png")
  ) {
    errors.push("passing final-state screenshot missing");
  }
  return errors;
}

function safeEvidenceRelative(relative: string) {
  if (path.isAbsolute(relative)) return null;
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === ".."))
    return null;
  return segments;
}

async function stageDashboardEvidence(
  selected: readonly AggregatedResult[],
  output: string,
) {
  const staged = new Map<string, { baseHref: string; files: string[] }>();
  for (const entry of selected) {
    const baseSegments = [
      "evidence",
      entry.result.executionId,
      `attempt-${entry.result.attempt}`,
    ];
    const copied: string[] = [];
    for (const relative of entry.evidence?.files ?? []) {
      const segments = safeEvidenceRelative(relative);
      if (!segments) continue;
      const source = path.join(entry.directory, ...segments);
      const destination = path.join(output, ...baseSegments, ...segments);
      const didCopy = await mkdir(path.dirname(destination), {
        recursive: true,
      })
        .then(() => copyFile(source, destination))
        .then(() => true)
        .catch(() => false);
      if (didCopy) copied.push(segments.join("/"));
    }
    staged.set(entry.result.executionId, {
      baseHref: baseSegments.join("/"),
      files: copied,
    });
  }
  return staged;
}

async function main() {
  const root = path.resolve(
    process.env.PAPERCLIP_RUNNER_E2E_REPORT_ROOT ?? "tests/runner-e2e/results",
  );
  const output = path.resolve(
    process.env.PAPERCLIP_RUNNER_E2E_REPORT_OUT ?? path.join(root, "merged"),
  );
  const expected = JSON.parse(
    process.env.PAPERCLIP_RUNNER_E2E_EXPECTED_IDS ?? "[]",
  ) as string[];
  if (
    !Array.isArray(expected) ||
    expected.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "PAPERCLIP_RUNNER_E2E_EXPECTED_IDS must be a JSON string array",
    );
  }
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw new Error(
      "PAPERCLIP_RUNNER_E2E_EXPECTED_IDS must contain unique selected executions",
    );
  }
  const resultFiles = (await walk(root)).filter(
    (file) => path.basename(file) === "result.json",
  );
  const candidates = new Map<string, AggregatedResult[]>();
  for (const resultFile of resultFiles) {
    const result = JSON.parse(
      await readFile(resultFile, "utf8"),
    ) as RunnerE2EResult;
    if (result.schema !== "paperclip.runner-e2e.result/v1") continue;
    const directory = path.dirname(resultFile);
    const evidence = await readFile(
      path.join(directory, "evidence-manifest.json"),
      "utf8",
    )
      .then((value) => JSON.parse(value) as EvidenceManifest)
      .catch(() => null);
    const errors = validate(result, evidence);
    const entry = {
      result,
      evidence,
      directory,
      valid: errors.length === 0,
      errors,
    };
    candidates.set(result.executionId, [
      ...(candidates.get(result.executionId) ?? []),
      entry,
    ]);
  }

  const selected: AggregatedResult[] = [];
  for (const executionId of expected) {
    const attempts = (candidates.get(executionId) ?? []).sort((left, right) => {
      // A report root can contain artifacts from multiple local campaigns (or
      // reruns downloaded from CI). Prefer retained evidence that actually
      // satisfies the campaign contract, then the newest execution. Attempt
      // numbers are only meaningful inside one campaign and must not let an
      // older failed attempt shadow a later successful rerun.
      if (left.valid !== right.valid) return left.valid ? -1 : 1;
      return (
        Date.parse(right.result.finishedAt) -
          Date.parse(left.result.finishedAt) ||
        right.result.attempt - left.result.attempt
      );
    });
    if (attempts.length === 0) {
      const now = new Date().toISOString();
      const missing: RunnerE2EResult = {
        schema: "paperclip.runner-e2e.result/v1",
        executionId,
        attempt: 0,
        status: "failed",
        failureClass: "permanent_infrastructure",
        error: "No result artifact was uploaded",
        profileId: executionId.split(".")[0] ?? "unknown",
        environmentId: executionId.includes(".daytona.") ? "daytona" : "local",
        caseId: executionId.split(".").at(-1) ?? "unknown",
        provider: "unknown",
        model: "unknown",
        runtimeMode: executionId.startsWith("legacy-") ? "legacy" : "native",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        cleanup: "not_started",
      };
      selected.push({
        result: missing,
        evidence: null,
        directory: root,
        valid: false,
        errors: [missing.error!],
      });
    } else {
      selected.push(attempts[0]);
    }
  }

  await mkdir(output, { recursive: true });
  const stagedEvidence = await stageDashboardEvidence(selected, output);
  const normalized = {
    schema: "paperclip.runner-e2e.campaign/v1",
    generatedAt: new Date().toISOString(),
    expected,
    passed: selected.filter((entry) => entry.valid).length,
    failed: selected.filter((entry) => !entry.valid).length,
    results: selected.map((entry) => ({
      ...entry.result,
      evidenceDirectory: entry.directory,
      evidenceValid: entry.valid,
      evidenceErrors: entry.errors,
    })),
  };
  await writeFile(
    path.join(output, "normalized-results.json"),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  const dashboard = renderRunnerE2EDashboard({
    title: "Runner Full-Stack E2E",
    generatedAt: normalized.generatedAt,
    expected,
    catalog: runnerMatrix,
    entries: selected.map((entry) => ({
      result: entry.result,
      valid: entry.valid,
      errors: entry.errors,
      evidenceBaseHref: stagedEvidence.get(entry.result.executionId)?.baseHref,
      evidenceFiles: stagedEvidence.get(entry.result.executionId)?.files,
    })),
  });
  await Promise.all([
    writeFile(path.join(output, "dashboard.html"), dashboard, "utf8"),
    writeFile(path.join(output, "index.html"), dashboard, "utf8"),
  ]);

  const summaryLines = [
    "# Runner Full-Stack E2E",
    "",
    `Passed: ${normalized.passed}/${selected.length}`,
    "",
    "| Cell | Attempt | Result | Runtime | Duration | Detail |",
    "|---|---:|---|---|---:|---|",
    ...selected.map((entry) => {
      const detail = entry.errors.join("; ").replaceAll("|", "\\|") || "ok";
      return `| ${entry.result.executionId} | ${entry.result.attempt} | ${entry.valid ? "pass" : "fail"} | ${entry.result.runtimeMode} | ${Math.round(entry.result.durationMs / 1000)}s | ${detail} |`;
    }),
    "",
  ];
  await writeFile(path.join(output, "summary.md"), summaryLines.join("\n"));

  const failures = selected.filter((entry) => !entry.valid).length;
  const cases = selected
    .map((entry) => {
      const failure = entry.valid
        ? ""
        : `<failure message="${xml(entry.errors.join("; "))}"/>`;
      return `<testcase classname="runner-full-stack-e2e" name="${xml(entry.result.executionId)}" time="${entry.result.durationMs / 1000}">${failure}</testcase>`;
    })
    .join("");
  const junit = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="Runner Full-Stack E2E" tests="${selected.length}" failures="${failures}">${cases}</testsuite>\n`;
  await writeFile(path.join(output, "junit.xml"), junit);
  console.log(summaryLines.join("\n"));
  if (failures > 0) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
