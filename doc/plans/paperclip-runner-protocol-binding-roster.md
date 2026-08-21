# Paperclip Runner protocol binding roster

This roster is the implementation ledger for binding the canonical Paperclip Runner protocol to the real Paperclip control plane. The action definitions under `packages/paperclip-runner/src/protocol-actions/` remain the source of truth for schemas and examples; this document records production integration status.

## Current baseline

- Canonical protocol actions: **41**
- Actions in the Codex semantic catalog: **28**
- Actions advertised by the production Paperclip authority: **14**
- Actions with a real Paperclip service binding: **14**
- Actions audited through the shared Paperclip-server PRP route: **1 full real-service vertical slice; 13 additional bound operations unit-audited**
- Existing semantic conformance bridge: five route-backed test operations (`report_progress`, `write_document`, confirmation-only `request_human_input`, `set_dependencies`, and `finish_task`). It is test-only and is not a production binding.

The generated action metadata currently says `realServiceBinding: unbound` and `prpBindingStatus: audit_pending` for every action. `realBindingStatus: live_codex` means only that a Codex scenario exercised the mock semantic implementation; it must not be interpreted as a production Paperclip binding.

## Binding groups

| Group | Actions | Real authority target | Status |
| --- | --- | --- | --- |
| Active task reads | `get_task_context`, `get_task_history`, `search_tasks` | issue, comment, project, and assignment services | bound; run/issue/agent/company assignment checked on every call |
| Task mutations | `report_progress`, `answer_status_question`, `finish_task`, `block_task`, `request_review`, `set_dependencies`, `create_task` | issue/comment services and native status arbiter | `report_progress` bound with durable run receipt; remaining actions withheld pending mutation/status-arbiter audit |
| Documents and deliverables | `list_documents`, `read_document`, `list_document_revisions`, `write_document`, `register_deliverable` | document and attachment services | three reads and `write_document` bound; write uses the real optimistic-revision service and a run-locked durable receipt. Deliverable registration remains withheld |
| Human interaction | `request_human_input` | interaction service and continuation scheduler | bound for confirmation, checkbox, questions, suggested tasks, and item verdicts |
| Agents | `list_agents`, `get_agent` | agent service with company scope | bound with credential/config redaction and company checks |
| Approvals | `list_approvals`, `get_approval`, `get_approval_context`, `request_approval`, `decide_approval`, `comment_on_approval` | approval service | three reads bound; mutations withheld. `decide_approval` is board-user-only in the current product and must not be agent-advertised |
| Workspace | `get_workspace_runtime`, `control_workspace_service` | workspace runtime service | unbound |
| Scheduling | `schedule_wake` | wakeup service | unbound |
| Discovery | tool search and tool schema lookup | authorized catalog projection | runner-local authorized projection; production authority supplies only the 14 bound definitions |
| Administrative surface | `administer_company`, `export_company`, `list_company_skills`, `sync_company_skills`, `list_projects`, `list_goals`, `list_routines`, `manage_routine`, `list_cases`, `upsert_case`, `inspect_operation_result` | existing company-scoped API/services; individually authorization-gated | protocol-only/scenario mock |
| Secrets | `list_secret_metadata`, `read_secret_value` | secrets service; metadata/value claims separated and output redacted | protocol-only/scenario mock |
| Escape hatch | `generic_api_request` | no production binding planned until a narrow allowlist is designed | test-only |

## Per-action production disposition

This is the exhaustive 41-action decision ledger. “Withheld” means the action
is intentionally absent from the agent's authorized catalog; runnerd cannot
invoke an action merely because it exists in the canonical documentation.

