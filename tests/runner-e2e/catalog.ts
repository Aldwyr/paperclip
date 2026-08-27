import { createAgentSchema } from "../../packages/shared/src/validators/agent.js";
import { createEnvironmentSchema } from "../../packages/shared/src/validators/environment.js";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../../packages/adapters/codex-local/src/index.js";
import { modelProfiles as claudeModelProfiles } from "../../packages/adapters/claude-local/src/index.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { QUALIFIED_OPENCODE_MODEL } from "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.js";
import { CREDENTIAL_NAMES } from "./types.js";
import type {
  AgentFixtureBuildInput,
  EnvironmentFixture,
  EnvironmentFixtureBuildInput,
  MatrixExecution,
  RunnerProfileFixture,
  RunnerTaskFixture,
  SecretReference,
} from "./types.js";

const ENVIRONMENT_IDS = ["local", "daytona"] as const;
const SELECTABLE_GROUPS = ["legacy", "native", "local", "daytona"] as const;
const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";

export function isImmutableDaytonaImage(value: string | undefined) {
  return /^.+@sha256:[0-9a-f]{64}$/i.test(value ?? "");
}

function requiredSecret(
  input: AgentFixtureBuildInput,
  name: RunnerProfileFixture["credential"],
): SecretReference {
  const value = input.secretRefs[name];
  if (!value) throw new Error(`Missing fixture secret reference ${name}`);
  return value;
}

function commonAgent(
  input: AgentFixtureBuildInput,
  fixtureId: string,
  adapterType: string,
  adapterConfig: Record<string, unknown>,
) {
  return {
    name: `Runner E2E ${fixtureId} ${input.executionId}`,
    role: "qa",
    title: "Paid full-stack runner acceptance fixture",
    capabilities:
      "Completes deterministic standard, planning, and ask-mode runner acceptance tasks.",
    adapterType,
    adapterConfig,
    defaultEnvironmentId: input.environmentId,
    budgetMonthlyCents: 0,
    instructionsBundle: {
      entryFile: "AGENTS.md",
      files: {
        "AGENTS.md": [
          "You are running a paid Paperclip end-to-end acceptance fixture.",
          "Follow the assigned task and its Paperclip work mode literally.",
          "For standard and ask tasks, publish the requested visible answer and mark the task done.",
          "For planning tasks, publish or revise the canonical Plan document and its revision-bound request_confirmation, then wait. Only implement after that exact plan is accepted.",
          "Invoke assigned tools only through the runtime's real tool-call channel. Never print XML, DSML, JSON, or other tool-call markup as assistant text.",
          "Legacy adapters must use the public Paperclip API and the injected PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_TASK_ID, and PAPERCLIP_RUN_ID values for comments, documents, interactions, and status changes.",
          ...(adapterType === "paperclip_runner"
            ? []
            : [
                "For a planning task, do not inspect the OpenAPI schema. PUT /api/issues/$PAPERCLIP_TASK_ID/documents/plan with {title:\"Plan\",format:\"markdown\",body,changeSummary}; read latestRevisionId and latestRevisionNumber from that response. Then POST /api/issues/$PAPERCLIP_TASK_ID/interactions with {kind:\"request_confirmation\",continuationPolicy:\"wake_assignee\",payload:{version:1,prompt,acceptLabel:\"Approve\",rejectLabel:\"Reject\",rejectRequiresReason:true,target:{type:\"issue_document\",key:\"plan\",revisionId,revisionNumber}}}, and PATCH the issue to {status:\"in_review\"}. Include Authorization and X-Paperclip-Run-Id on every write.",
              ]),
          "Never print, persist, or expose credential values, and never create unrelated work.",
        ].join("\n"),
      },
    },
    runtimeConfig: {},
  };
}

