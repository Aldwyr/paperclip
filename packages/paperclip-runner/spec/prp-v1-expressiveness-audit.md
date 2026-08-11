# PRP v1 expressiveness audit

## Verdict

PRP v1 is sufficient for runner lifecycle, replay integrity, negotiated runner
features, runtime/issue-thread request routing, structured work disposition,
and terminal causality. It is **not** yet sufficient to claim a provider-neutral
semantic-control-plane protocol: tool invocation, authorization denial,
redaction, optimistic concurrency, mutation receipts, and budget stop reasons
are presently represented only by event or request `payload` extension space.

`prp-v1-expressiveness-crosswalk.json` is the machine-checked source for this
verdict. Its Vitest gate rejects an unclassified required fact, a fact justified
only by a permissive field, an unbounded control-plane-local fact, or an
accepted additive change without required fixtures.

## Evidence boundary

This audit compares the canonical capability authority and its traceability
inputs, the real-surface ledger, the deterministic mock, live Codex/runnerd
transport, and PRP schemas/replay fixtures. The wire contract is not the tool
catalog: capability placement controls exposure, while PRP carries execution
and causality. `generic_api_request` remains test-only and cannot satisfy any
coverage row.

## What v1 proves directly

- `capabilities.schema.json` negotiates driver identity, session reuse,
  steering, interruption, resume, runtime requests, structured results, typed
  events, and explicit unsupported features.
- Events have stable source instance/event ids, source ordering, run/session/
  turn/item correlation, priority, and an explicit v1 schema version. Replay
  rejects unsupported required event versions, requires byte-equivalent
  duplicate source events, records source gaps, and is side-effect free.
- Commands have controller ordering and preconditions; runtime and issue-thread
  requests have typed kinds/statuses; results require completion claims,
  verification, artifacts, and blocker/yield continuations where applicable.
- `run.terminal` is a typed terminal envelope with terminal state, work
  assessment, and issue-status decision references. Existing golden replay,
  duplicate-event, unknown-optional-fields, and unsupported-required-version
  fixtures demonstrate the compatibility boundary.

## Required additive v1 envelope

The smallest correction is one optional, versioned `semantic_tool` envelope
for `mcp_app.tool_input` / `mcp_app.tool_result` (or equivalent new event
types), plus an optional `terminal.stopReason` envelope. It must define:

- operation id, call id, correlation ids, idempotency key, outcome, stable
  code, retryability, and audit/operation receipt id;
- admitted input/output references or digests, redaction disposition, and only
  safe identifiers; never raw credentials, hidden-company identifiers, or
  secret payloads;
- authorization boundary (`company`, `actor`, `active_task`, `grant`,
  `governed_action`, `lock`, or `revision`), current revision where safe, and
  a deterministic conflict/duplicate result;
- artifact/work-product references linked to the semantic receipt and terminal
  result; immutable interaction/approval document or decision targets; and
  budget stop reason/aggregate/decision id.

This is additive because existing v1 consumers can ignore the optional typed
envelope. It is not permission to add speculative semantic events: the
crosswalk names the exact facts and the conformance vectors that must land
with any schema change.

## Classification and fixture plan

The crosswalk assigns every required fact to exactly one of: direct v1,
compositional v1 with a listed invariant, control-plane-local, additive v1,
missing fixture/docs, or breaking v2 work. Direct and compositional support is
never inferred merely from `additionalProperties: true`.

Before an additive change graduates to direct support, add these fixtures and
golden projections:

1. semantic tool happy path and artifact registration;
2. denied operation with redaction assertions and no fallback call;
3. stale optimistic write conflict and exact duplicate/retry receipt;
4. immutable interaction/approval target plus wake/monitor causal chain;
5. budget/cost terminal stop reason;
6. unknown optional envelope fields accepted without changing v1 projection;
7. unknown required envelope version rejected fail-closed.

Each mutation fixture must replay to a golden summary/snapshot and be executed
through mock and real adapters with normalized receipt/state-diff comparison.

## Explicit exclusions

Checkout/release, task selection, wake routing, budget enforcement, audit and
run persistence/replay, assignment, and monitor management are control-plane
actions, not runner-wire semantic operations. Cross-company discovery, broad
audit access, destructive document lifecycle, and company administration are
breaking v2/product-governance work. The runner must report typed unavailable
or denied outcomes rather than tunnel those operations through generic payloads.

## Review checklist

- Golden replay, duplicate/retry, and unknown-version fixtures accompany every
  accepted protocol schema/event addition.
- A semantic receipt is typed and safe before any surface is marked supported.
- Control-plane-local decisions stay out of the semantic tool wire.
- Fixture/document debt is recorded separately from a protocol semantic gap.
