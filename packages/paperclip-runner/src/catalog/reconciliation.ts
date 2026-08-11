/**
 * Canonical semantic-catalog reconciliation authority.
 *
 * The runner historically carried two independently hand-maintained semantic
 * catalogs:
 *
 * - `src/tools/` — the rich scenario/eval descriptor (placement, side-effect
 *   class, idempotency, redaction, mock mapping) consumed by the scenario and
 *   conformance layers and exported as the package-root default.
 * - `src/semantic-tools/` — the live runtime engine (catalog + policy +
 *   dispatcher) that drives live Codex, the issue-thread projection, and the
 *   generated provider-neutral contracts.
 *
 * PAP-17025 makes this module the single machine-readable authority over the
 * union of both surfaces so no specification calls either catalog canonical.
 * It enumerates every operation once, names its placement, claims, task modes,
 * roles, side-effect class, idempotency rule, redaction, mock mapping, real
 * binding status, and PRP-evidence shape, and computes every op-set and
 * metadata divergence between the two catalogs so drift checks can fail on any
 * unrecorded change. Physically collapsing the two catalog modules into
 * derivations of this authority (which changes live tool schemas and generated
 * goldens and needs live re-QA) is the sequenced follow-on within PAP-17025.
 */
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as SCENARIO_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import type {
  CapabilityMockCommandMapping,
  CapabilitySideEffectClass,
  CapabilityToolDisposition,
  CapabilityToolTaskMode,
  ScenarioChatdempotencyBehavior,
} from "../tools/capability-semantic-tool-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as LIVE_CATALOG } from "../semantic-tools/catalog.js";

/** Where an operation is executable today, before real Paperclip binding. */
export type CapabilityRealBindingStatus = "live_codex" | "scenario_mock" | "test_only";

/** Which hand-maintained catalog module(s) currently define the operation. */
export type CapabilityCatalogSurface = "scenario" | "live";

export interface CapabilityCanonicalOperation {
  readonly operationId: string;
  /** Catalog module(s) that define this operation today. */
  readonly surfaces: readonly CapabilityCatalogSurface[];
  readonly placement: CapabilityToolDisposition;
  readonly requiredClaims: readonly string[];
  readonly taskModes: readonly CapabilityToolTaskMode[];
  readonly allowedRoles?: readonly string[];
  readonly sideEffectClass: CapabilitySideEffectClass;
  readonly idempotency: ScenarioChatdempotencyBehavior;
  /** True when the operation declares any redaction rule. */
  readonly redacts: boolean;
  readonly mockCommandMapping: CapabilityMockCommandMapping | null;
  readonly realBindingStatus: CapabilityRealBindingStatus;
  /**
   * No semantic operation is bound to a real Paperclip service yet; the mock is
   * the only backend. The real-service binding is deliverable G of the
   * foundation plan (PAP-17016), tracked per operation once it lands.
   */
  readonly realServiceBinding: "unbound";
  /** Intended PRP evidence family carrying this operation's effect. */
  readonly prpEvidence: string;
  /**
   * The formal PRP expressiveness proof is deliverable C of the foundation
   * plan; until it lands every entry is `audit_pending` rather than proven.
   */
  readonly prpBindingStatus: "audit_pending";
  /** Legacy MCP alias ids folded into this operation, if any. */
  readonly legacyAliases: readonly string[];
  readonly note?: string;
}

export type CapabilityCatalogDivergenceField =
  | "requiredClaims"
  | "taskModes"
  | "inputSchemaShape";

export interface CapabilityCatalogDivergence {
  readonly operationId: string;
  readonly field: CapabilityCatalogDivergenceField;
  readonly scenario: string;
  readonly live: string;
  /** Recorded rationale for why the two surfaces legitimately differ today. */
  readonly disposition: string;
}

// ---------------------------------------------------------------------------
// Reconciliation table (hand-authored decisions, one row per union operation).
// Fields the two catalogs already carry are read from the descriptors; only
// facts neither catalog encodes live here: real binding status, PRP evidence,
// legacy aliases, and any side-effect/idempotency call for live-only ops.
// ---------------------------------------------------------------------------

interface ReconciliationRow {
  readonly realBindingStatus: CapabilityRealBindingStatus;
  readonly legacyAliases?: readonly string[];
  readonly note?: string;
  /** Required only for the four live-only ops absent from the rich catalog. */
  readonly liveOnly?: {
    readonly placement: CapabilityToolDisposition;
    readonly sideEffectClass: CapabilitySideEffectClass;
    readonly idempotency: ScenarioChatdempotencyBehavior;
    readonly prpEvidence: string;
  };
}