function legacyProfile(input: {
  id: string;
  label: string;
  adapterType: "codex_local" | "claude_local" | "opencode_local";
  provider: string;
  model: string;
  credential: RunnerProfileFixture["credential"];
  extraConfig?: Record<string, unknown>;
}): RunnerProfileFixture {
  return {
    ...input,
    modelQualification: {
      source: "adapter_constant",
      qualificationId: `${input.adapterType}:default-model`,
    },
    generation: "legacy",
    groups: ["legacy"],
    supportedEnvironments: ENVIRONMENT_IDS,
    expectedRuntimeMode: "legacy",
    expectedRuntimeMetadata: {
      adapterType: input.adapterType,
      provider: input.provider,
    },
    buildAgent(buildInput) {
      return commonAgent(buildInput, input.id, input.adapterType, {
        // Remote adapters must inherit the lease's provider-owned remoteCwd.
        // A host path here would override that mapping inside the sandbox.
        ...(buildInput.environmentFixtureId === "local"
          ? { cwd: buildInput.workspacePath }
          : {}),
        model: input.model,
        timeoutSec: buildInput.environmentFixtureId === "daytona" ? 780 : 360,
        dangerouslySkipPermissions: true,
        ...input.extraConfig,
        env: {
          [input.credential]: requiredSecret(buildInput, input.credential),
        },
      });
    },
  };
}

function nativeProfile(input: {
  id: string;
  label: string;
  provider: "codex" | "opencode" | "acpx";
  model: string;
  credential: RunnerProfileFixture["credential"];
  acpxAgent?: "pi" | "claude" | "codex";
}): RunnerProfileFixture {
  return {
    ...input,
    adapterType: "paperclip_runner",
    generation: "native",
    groups: ["native"],
    supportedEnvironments: ENVIRONMENT_IDS,
    expectedRuntimeMode: "native",
    modelQualification: {
      source:
        input.provider === "acpx"
          ? "qualified_runner_profile"
          : "adapter_constant",
      qualificationId:
        input.provider === "acpx"
          ? `acpx:${input.acpxAgent}`
          : `${input.provider}:qualified-model`,
    },
    expectedRuntimeMetadata: {
      adapterType: "paperclip_runner",
      provider: input.provider,
    },
    buildAgent(buildInput) {
      const credentialRef = requiredSecret(buildInput, input.credential);
      const permissionConfig =
        input.provider === "codex"
          ? { codexPermissionMode: "never" }
          : input.provider === "opencode"
            ? { opencodePermissionMode: "allow", command: "opencode" }
            : { acpxPermissionMode: "approve-all", acpxAgent: input.acpxAgent };
      return commonAgent(buildInput, input.id, "paperclip_runner", {
        provider: input.provider,
        model: input.model,
        lifecycleMode: "per_turn",
        idleTimeoutMs: 300_000,
        ...permissionConfig,
        env: {
          [input.credential]: credentialRef,
          // Codex's supported automation credential is CODEX_API_KEY. Keep
          // OPENAI_API_KEY as the operator-facing fixture secret name and bind
          // the same encrypted reference to the runtime-specific alias.
          ...(input.provider === "codex"
            ? { CODEX_API_KEY: credentialRef }
            : {}),
        },
      });
    },
  };
}

const claudeLegacyModel = String(
  claudeModelProfiles.find((profile) => profile.key === "cheap")?.adapterConfig
    .model,
);
if (!claudeLegacyModel || claudeLegacyModel === "undefined") {
  throw new Error(
    "Claude adapter does not expose its qualified cheap model profile",
  );
}

