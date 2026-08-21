# Paperclip Runner protocol binding roster

This roster is the implementation ledger for binding the canonical Paperclip Runner protocol to the real Paperclip control plane. The action definitions under `packages/paperclip-runner/src/protocol-actions/` remain the source of truth for schemas and examples; this document records production integration status.

## Current baseline

- Canonical protocol actions: **41**
- Actions in the Codex semantic catalog: **28**
- Actions with a real Paperclip service binding: **0**
- Actions audited end-to-end over production PRP: **0**
- Existing semantic conformance bridge: five route-backed test operations (`report_progress`, `write_document`, confirmation-only `request_human_input`, `set_dependencies`, and `finish_task`). It is test-only and is not a production binding.

The generated action metadata currently says `realServiceBinding: unbound` and `prpBindingStatus: audit_pending` for every action. `realBindingStatus: live_codex` means only that a Codex scenario exercised the mock semantic implementation; it must not be interpreted as a production Paperclip binding.

## Binding groups

| Group | Actions | Real authority target | Status |
| --- | --- | --- | --- |
| Active task reads | `get_task_context`, `get_task_history`, `search_tasks` | issue, comment, project, and assignment services | unbound |
| Task mutations | `report_progress`, `answer_status_question`, `finish_task`, `block_task`, `request_review`, `set_dependencies`, `create_task` | issue/comment services and native status arbiter | unbound |
| Documents and deliverables | `list_documents`, `read_document`, `list_document_revisions`, `write_document`, `register_deliverable` | document and attachment services | unbound |
| Human interaction | `request_human_input` | interaction service and continuation scheduler | unbound |
| Agents | `list_agents`, `get_agent` | agent service with company scope | unbound |
| Approvals | `list_approvals`, `get_approval`, `get_approval_context`, `request_approval`, `decide_approval`, `comment_on_approval` | approval service | unbound |
| Workspace | `get_workspace_runtime`, `control_workspace_service` | workspace runtime service | unbound |
| Scheduling | `schedule_wake` | wakeup service | unbound |
| Discovery | tool search and tool schema lookup | authorized catalog projection | mock implementation only |
| Administrative surface | `administer_company`, `export_company`, `list_company_skills`, `sync_company_skills`, `list_projects`, `list_goals`, `list_routines`, `manage_routine`, `list_cases`, `upsert_case`, `inspect_operation_result` | existing company-scoped API/services; individually authorization-gated | protocol-only/scenario mock |
| Secrets | `list_secret_metadata`, `read_secret_value` | secrets service; metadata/value claims separated and output redacted | protocol-only/scenario mock |
| Escape hatch | `generic_api_request` | no production binding planned until a narrow allowlist is designed | test-only |

## Rules for marking a binding complete

An action moves from `unbound` only when all of the following are true:

1. The runner advertises the canonical input and response schema only when the run identity is authorized for the operation.
2. The PRP call is bound to company, issue, agent, run, session, turn, call, lease, catalog digest, and protocol version.
3. The server invokes the same service or HTTP route used by the real application; no mock state reducer is in the production path.
4. Existing authorization, optimistic concurrency, idempotency, redaction, audit, and continuation behavior is preserved.
5. Unit tests cover allow/deny/replay behavior and an end-to-end real-server eval records the tool call, state diff, thread projection, and assertion result.
6. The generated action metadata names the concrete service binding and records the completed PRP audit.

## Cutover order

The first production vertical slice is `get_task_context` + `report_progress` + `finish_task`. Next are documents, interactions, task dependencies/creation, approvals, agent/project reads, workspace/scheduling, then the separately privileged administrative and secret surfaces. `generic_api_request` stays unavailable in production.
