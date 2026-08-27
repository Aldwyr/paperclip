import { describe, expect, it } from "vitest";
import {
  runnerEnvironments,
  runnerMatrix,
  runnerProfiles,
  runnerTasks,
  isImmutableDaytonaImage,
  validateRunnerCatalog,
} from "./catalog.js";
import {
  buildMatrixJobs,
  parseRunnerSelectors,
  RunnerSelectorError,
  selectRunnerExecutions,
} from "./selectors.js";

describe("runner E2E catalog", () => {
  it("validates the eight by two by three acceptance matrix", () => {
    expect(runnerProfiles).toHaveLength(8);
    expect(runnerEnvironments).toHaveLength(2);
    expect(runnerTasks).toHaveLength(3);
    expect(validateRunnerCatalog()).toHaveLength(48);
    expect(new Set(runnerMatrix.map((entry) => entry.id)).size).toBe(48);
  });

  it("uses only declared secret references in generated payloads", () => {
    expect(
      runnerMatrix.every((entry) =>
        entry.requiredCredentials.includes(entry.profile.credential),
      ),
    ).toBe(true);
    expect(
      runnerMatrix
        .filter((entry) => entry.environment.id === "daytona")
        .every((entry) =>
          entry.requiredCredentials.includes("DAYTONA_API_KEY"),
        ),
    ).toBe(true);
  });

  it("pins legacy Codex and Claude to their classic CLI engines", () => {
    for (const profileId of ["legacy-codex", "legacy-claude"]) {
      const execution = runnerMatrix.find(
        (candidate) =>
          candidate.profile.id === profileId &&
          candidate.environment.id === "local",
      );
      expect(execution).toBeDefined();
      expect(
        execution!.profile.buildAgent({
          environmentId: "11111111-1111-4111-8111-111111111111",
          environmentFixtureId: "local",
          workspacePath: "/tmp/runner-e2e-workspace",
          secretRefs: {
            [execution!.profile.credential]: {
              type: "secret_ref",
              secretId: "22222222-2222-4222-8222-222222222222",
              version: "latest",
            },
          },
          executionId: execution!.id,
        }),
      ).toMatchObject({ adapterConfig: { engine: "cli" } });
    }
  });

  it("binds native Codex automation auth to the encrypted OpenAI secret", () => {
    const execution = runnerMatrix.find(
      (candidate) => candidate.id === "runner-codex.local.message-marker",
    );
    expect(execution).toBeDefined();
    const secretRef = {
      type: "secret_ref" as const,
      secretId: "22222222-2222-4222-8222-222222222222",
      version: "latest" as const,
    };
    const agent = execution!.profile.buildAgent({
      environmentId: "11111111-1111-4111-8111-111111111111",
      environmentFixtureId: "local",
      workspacePath: "/tmp/runner-e2e-workspace",
      secretRefs: { OPENAI_API_KEY: secretRef },
      executionId: execution!.id,
    });
    expect(agent.adapterConfig).toMatchObject({
      env: {
        OPENAI_API_KEY: secretRef,
        CODEX_API_KEY: secretRef,
      },
    });
  });

  it("gives legacy planning agents a direct bounded API recipe", () => {
    const task = runnerTasks.find(
      (candidate) => candidate.id === "plan-revise-accept",
    );
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.profile.id === "legacy-claude" &&
        candidate.environment.id === "local" &&
        candidate.task.id === "plan-revise-accept",
    );
    expect(task).toBeDefined();
    expect(execution).toBeDefined();
    const agent = execution!.profile.buildAgent({
      environmentId: "11111111-1111-4111-8111-111111111111",
      environmentFixtureId: "local",
      workspacePath: "/tmp/runner-e2e-workspace",
      secretRefs: {
        ANTHROPIC_API_KEY: {
          type: "secret_ref",
          secretId: "22222222-2222-4222-8222-222222222222",
          version: "latest",
        },
      },
      executionId: execution!.id,
    });
    expect(agent.adapterConfig).toMatchObject({ maxTurnsPerRun: 24 });
    expect(agent.instructionsBundle).toMatchObject({
      files: { "AGENTS.md": expect.stringContaining("/interactions") },
    });
    expect(task!.buildPrompt("nonce")).toContain("request_confirmation");
  });

  it("accepts only complete immutable Daytona digests", () => {
    expect(
      isImmutableDaytonaImage(
        `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`,
      ),
    ).toBe(true);
    expect(
      isImmutableDaytonaImage(
        "ghcr.io/paperclipai/paperclip-daytona-runner@sha256:REPLACE_ME",
      ),
    ).toBe(false);
    expect(
      isImmutableDaytonaImage(
        "ghcr.io/paperclipai/paperclip-daytona-runner:e2e-latest",
      ),
    ).toBe(false);
  });
});

describe("runner E2E selectors", () => {
  it("requires an explicit billable selector", () => {
    expect(() => parseRunnerSelectors([])).toThrow(RunnerSelectorError);
  });

  it("selects dimensions with OR within a dimension and AND across dimensions", () => {
    const options = parseRunnerSelectors([
      "--profile",
      "legacy-codex",
      "--profile",
      "runner-codex",
      "--environment",
      "local",
    ]);
    expect(selectRunnerExecutions(options).map((entry) => entry.id)).toEqual([
      "legacy-codex.local.message-marker",
      "legacy-codex.local.plan-revise-accept",
      "legacy-codex.local.ask-question",
      "runner-codex.local.message-marker",
      "runner-codex.local.plan-revise-accept",
      "runner-codex.local.ask-question",
    ]);
  });

  it("combines repeated groups with AND semantics", () => {
    const options = parseRunnerSelectors([
      "--group",
      "native",
      "--group",
      "daytona",
    ]);
    const selected = selectRunnerExecutions(options);
    expect(selected).toHaveLength(15);
    expect(
      selected.every(
        (entry) =>
          entry.profile.generation === "native" &&
          entry.environment.id === "daytona",
      ),
    ).toBe(true);
  });

  it("rejects groups outside the advertised four", () => {
    const options = parseRunnerSelectors(["--group", "codex"]);
    expect(() => selectRunnerExecutions(options)).toThrow("Unknown group");
  });

  it("emits one independently schedulable job per scenario", () => {
    const jobs = buildMatrixJobs(
      selectRunnerExecutions(parseRunnerSelectors(["--all"])),
    );
    expect(jobs).toHaveLength(48);
    expect(jobs.filter((job) => job.needsDaytona)).toHaveLength(24);
    expect(new Set(jobs.map((job) => job.executionId)).size).toBe(48);
  });

  it("validates bounded local parallelism", () => {
    expect(
      parseRunnerSelectors(["--all", "--max-parallel", "8"]).maxParallel,
    ).toBe(8);
    expect(() =>
      parseRunnerSelectors(["--all", "--max-parallel", "0"]),
    ).toThrow("positive integer");
  });
});