export const runnerProfiles: readonly RunnerProfileFixture[] = [
  legacyProfile({
    id: "legacy-codex",
    label: "Legacy Codex",
    adapterType: "codex_local",
    provider: "codex",
    model: DEFAULT_CODEX_LOCAL_MODEL,
    credential: "OPENAI_API_KEY",
    // Keep this fixture on the classic adapter/CLI lane. ACP execution is
    // covered independently by the native runner ACPX profiles below.
    extraConfig: { engine: "cli" },
  }),
  legacyProfile({
    id: "legacy-claude",
    label: "Legacy Claude",
    adapterType: "claude_local",
    provider: "claude",
    model: claudeLegacyModel,
    credential: "ANTHROPIC_API_KEY",
    extraConfig: {
      engine: "cli",
      // Plan fixtures need enough tool turns to read the issue, write the
      // canonical Plan document, and request confirmation. Four turns caused
      // the Claude CLI to terminate correctly but prematurely with
      // `max_turns_exhausted` during the revision flow.
      maxTurnsPerRun: 24,
    },
  }),
  legacyProfile({
    id: "legacy-opencode",
    label: "Legacy OpenCode",
    adapterType: "opencode_local",
    provider: "opencode",
    model: QUALIFIED_OPENCODE_MODEL,
    credential: "OPENROUTER_API_KEY",
  }),
  nativeProfile({
    id: "runner-codex",
    label: "Runner Codex",
    provider: "codex",
    model: DEFAULT_CODEX_LOCAL_MODEL,
    credential: "OPENAI_API_KEY",
  }),
  nativeProfile({
    id: "runner-opencode",
    label: "Runner OpenCode",
    provider: "opencode",
    model: QUALIFIED_OPENCODE_MODEL,
    credential: "OPENROUTER_API_KEY",
  }),
  nativeProfile({
    id: "runner-acpx-pi",
    label: "Runner ACPX Pi",
    provider: "acpx",
    acpxAgent: "pi",
    model: QUALIFIED_ACPX_PROFILES.pi.qualificationModel,
    credential: "OPENROUTER_API_KEY",
  }),
  nativeProfile({
    id: "runner-acpx-claude",
    label: "Runner ACPX Claude",
    provider: "acpx",
    acpxAgent: "claude",
    model: QUALIFIED_ACPX_PROFILES.claude.qualificationModel,
    credential: "ANTHROPIC_API_KEY",
  }),
  nativeProfile({
    id: "runner-acpx-codex",
    label: "Runner ACPX Codex",
    provider: "acpx",
    acpxAgent: "codex",
    model: QUALIFIED_ACPX_PROFILES.codex.qualificationModel,
    credential: "OPENAI_API_KEY",
  }),
] as const;

function requiredDaytonaSecret(input: EnvironmentFixtureBuildInput) {
  const apiKey = input.secretRefs.DAYTONA_API_KEY;
  if (!apiKey)
    throw new Error("Missing fixture secret reference DAYTONA_API_KEY");
  return apiKey;
}

export const runnerEnvironments: readonly EnvironmentFixture[] = [
  {
    id: "local",
    label: "Isolated local",
    groups: ["local"],
    driver: "local",
    provider: "local",
    lifecycle: {
      setup: "instance_managed",
      probe: "run_context_via_api",
      cleanup: "instance_shutdown",
    },
    expectedExecutionTarget: { kind: "local" },
    buildEnvironment(input) {
      return {
        name: `Runner E2E local ${input.executionId}`,
        description: "Ephemeral local runner E2E environment",
        driver: "local",
        config: {},
        envVars: {},
      };
    },
  },
  {
    id: "daytona",
    label: "Daytona sandbox",
    groups: ["daytona"],
    driver: "sandbox",
    provider: "daytona",
    credential: "DAYTONA_API_KEY",
    lifecycle: {
      setup: "create_via_api",
      probe: "run_context_via_api",
      cleanup: "delete_via_api_and_destroy_leases",
    },
    expectedExecutionTarget: { kind: "remote", transport: "sandbox" },
    buildEnvironment(input) {
      if (!isImmutableDaytonaImage(input.daytonaImage)) {
        throw new Error(
          "PAPERCLIP_E2E_DAYTONA_IMAGE must be an immutable image digest",
        );
      }
      return {
        name: `Runner E2E Daytona ${input.executionId}`,
        description: "Ephemeral Daytona runner E2E environment",
        driver: "sandbox",
        config: {
          provider: "daytona",
          apiKey: requiredDaytonaSecret(input),
          image: input.daytonaImage,
          reuseLease: false,
          runnerLifecycleMode: "per_turn",
          autoStopInterval: 5,
          autoArchiveInterval: 15,
          autoDeleteInterval: 60,
          timeoutMs: 300_000,
          livenessTimeoutMs: 30_000,
        },
        envVars: {},
      };
    },
  },
] as const;