| Action | Production disposition | Authority / reason |
| --- | --- | --- |
| `get_task_context` | bound | run/issue/assignee/company join |
| `get_task_history` | bound | issue comments scoped to the bound issue |
| `search_tasks` | bound | `issueService.list`, company-scoped |
| `report_progress` | bound | `issueService.addComment`, run-locked receipt |
| `list_documents` | bound | bound-issue document service |
| `read_document` | bound | bound issue + document key |
| `list_document_revisions` | bound | bound issue + document key |
| `write_document` | bound | optimistic revision service, run-locked receipt |
| `request_human_input` | bound | existing interaction service; five structured variants |
| `list_agents` | bound | company-scoped, redacted actor projection |
| `get_agent` | bound | company equality, redacted actor projection |
| `list_approvals` | bound | company-scoped approval service |
| `get_approval` | bound | company equality |
| `get_approval_context` | bound | company equality + linked issue projection |
| `answer_status_question` | withheld | needs canonical status-answer/thread semantics in the product service |
| `register_deliverable` | withheld | artifact/attachment ownership and idempotency audit pending |
| `finish_task` | withheld | terminal status belongs to native completion + status arbiter; must not race `paperclip_finish` |
| `block_task` | withheld | route enforces blockers/interactions/approvals/unblock-owner policy not yet factored into a shared service |
| `request_review` | withheld | must use execution-policy transition and review-stage validation |
| `set_dependencies` | withheld | route authorization, cycle/readiness, wake, and activity behavior must remain atomic |
| `create_task` | withheld | bounded-delegation policy and parent/depth authorization audit pending |
| `request_approval` | withheld | approval creation/linkage and continuation policy audit pending |
| `decide_approval` | prohibited for agent runs | current real service requires a board user principal |
| `comment_on_approval` | withheld | approval visibility, authorship, and audit parity pending |
| `get_workspace_runtime` | withheld | environment/workspace lease scope audit pending |
| `control_workspace_service` | withheld | privileged process control; explicit grant and idempotency design pending |
| `schedule_wake` | withheld | wake ownership, deduplication, and scheduling policy audit pending |
| `administer_company` | withheld privileged surface | no agent grant policy approved |
| `export_company` | withheld privileged surface | bulk data export is board/admin-only |
| `list_company_skills` | withheld privileged surface | skill-administration protocol remains separate from task authority |
| `sync_company_skills` | withheld privileged surface | mutating skill sync requires explicit administration grant |
| `list_projects` | withheld optional read | not yet bound to a run-authorized project projection |
| `list_goals` | withheld optional read | not yet bound to a run-authorized goal projection |
| `list_routines` | withheld privileged surface | routine visibility policy pending |
| `manage_routine` | withheld privileged surface | scheduler administration is not task authority |
| `list_cases` | withheld optional read | pipeline/case grant model pending |
| `upsert_case` | withheld privileged surface | pipeline mutation grant/idempotency audit pending |
| `inspect_operation_result` | withheld | operation receipt lookup/redaction contract pending |
| `list_secret_metadata` | withheld privileged surface | separate metadata claim and audit projection required |
| `read_secret_value` | prohibited by default | secret-value claim, non-persistence, and output redaction require a dedicated path |
| `generic_api_request` | prohibited | no open-ended production HTTP escape hatch |

## Rules for marking a binding complete

An action moves from `unbound` only when all of the following are true:

1. The runner advertises the canonical input and response schema only when the run identity is authorized for the operation.
2. The PRP call is bound to company, issue, agent, run, session, turn, call, lease, catalog digest, and protocol version.
3. The server invokes the same service or HTTP route used by the real application; no mock state reducer is in the production path.
4. Existing authorization, optimistic concurrency, idempotency, redaction, audit, and continuation behavior is preserved.
5. Unit tests cover allow/deny/replay behavior and an end-to-end real-server eval records the tool call, state diff, thread projection, and assertion result.
6. The generated action metadata names the concrete service binding and records the completed PRP audit.

## Cutover order

The first production vertical slice is now `get_task_context` + `report_progress` + all five structured `request_human_input` variants, plus bounded document/agent/approval reads. The next slice is document writes and dependency/child-task mutations with durable receipts. Terminal task actions must be reconciled with the native status arbiter before they are advertised. Approval decisions remain board-user-only. Workspace/scheduling follow, then the separately privileged administrative and secret surfaces. `generic_api_request` stays unavailable in production.

## Production transport status

Paperclip now owns a shared WebSocket upgrade route at
`/api/runner/v1/connect/:runId`. The native executor registers one run-bound
`DurablePrpControlPlane` authority, runnerd receives that loopback URL, and the
authority still authenticates the one-time bootstrap ticket and durable lease
inside PRP. Unknown runs and malformed run IDs fail closed before the protocol
handshake. The run ID is a path segment because runnerd deliberately rejects
query-bearing WebSocket URLs to avoid URL ambiguity.

`paperclip-runner-real-server.integration.test.ts` is the first complete proof:
an embedded real Paperclip database and active native heartbeat run are routed
through the shared server endpoint to Rust runnerd and the fake Codex
app-server; Codex calls `get_task_context`, and the result is read from the real
run-bound Paperclip authority. The remaining advertised operations still need
their own route-level cases before the roster can call all 14 fully audited.
