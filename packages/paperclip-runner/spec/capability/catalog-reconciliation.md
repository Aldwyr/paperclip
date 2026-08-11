# Semantic Catalog Reconciliation

**Document status:** Canonical reconciliation ledger (PAP-17025)<br>
**Date:** 2026-08-11<br>
**Authority:** `src/catalog/reconciliation.ts` (machine-readable), drift-checked by `src/catalog/reconciliation.test.ts` and `src/catalog/catalog-docs.test.ts`.<br>
**Parent plan:** Runner foundation review plan (PAP-17016), deliverable D and execution step 1.

## Purpose

The runner carried two independently hand-maintained semantic catalogs. This is
the first reconciliation gate of the foundation plan: establish one
machine-readable authority over both, name every operation's full metadata, and
record every divergence with an explicit disposition so no specification calls
either catalog canonical and no stale count or unreviewed divergence can land.

## The two catalogs

| Catalog | Module | Count | Descriptor | Consumers |
| --- | --- | --- | --- | --- |
| Scenario / eval | `src/tools/` | 37 (14 always + 23 optional) | Rich: placement (`disposition`), `sideEffectClass`, `idempotency`, `redaction`, `mockCommandMapping` | `src/scenarios/*`, `src/conformance/*`; package-root default export |
| Live runtime | `src/semantic-tools/` | 28 (13 always + 15 optional) | Live: `exposure`, `allowedModes`, `disabledByDefault`, provider input/output schemas; runtime dispatcher + policy + redaction | `src/live/*` (live Codex), `src/issue-thread/*`, generated `semantic-tool-contracts.json`; package-root `acceptedCapabilitySemanticTools` |

Reconciled op-set relationship (pinned by the drift test):

- **24 shared** operation ids.
- **13 scenario-only:** `administer_company`, `export_company`, `inspect_operation_result`, `list_cases`, `list_company_skills`, `list_goals`, `list_projects`, `list_routines`, `list_secret_metadata`, `manage_routine`, `read_secret_value`, `sync_company_skills`, `upsert_case`.
- **4 live-only:** `get_agent`, `get_approval`, `get_approval_context`, `schedule_wake`.
- **Union = 41 operations.**

## Canonical authority decision

- **Descriptor schema:** the rich `src/tools/` descriptor is the canonical shape.
  It is the only one that already names placement, side-effect class,
  idempotency, redaction, and mock mapping — the per-operation facts the plan
  requires. The canonical authority extends it with **real-binding status** and
  **PRP-evidence shape**.
- **Machine-readable authority:** `src/catalog/reconciliation.ts` enumerates the
  41-op union exactly once (`CAPABILITY_CANONICAL_CATALOG`), each entry naming
  placement, claims, task modes, roles, side-effect class, idempotency,
  redaction, mock mapping, real-binding status, PRP evidence, and legacy
  aliases. `capabilityCatalogReconciliation()` computes the op-set summary and
  the divergence ledger.
- No spec should call either `src/tools/` or `src/semantic-tools/` canonical.
  Both remain in place this increment; the follow-on collapses them into
  derivations of the authority.

## Real-binding status (before real Paperclip service binding)

No operation is bound to a real Paperclip service yet; the deterministic mock is
the only backend (real-service binding is deliverable G). Each operation's
current executability is classified as:

- **`live_codex` (27):** executed by the live dispatcher against the mock and
  exposed to live Codex — the 24 shared ops (minus the test-only escape hatch)
  plus the 4 live-only ops.
- **`scenario_mock` (13):** defined only in the scenario/eval catalog and driven
  through the scenario runtime / mock extensions; no live dispatcher binding.
- **`test_only` (1):** `generic_api_request` — the escape hatch, which by rule
  **cannot count as product capability coverage**.

## Divergence ledger

For every shared operation the authority compares `requiredClaims`, task modes,
and input-schema shape, and records a disposition. The drift test fails if a new
divergence appears without one.

- **Claims (1):** `generic_api_request` requires `test:generic_api` (scenario)
  vs `test:generic_api_request` (live). Same reviewed test-only grant; unify in
  the follow-on.
- **Task modes (15):** `block_task`, `comment_on_approval`,
  `control_workspace_service`, `create_task`, `decide_approval`, `finish_task`,
  `get_workspace_runtime`, `list_agents`, `list_approvals`,
  `register_deliverable`, `report_progress`, `request_approval`,
  `request_review`, `search_tasks`, `set_dependencies`. The scenario catalog
  scopes modes to the coverage the suite drives (adds `skill_test`, restricts
  optional reads to `standard`); the live catalog encodes the runtime exposure
  policy (opens optional reads to `ask`/`planning`, keeps terminal writes
  `standard`-only). Reconcile to one canonical policy in the follow-on.
- **Input-schema shape (shared mutations and some reads):** the scenario
  descriptor keeps idempotency out-of-band and omits provider bounds; the live
  provider descriptor threads `idempotencyKey` in-band and adds length/pattern
  bounds for the model. Unify the schema in the follow-on.

## Legacy MCP aliases

Legacy MCP aliases are indexed in `spec/capability/mcp-tool-map.yaml`
(`inventoryRole: legacy_alias_index`, generated from `packages/mcp-server`). Each
alias row carries a `foldedInto` disposition linking it to the native eval/
operation that now covers its behavior; the reconciliation drift test asserts
every row has one. The authority additionally records the direct native
operation for the well-known aliases (for example `paperclipListAgents` →
`list_agents`, `paperclipGetAgent` → `get_agent`, `paperclipListIssues` →
`search_tasks`, `paperclipCreateIssue` → `create_task`).

## Deliberate decisions recorded for the surface-ledger and eval tasks

This increment makes **no runtime behavior change** — both catalogs keep their
exact current surfaces, so the live golden and scenario suites are unchanged.
The reconciliation records the following decisions to be executed by the
schema-migration follow-on and consumed by the real-surface-ledger (deliverable
B) and eval (deliverable F) tasks:

1. Collapse `src/tools/` and `src/semantic-tools/` catalog lists into
   derivations of `src/catalog/reconciliation.ts`, so there is one source of
   truth and the second module is compatibility-only.
2. Unify the `generic_api_request` claim to a single test-only grant.
3. Choose one canonical task-mode policy per operation (the ledger's 15 task-mode
   divergences).
4. Unify the input-schema shape (idempotency handling and provider bounds) —
   this changes the live provider schemas the model sees and the generated
   `semantic-tool-contracts.json` golden, and therefore requires live/browser
   re-QA.
5. Decide the placement of the 13 scenario-only and 4 live-only operations on the
   unified surface (which become always/optional, which stay scenario/eval-only,
   which gain a live binding).

## Verification

- `src/catalog/reconciliation.test.ts` — pins the op-set relationship, requires a
  reconciliation entry and full metadata for every union operation, classifies
  real-binding status, and requires a disposition for every divergence.
- `src/catalog/catalog-docs.test.ts` — recomputes the catalog counts and
  membership in `docs/capability-semantic-tools.md` from the catalog so a stale
  hand count fails.