export const runnerTasks: readonly RunnerTaskFixture[] = [
  {
    id: "message-marker",
    label: "Basic response",
    groups: [],
    workMode: "standard",
    flow: "single_turn",
    expectedRunCount: 1,
    attemptTimeoutMs: {
      local: 8 * 60_000,
      daytona: 15 * 60_000,
    },
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: (nonce) => `Runner E2E PAPERCLIP_E2E_OK_${nonce}`,
    buildVisibleMarker: (nonce) => `PAPERCLIP_E2E_OK_${nonce}`,
    buildPrompt: (nonce) =>
      [
        "Complete this task in a single run.",
        `The exact marker also appears unescaped in the task title: PAPERCLIP_E2E_OK_${nonce}`,
        `Your final visible task-thread response must be exactly this marker: PAPERCLIP_E2E_OK_${nonce}`,
        `In a native runner, first emit that exact marker as the complete user-facing final response, then use paperclip_finish with the same marker as its summary and an objective-satisfied claim for the supplied contract revision.`,
        `In a legacy runner, post a task comment containing exactly that marker and mark the task Done through the public API.`,
        "The visible task-thread response is asserted; hidden reasoning or provider terminal output alone does not count.",
        "Use underscore characters exactly as shown and do not insert backslashes.",
        "Do not create files, ask questions, start additional tasks, or include any credentials.",
      ].join("\n"),
    buildMatchers(nonce, execution) {
      return [
        { kind: "message_contains", expected: `PAPERCLIP_E2E_OK_${nonce}` },
        {
          kind: "issue_status",
          expected: execution.task.expectedTerminalState.issue,
        },
        {
          kind: "run_status",
          expected: execution.task.expectedTerminalState.run,
        },
        {
          kind: "runtime_mode",
          expected: execution.profile.expectedRuntimeMode,
        },
        { kind: "environment", expected: execution.environment.id },
      ];
    },
  },
  {
    id: "plan-revise-accept",
    label: "Plan, revise, accept, implement",
    groups: [],
    workMode: "planning",
    flow: "plan_revision_acceptance",
    expectedRunCount: 3,
    attemptTimeoutMs: {
      local: 20 * 60_000,
      daytona: 35 * 60_000,
    },
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: (nonce) => `Runner E2E plan lifecycle ${nonce}`,
    buildVisibleMarker: (nonce) => `PAPERCLIP_E2E_PLAN_DONE_${nonce}`,
    buildPlanMarkers: (nonce) => ({
      draft: `PAPERCLIP_E2E_PLAN_DRAFT_${nonce}`,
      revised: `PAPERCLIP_E2E_PLAN_REVISED_${nonce}`,
    }),
    buildRevisionRequest: (nonce) =>
      [
        "Revise this same plan; do not implement it yet.",
        `Remove PAPERCLIP_E2E_PLAN_DRAFT_${nonce} and include PAPERCLIP_E2E_PLAN_REVISED_${nonce}.`,
        "Change the plan from two steps to exactly three numbered steps, with verification as step 3.",
        "Publish the revised canonical Plan revision and request confirmation for that new revision.",
        "In a native runner, call write_document for key `plan`, then call request_human_input exactly once with interactionKind `confirmation`, targetRevisionId set to the returned latest Plan revision, and continuationPolicy `wake_assignee`; do not call paperclip_finish while waiting.",
        "In a legacy runner, update the Plan and create the equivalent revision-bound request_confirmation through the public Paperclip API.",
      ].join(" "),
    buildPrompt: (nonce) =>
      [
        "This is a planning-mode lifecycle acceptance task.",
        "First, create a small canonical Plan with exactly two numbered steps and request approval; do not implement it.",
        `The initial Plan body must contain PAPERCLIP_E2E_PLAN_DRAFT_${nonce}.`,
        "If the plan is sent back, revise that same Plan document according to the revision note, publish a new revision-bound confirmation, and still do not implement.",
        "Only after the revised plan is accepted, implement it by posting one final visible task-thread response containing exactly " +
          `PAPERCLIP_E2E_PLAN_DONE_${nonce}` +
          " and mark the task Done.",
        "For a native runner, remain in the requested planning collaboration mode. Call write_document for key `plan`, then call request_human_input exactly once with interactionKind `confirmation`, targetRevisionId set to the returned latest Plan revision, and continuationPolicy `wake_assignee`. Do not call paperclip_finish while waiting for either Plan confirmation.",
        "For a legacy runner, use the public Paperclip API: PUT the `plan` issue document, create a `request_confirmation` targeting its latest revision with `continuationPolicy: wake_assignee`, and move the issue to `in_review` while waiting.",
        "Do not create files, child tasks, or unrelated work, and do not expose credentials.",
      ].join("\n"),
    buildMatchers(nonce, execution) {
      return [
        {
          kind: "message_contains",
          expected: `PAPERCLIP_E2E_PLAN_DONE_${nonce}`,
        },
        {
          kind: "issue_status",
          expected: execution.task.expectedTerminalState.issue,
        },
        {
          kind: "run_status",
          expected: execution.task.expectedTerminalState.run,
        },
        {
          kind: "runtime_mode",
          expected: execution.profile.expectedRuntimeMode,
        },
        { kind: "environment", expected: execution.environment.id },
      ];
    },
  },
  {
    id: "ask-question",
    label: "Ask mode question",
    groups: [],
    workMode: "ask",
    flow: "single_turn",
    expectedRunCount: 1,
    attemptTimeoutMs: {
      local: 8 * 60_000,
      daytona: 15 * 60_000,
    },
    expectedTerminalState: { issue: "done", run: "succeeded" },
    buildTitle: (nonce) => `Runner E2E ask mode ${nonce}`,
    buildVisibleMarker: (nonce) => `E2E_ASK_12_${nonce}`,
    buildPrompt: (nonce) =>
      [
        "Answer this question directly in Ask mode: what is seven plus five?",
        `Your final visible task-thread answer must contain this complete marker, including its final suffix: E2E_ASK_12_${nonce}.`,
        "Do not create or modify files, do not create a plan or additional work, and do not expose credentials.",
        "After posting the direct answer, mark this task Done.",
        `In a native runner, emit the answer and finish with E2E_ASK_12_${nonce} as the summary.`,
        `In a legacy runner, post a task comment containing E2E_ASK_12_${nonce} and mark the task Done through the public API.`,
      ].join("\n"),
    buildMatchers(nonce, execution) {
      return [
        {
          kind: "message_contains",
          expected: `E2E_ASK_12_${nonce}`,
        },
        {
          kind: "issue_status",
          expected: execution.task.expectedTerminalState.issue,
        },
        {
          kind: "run_status",
          expected: execution.task.expectedTerminalState.run,
        },
        {
          kind: "runtime_mode",
          expected: execution.profile.expectedRuntimeMode,
        },
        { kind: "environment", expected: execution.environment.id },
      ];
    },
  },
] as const;