const RECONCILIATION: Readonly<Record<string, ReconciliationRow>> = {
  // --- always-present active-task surface (shared) ---
  get_task_context: { realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipMe"] },
  get_task_history: { realBindingStatus: "live_codex" },
  list_documents: { realBindingStatus: "live_codex" },
  read_document: { realBindingStatus: "live_codex" },
  list_document_revisions: { realBindingStatus: "live_codex" },
  report_progress: { realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipCommentOnIssue"] },
  answer_status_question: { realBindingStatus: "live_codex" },
  write_document: { realBindingStatus: "live_codex" },
  request_human_input: { realBindingStatus: "live_codex" },
  register_deliverable: { realBindingStatus: "live_codex" },
  finish_task: { realBindingStatus: "live_codex" },
  block_task: { realBindingStatus: "live_codex" },
  request_review: { realBindingStatus: "live_codex" },
  // `inspect_operation_result` is scenario-only: the live dispatcher returns
  // results inline rather than exposing a re-read tool.
  inspect_operation_result: {
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only re-read of a prior operation result; the live dispatcher returns results inline.",
  },

  // --- discovery (shared + live-only) ---
  search_tasks: { realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipListIssues"] },
  list_agents: { realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipListAgents"] },
  get_agent: {
    realBindingStatus: "live_codex",
    legacyAliases: ["mcp:paperclipGetAgent"],
    liveOnly: {
      placement: "optional_agent_tool",
      sideEffectClass: "read",
      idempotency: "none",
      prpEvidence: "read projection surfaced via a tool-result item event; no control-plane state diff",
    },
  },
  list_projects: {
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet.",
  },
  list_goals: {
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet.",
  },

  // --- delegation & dependencies (shared) ---
  create_task: { realBindingStatus: "live_codex", legacyAliases: ["mcp:paperclipCreateIssue"] },
  set_dependencies: { realBindingStatus: "live_codex" },

  // --- governance (shared + live-only) ---
  list_approvals: { realBindingStatus: "live_codex" },
  request_approval: { realBindingStatus: "live_codex" },
  decide_approval: { realBindingStatus: "live_codex" },
  comment_on_approval: { realBindingStatus: "live_codex" },
  get_approval: {
    realBindingStatus: "live_codex",
    liveOnly: {
      placement: "optional_agent_tool",
      sideEffectClass: "read",
      idempotency: "none",
      prpEvidence: "approval read projection surfaced via a tool-result item event; no state diff",
    },
  },
  get_approval_context: {
    realBindingStatus: "live_codex",
    liveOnly: {
      placement: "optional_agent_tool",
      sideEffectClass: "read",
      idempotency: "none",
      prpEvidence: "approval-plus-linked-tasks read projection via a tool-result item event; no state diff",
    },
  },

  // --- workspace runtime (shared) ---
  get_workspace_runtime: { realBindingStatus: "live_codex" },
  control_workspace_service: { realBindingStatus: "live_codex" },

  // --- control-plane wake scheduling (live-only) ---
  schedule_wake: {
    realBindingStatus: "live_codex",
    liveOnly: {
      placement: "optional_agent_tool",
      sideEffectClass: "task_write",
      idempotency: "required",
      prpEvidence: "wake scheduling recorded as a run/attention continuation event; deterministic delay",
    },
    note: "Bounded, deterministic mock wake scheduling; requires the control_plane:wakes claim.",
  },

  // --- scenario-only optional surfaces (mock extensions, no live binding) ---
  list_cases: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  upsert_case: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  list_routines: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  manage_routine: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  list_company_skills: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  sync_company_skills: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  list_secret_metadata: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension; metadata only." },
  read_secret_value: {
    realBindingStatus: "scenario_mock",
    note: "Scenario/eval-only mock extension; secret value redacted from every observable sink.",
  },
  export_company: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },
  administer_company: { realBindingStatus: "scenario_mock", note: "Scenario/eval-only mock extension." },

  // --- test-only escape hatch (shared, never product coverage) ---
  generic_api_request: {
    realBindingStatus: "test_only",
    note: "Test-only escape hatch; explicitly cannot count as product capability coverage (PAP-17016 deliverable D).",
  },
};

// ---------------------------------------------------------------------------
// Derivation.
// ---------------------------------------------------------------------------

function prpEvidenceForSideEffect(sideEffectClass: CapabilitySideEffectClass): string {
  switch (sideEffectClass) {
    case "read":
      return "read projection surfaced via a tool-result item event; no control-plane state diff";
    case "task_write":
      return "semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events";
    case "company_write":
      return "semantic-operation item event plus company-entity state diff and audit record";
    case "governance":
      return "approval lifecycle plus governed-wait continuation and audit events";
    case "workspace_control":
      return "workspace service lifecycle event";
    case "secret_read":
      return "redacted tool-result item event; secret value never reaches the wire";
    case "admin":
      return "company admin/portability item event plus audit record";
    case "test_escape_hatch":
      return "test-only; excluded from product PRP evidence";
    default:
      return "audit_pending";
  }
}

type LiveDescriptor = (typeof LIVE_CATALOG)[number];
const scenarioById = new Map<string, (typeof SCENARIO_CATALOG)[number]>(
  SCENARIO_CATALOG.map((tool) => [tool.operationId, tool]),
);
const liveById = new Map<string, LiveDescriptor>(
  LIVE_CATALOG.map((tool) => [tool.operationId as string, tool]),
);

const UNION_IDS: readonly string[] = [
  ...new Set([...scenarioById.keys(), ...liveById.keys()]),
].sort();

function buildOperation(operationId: string): CapabilityCanonicalOperation {
  const row = RECONCILIATION[operationId];
  if (row === undefined) {
    throw new Error(`Missing reconciliation decision for operation ${operationId}.`);
  }
  const scenario = scenarioById.get(operationId);
  const live = liveById.get(operationId);
  const surfaces: CapabilityCatalogSurface[] = [];
  if (scenario !== undefined) surfaces.push("scenario");
  if (live !== undefined) surfaces.push("live");

  if (scenario !== undefined) {
    return freeze({
      operationId,
      surfaces,
      placement: scenario.disposition,
      requiredClaims: [...scenario.requiredClaims],
      taskModes: [...scenario.taskModes],
      ...(scenario.allowedRoles === undefined ? {} : { allowedRoles: [...scenario.allowedRoles] }),
      sideEffectClass: scenario.sideEffectClass,
      idempotency: scenario.idempotency,
      redacts: scenario.redaction.length > 0,
      mockCommandMapping: scenario.mockCommandMapping,
      realBindingStatus: row.realBindingStatus,
      realServiceBinding: "unbound",
      prpEvidence: prpEvidenceForSideEffect(scenario.sideEffectClass),
      prpBindingStatus: "audit_pending",
      legacyAliases: row.legacyAliases ?? [],
      ...(row.note === undefined ? {} : { note: row.note }),
    });
  }

  // Live-only operation: the rich catalog does not define it, so the
  // reconciliation row must supply placement, side-effect class, and evidence.
  if (live === undefined || row.liveOnly === undefined) {
    throw new Error(`Live-only operation ${operationId} needs an explicit reconciliation row.`);
  }
  return freeze({
    operationId,
    surfaces,
    placement: row.liveOnly.placement,
    requiredClaims: [...live.requiredClaims],
    taskModes: [...live.allowedModes] as CapabilityToolTaskMode[],
    ...(live.allowedRoles === undefined ? {} : { allowedRoles: [...live.allowedRoles] }),
    sideEffectClass: row.liveOnly.sideEffectClass,
    idempotency: row.liveOnly.idempotency,
    redacts: false,
    mockCommandMapping: null,
    realBindingStatus: row.realBindingStatus,
    realServiceBinding: "unbound",
    prpEvidence: row.liveOnly.prpEvidence,
    prpBindingStatus: "audit_pending",
    legacyAliases: row.legacyAliases ?? [],
    ...(row.note === undefined ? {} : { note: row.note }),
  });
}

/** The single canonical catalog: the union of both surfaces, sorted by id. */
export const CAPABILITY_CANONICAL_CATALOG: readonly CapabilityCanonicalOperation[] = Object.freeze(
  UNION_IDS.map(buildOperation),
);

const canonicalById = new Map(
  CAPABILITY_CANONICAL_CATALOG.map((operation) => [operation.operationId, operation]),
);

export function capabilityCanonicalOperation(
  operationId: string,
): CapabilityCanonicalOperation | undefined {
  return canonicalById.get(operationId);
}

// ---------------------------------------------------------------------------
// Divergence ledger: every metadata difference between the two catalogs for a
// shared operation, each with a recorded disposition. Drift checks pin this set
// so a new, unrecorded divergence fails.
// ---------------------------------------------------------------------------

function inputSchemaShape(schema: { properties?: Record<string, unknown>; required?: readonly string[] } | undefined): string {
  const properties = Object.keys(schema?.properties ?? {}).sort();
  const required = [...(schema?.required ?? [])].sort();
  return `properties=[${properties.join(",")}] required=[${required.join(",")}]`;
}

/**
 * Input schemas differ by design between the two surfaces: the scenario
 * descriptor keeps idempotency out-of-band and omits provider bounds, while the
 * live provider descriptor threads `idempotencyKey` in-band and adds
 * length/pattern bounds for the model. Unifying the schema is the
 * schema-migration follow-on within PAP-17025.
 */
const INPUT_SCHEMA_SHAPE_DISPOSITION =
  "Input schema differs by design (scenario keeps idempotency out-of-band and omits provider bounds; the live provider descriptor threads idempotencyKey in-band with length/pattern bounds). Unify in the schema-migration follow-on.";

/**
 * The two catalogs apply task-mode policy differently: the scenario/eval
 * catalog scopes modes to the coverage the suite drives (adds `skill_test`,
 * restricts optional reads to `standard`), while the live catalog encodes the
 * runtime exposure policy (opens optional reads to `ask`/`planning`, keeps
 * terminal writes `standard`-only). The canonical target — one task-mode policy
 * per operation — is decided in the schema-migration follow-on within
 * PAP-17025. The exact divergent op-set is pinned by the drift test.
 */
const TASK_MODE_DISPOSITION =
  "Task-mode policy differs between the scenario suite's coverage modes and the live runtime exposure policy. Reconcile to one canonical policy in the schema-migration follow-on.";

const DIVERGENCE_DISPOSITIONS: Readonly<Record<string, string>> = {
  "generic_api_request:requiredClaims":
    "Test-only escape hatch. The scenario claim `test:generic_api` and the live claim `test:generic_api_request` are the same reviewed test-only grant; unified in the schema-migration follow-on.",
};

function buildDivergences(): readonly CapabilityCatalogDivergence[] {
  const divergences: CapabilityCatalogDivergence[] = [];
  for (const operationId of UNION_IDS) {
    const scenario = scenarioById.get(operationId);
    const live = liveById.get(operationId);
    if (scenario === undefined || live === undefined) continue;

    const record = (
      field: CapabilityCatalogDivergenceField,
      scenarioValue: string,
      liveValue: string,
    ): void => {
      if (scenarioValue === liveValue) return;
      const disposition =
        field === "inputSchemaShape"
          ? INPUT_SCHEMA_SHAPE_DISPOSITION
          : field === "taskModes"
            ? TASK_MODE_DISPOSITION
            : (DIVERGENCE_DISPOSITIONS[`${operationId}:${field}`] ??
              "UNRECORDED — reconcile or add a disposition.");
      divergences.push({ operationId, field, scenario: scenarioValue, live: liveValue, disposition });
    };

    record(
      "requiredClaims",
      [...scenario.requiredClaims].sort().join(","),
      [...live.requiredClaims].sort().join(","),
    );
    record(
      "taskModes",
      [...scenario.taskModes].sort().join(","),
      [...live.allowedModes].sort().join(","),
    );
    record("inputSchemaShape", inputSchemaShape(scenario.inputSchema), inputSchemaShape(live.inputSchema));
  }
  return Object.freeze(divergences);
}

export interface CapabilityCatalogReconciliation {
  readonly unionCount: number;
  readonly scenarioCount: number;
  readonly liveCount: number;
  readonly sharedCount: number;
  readonly scenarioOnly: readonly string[];
  readonly liveOnly: readonly string[];
  readonly byRealBindingStatus: Readonly<Record<CapabilityRealBindingStatus, number>>;
  readonly alwaysCount: number;
  readonly optionalCount: number;
  readonly divergences: readonly CapabilityCatalogDivergence[];
}

export function capabilityCatalogReconciliation(): CapabilityCatalogReconciliation {
  const scenarioIds = new Set(scenarioById.keys());
  const liveIds = new Set(liveById.keys());
  const scenarioOnly = [...scenarioIds].filter((id) => !liveIds.has(id)).sort();
  const liveOnly = [...liveIds].filter((id) => !scenarioIds.has(id)).sort();
  const byRealBindingStatus: Record<CapabilityRealBindingStatus, number> = {
    live_codex: 0,
    scenario_mock: 0,
    test_only: 0,
  };
  let alwaysCount = 0;
  let optionalCount = 0;
  for (const operation of CAPABILITY_CANONICAL_CATALOG) {
    byRealBindingStatus[operation.realBindingStatus] += 1;
    if (operation.placement === "always_agent_tool") alwaysCount += 1;
    else if (operation.placement === "optional_agent_tool") optionalCount += 1;
  }
  return {
    unionCount: UNION_IDS.length,
    scenarioCount: scenarioIds.size,
    liveCount: liveIds.size,
    sharedCount: [...scenarioIds].filter((id) => liveIds.has(id)).length,
    scenarioOnly,
    liveOnly,
    byRealBindingStatus,
    alwaysCount,
    optionalCount,
    divergences: buildDivergences(),
  };
}

/** Convenience for docs/generators: the canonical operation-id list, sorted. */
export function capabilityCanonicalOperationIds(): readonly string[] {
  return UNION_IDS;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
