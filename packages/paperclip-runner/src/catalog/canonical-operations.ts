/** Stable aggregate API over the per-action definitions in `src/protocol-actions/`. */
import type { CapabilitySideEffectClass, CapabilityToolDisposition, CapabilityOptionalCatalogGroup, CapabilityToolTaskMode, ScenarioChatdempotencyBehavior } from "../tools/capability-semantic-tool-types.js";
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";

export type CapabilityCatalogSurface = "scenario" | "live";
export type CapabilityRealBindingStatus = "live_codex" | "scenario_mock" | "test_only";
export interface CapabilityCanonicalOperation {
  readonly operationId: string; readonly surfaces: readonly CapabilityCatalogSurface[];
  readonly placement: CapabilityToolDisposition; readonly optionalGroup: CapabilityOptionalCatalogGroup | null;
  readonly requiredClaims: readonly string[]; readonly taskModes: readonly CapabilityToolTaskMode[];
  readonly allowedRoles?: readonly string[]; readonly sideEffectClass: CapabilitySideEffectClass;
  readonly idempotency: ScenarioChatdempotencyBehavior; readonly disabledByDefault: boolean;
  readonly realBindingStatus: CapabilityRealBindingStatus; readonly realServiceBinding: string;
  readonly prpEvidence: string; readonly prpBindingStatus: "audit_pending" | "bound";
  readonly legacyAliases: readonly string[]; readonly note?: string;
}

const PRODUCTION_BINDINGS: Readonly<Record<string, { service: string; evidence: string }>> = Object.freeze({
  get_task_context: { service: "PaperclipRunnerToolAuthority + issue/run assignment query", evidence: "shared PRP route + bound-context authorization test" },
  get_task_history: { service: "issueComments scoped by bound issue", evidence: "shared PRP route + bound-context authorization test" },
  search_tasks: { service: "issueService.list", evidence: "shared PRP route + company scope test" },
  report_progress: { service: "issueService.addComment + heartbeatRuns semanticToolReceipts", evidence: "real service mutation + idempotent replay test" },
  request_human_input: { service: "issueThreadInteractionService.create", evidence: "real structured interaction + continuation projection test" },
  list_documents: { service: "documentService.listIssueDocuments", evidence: "bound issue document read" },
  read_document: { service: "documentService.getIssueDocumentByKey", evidence: "bound issue/key document read" },
  list_document_revisions: { service: "documentService.listIssueDocumentRevisions", evidence: "bound issue/key revision read" },
  write_document: { service: "documentService.upsertIssueDocument + heartbeatRuns semanticToolReceipts", evidence: "real revision mutation + optimistic concurrency + idempotent replay test" },
  list_agents: { service: "agentService.list (redacted projection)", evidence: "company-scoped actor projection" },
  get_agent: { service: "agentService.getById (redacted projection)", evidence: "company equality + redacted actor projection" },
  list_approvals: { service: "approvalService.list", evidence: "company-scoped approval projection" },
  get_approval: { service: "approvalService.getById", evidence: "company equality check" },
  get_approval_context: { service: "approvalService.getById + issueApprovals", evidence: "company equality + linked-task projection" },
});

export const CAPABILITY_CANONICAL_OPERATIONS: readonly CapabilityCanonicalOperation[] = Object.freeze(
  PAPERCLIP_PROTOCOL_ACTIONS.map((action) => {
    const operation = action.canonical as unknown as CapabilityCanonicalOperation;
    const binding = PRODUCTION_BINDINGS[operation.operationId];
    return binding === undefined ? operation : {
      ...operation,
      realServiceBinding: binding.service,
      prpEvidence: binding.evidence,
      prpBindingStatus: "bound" as const,
    };
  })
    .sort((left, right) => left.operationId.localeCompare(right.operationId)),
);
const byId = new Map(CAPABILITY_CANONICAL_OPERATIONS.map((operation) => [operation.operationId, operation]));
if (byId.size !== 41) throw new Error(`expected 41 canonical semantic operations, found ${byId.size}`);
export function capabilityCanonicalOperation(operationId: string): CapabilityCanonicalOperation | undefined { return byId.get(operationId); }
export function capabilityCanonicalOperationsForSurface(surface: CapabilityCatalogSurface): readonly CapabilityCanonicalOperation[] { return CAPABILITY_CANONICAL_OPERATIONS.filter((operation) => operation.surfaces.includes(surface)); }
export function capabilityCanonicalOperationIds(): readonly string[] { return CAPABILITY_CANONICAL_OPERATIONS.map((operation) => operation.operationId); }