export function buildRunnerMatrix(): MatrixExecution[] {
  return runnerProfiles.flatMap((profile) =>
    runnerEnvironments
      .filter((environment) =>
        profile.supportedEnvironments.includes(environment.id),
      )
      .flatMap((environment) =>
        runnerTasks.map((task) => ({
          id: `${profile.id}.${environment.id}.${task.id}`,
          profile,
          environment,
          task,
          groups: [
            ...new Set([
              ...profile.groups,
              ...environment.groups,
              ...task.groups,
            ]),
          ],
          requiredCredentials: [
            profile.credential,
            ...(environment.credential ? [environment.credential] : []),
          ],
        })),
      ),
  );
}

function duplicateIds(values: readonly { id: string }[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.id)
    .filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
}

function assertNoRawSecretValues(value: unknown, label: string) {
  if (typeof value === "string") {
    if (/\b(?:sk-(?:proj-)?|sk-ant-)[A-Za-z0-9_-]{12,}\b/.test(value)) {
      throw new Error(`${label} contains a raw secret-looking value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoRawSecretValues(entry, label));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      if (
        typeof entry === "string" &&
        /(?:api.?key|access.?token|credential|secret)$/i.test(key) &&
        entry.trim()
      ) {
        throw new Error(`${label} contains a raw credential at ${key}`);
      }
      assertNoRawSecretValues(entry, label);
    });
  }
}

export function validateRunnerCatalog(): MatrixExecution[] {
  for (const [label, values] of [
    ["profile", runnerProfiles],
    ["environment", runnerEnvironments],
    ["task", runnerTasks],
  ] as const) {
    const duplicates = duplicateIds(values);
    if (duplicates.length > 0)
      throw new Error(
        `Duplicate ${label} fixture ids: ${duplicates.join(", ")}`,
      );
  }

  const selectableGroups = new Set<string>(SELECTABLE_GROUPS);
  for (const fixture of [
    ...runnerProfiles,
    ...runnerEnvironments,
    ...runnerTasks,
  ]) {
    const unknownGroups = fixture.groups.filter(
      (group) => !selectableGroups.has(group),
    );
    if (unknownGroups.length > 0) {
      throw new Error(
        `Fixture ${fixture.id} declares unknown groups: ${unknownGroups.join(", ")}`,
      );
    }
  }

  const sampleRefs = Object.fromEntries(
    [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
      "DAYTONA_API_KEY",
    ].map((name, index) => [
      name,
      {
        type: "secret_ref" as const,
        secretId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        version: "latest" as const,
      },
    ]),
  );

  for (const environment of runnerEnvironments) {
    const payload = environment.buildEnvironment({
      secretRefs: sampleRefs,
      daytonaImage:
        "ghcr.io/paperclipai/paperclip-daytona-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      executionId: "schema-validation",
    });
    createEnvironmentSchema.parse(payload);
    assertNoRawSecretValues(payload, `environment ${environment.id}`);
  }
  for (const profile of runnerProfiles) {
    if (!CREDENTIAL_NAMES.includes(profile.credential)) {
      throw new Error(
        `Profile ${profile.id} declares unknown credential ${profile.credential}`,
      );
    }
    const unsupportedEnvironmentIds = profile.supportedEnvironments.filter(
      (environmentId) => !ENVIRONMENT_IDS.includes(environmentId),
    );
    if (unsupportedEnvironmentIds.length > 0) {
      throw new Error(
        `Profile ${profile.id} declares unknown environments: ${unsupportedEnvironmentIds.join(", ")}`,
      );
    }
    const payload = profile.buildAgent({
      environmentId: SAMPLE_UUID,
      environmentFixtureId: "local",
      workspacePath: "/tmp/paperclip-runner-e2e-schema",
      secretRefs: sampleRefs,
      executionId: "schema-validation",
    });
    createAgentSchema.parse(payload);
    assertNoRawSecretValues(payload, `profile ${profile.id}`);
  }

  const matrix = buildRunnerMatrix();
  const duplicateMatrixIds = duplicateIds(matrix);
  if (duplicateMatrixIds.length > 0) {
    throw new Error(
      `Duplicate matrix execution ids: ${duplicateMatrixIds.join(", ")}`,
    );
  }
  if (matrix.length !== 48)
    throw new Error(`Expected 48 runner executions; received ${matrix.length}`);
  return matrix;
}

export const runnerMatrix = validateRunnerCatalog();

export function runnerExecutionById(id: string): MatrixExecution {
  const execution = runnerMatrix.find((candidate) => candidate.id === id);
  if (!execution) throw new Error(`Unknown runner E2E execution id: ${id}`);
  return execution;
}
