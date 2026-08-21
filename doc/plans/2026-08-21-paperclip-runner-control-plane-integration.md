# Paperclip runner control-plane integration

Date: 2026-08-21
Status: accepted / in progress

## Objective

Make the Rust `paperclip-runnerd` architecture a production-ready, selectable
Paperclip agent adapter while preserving every existing runner.

The finished local topology is:

```text
Paperclip server/control plane
  <-> authenticated durable PRP
paperclip-runnerd
  <-> Codex app-server protocol
Codex
```

A user can create or edit an agent, choose **Paperclip Runner**, select Codex as
its provider, run it against a real Paperclip issue, and observe the complete
run in the existing Paperclip task thread.

## Working rules

- Work only on `PAP-16679-paperclip-runner`; create no branch or pull request.
- Commit and push cohesive milestones on this branch.
- If evals change, work only on the existing `paperclip-evals` `main` branch,
  commit there, and push throughout.
- Preserve existing changes. Verify each phase before proceeding.
- Use deterministic tests first and GPT-5.4-mini only for bounded live checks
  unless another paid model is explicitly authorized.
- Continue until the definition of done is met or a genuine external blocker is
  recorded with evidence.

## Current state

- Rust runnerd, durable PRP, the Codex provider bridge, semantic tools, recovery,
  the mock control plane, runner lab, and eval suite already exist.
- The real app does not launch runnerd or serve a production PRP connection.
- The app has an experimental in-process TypeScript native path. It is not the
  intended Rust sandbox architecture.
- Production semantic conformance currently binds only a narrow action subset.
- Most canonical protocol actions still report an unbound real service.
- Runnerd accepts loopback `ws://` only. That is sufficient locally, not for
  Daytona.
- Existing direct adapters must keep their current behavior.

## Architecture decisions

### Adapter and compatibility

Add one built-in adapter:

```json
{
  "adapterType": "paperclip_runner",
  "adapterConfig": {
    "provider": "codex"
  }
}
```

- Display it as **Paperclip Runner** with a provider selector that initially
  offers only Codex.
- Reuse compatible Codex model, instructions, environment, authentication,
  timeout, and command settings.
- V1 is runnerd plus Codex app-server; do not expose unsupported engines.
- Keep `codex_local` and every other adapter as direct/legacy choices.
- New native runs are selected only by `paperclip_runner`, not the experimental
  `codex_local` runtime toggle.
- Preserve read/finalization compatibility for persisted experimental records.

### Control-plane security boundary

Expose a versioned PRP WebSocket endpoint at `/api/runner/v1/connect`.

- Mint a short-lived, one-time bootstrap capability bound to company, agent,
  run, issue, environment lease, runner instance, session, turn, runner version,
  and binary digest.
- Never persist the raw ticket. Inject it only into runnerd's initial
  environment and exchange it for a renewable/revocable PRP lease.
- Reject expired, replayed, revoked, cross-company, mismatched, malformed,
  oversized, and protocol-incompatible connections.
- Revoke on stop, cancel, timeout, supersession, or environment-lease loss.
- Do not give runnerd a broad Paperclip API key or put business authorization in
  Rust.
- Runnerd forwards semantic calls over PRP. Paperclip executes them through the
  same application authorities as REST.
- Extract shared service/command functions where route handlers contain the only
  implementation of an invariant. Never duplicate authorization, scoping,
  idempotency, approval, budget, status, or activity-log rules.

### Action authority

Create a production dispatcher derived from the canonical protocol catalog.

For every action:

- Map it to an existing Paperclip route/service authority.
- Derive actor, company, run, issue, user attribution, capabilities, and
  environment from the authenticated PRP binding.
- Validate canonical input/output schemas.
- Preserve company scoping, authorization, idempotency, conflicts, and audit.
- Return stable redacted receipts or denials.
- Never advertise an unbound action.
- Keep governed actions undiscoverable without authorization.
- Make discovery reflect the exact run's available actions.
- Update real binding metadata from implementation evidence.

Test-only Express/supertest routing can guide the mapping but must not become the
production dispatcher.

### Process and artifact lifecycle

- Resolve runnerd only from an explicit bundled/configured artifact and verify
  SHA-256 plus build metadata before launch; never silently search `PATH`.
- Support explicit development artifact path/digest and package a qualified
  binary for normal installs without runtime Rust compilation.
- Start runnerd through the execution-target/environment abstraction in the
  realized workspace with a private run-scoped durable state directory.
- Pass only allowlisted provider environment and credentials.
- Record runner/provider processes, artifact identity, model, session, usage,
  cost, reconnect state, and bounded terminal diagnostics.
- Cancellation interrupts Codex, terminates the process group, flushes durable
  terminal evidence, and releases the environment lease.
- Restart/reconnect preserves identity without duplicate tool effects.

## Work phases

### 1. Baseline and binding inventory

- Push existing unpushed commits in both allowed repositories.
- Run focused runner, native-runtime, semantic-conformance, interaction, and
  eval-framework tests.
- Check in a complete 41-action mapping to real endpoint/service authority,
  authorization, mutation/audit behavior, idempotency, and status.
- Compare the protocol with old Paperclip skill behavior and current evals.
- Separate persisted-run compatibility code from removable in-process runtime.

Gate: every action is unambiguously classified.

### 2. Selectable Paperclip Runner adapter

- Register `paperclip_runner` in shared constants, server/UI registries,
  capabilities, model/config endpoints, environment support, telemetry, and
  import/export.
- Add configuration UI with Codex provider, model/auth, and compatible settings.
- Test runner artifact, Codex/auth, workspace/state paths, and PRP reachability.
- Preserve adapter-agnostic settings across creation, editing, import/export,
  and switching.

Gate: it is configurable while all direct adapters remain available.

### 3. Production PRP control plane

- Add the authenticated WebSocket upgrade route and durable session manager.
- Persist/reuse only the state needed for bootstrap, lease, command cursors,
  replay, and revocation.
- Integrate PRP events with heartbeat run/event storage and replay conflicts.
- Support prepare, authorized tools, provider config, open/resume, turn start,
  semantic results, interrupt, suspend, drain, and revoke commands.
- Enforce frame, storage, time, replay, reconnect, command, and call bounds.
- Classify bootstrap, auth, protocol, runner, provider, authority, and
  finalization failures.

Gate: authentication and the durable fault matrix pass against the real server
session manager.

### 4. Complete protocol binding

- Bind task context/history/search, comments/progress, task lifecycle,
  blockers/dependencies, documents, interactions, approvals, deliverables,
  agents, projects, goals, routines, cases, skills, secrets, workspaces, wakes,
  exports, status questions, operation inspection, discovery, and privileged
  administration where authorized.
- Preserve trust, budget, review, approval, secret, revision, interaction,
  status, and activity invariants.
- Omit unavailable actions from discovery rather than stubbing success.
- Cover positive, denial, cross-company, malformed, stale, retry, conflict,
  redaction, and governed-action cases.

Gate: every advertised action has a real binding and deterministic proof.

### 5. Local heartbeat execution through runnerd

- Launch verified runnerd from `paperclip_runner` with PRP identity, ticket,
  workspace, durable state, provider config, and bounded runtime.
- Feed structured results through existing heartbeat cost, workspace,
  finalization, status arbitration, recovery, and watchdog paths.
- Preserve direct execution for every other adapter.
- Verify continuation, response wake, stop, timeout, server restart, runner
  restart, and shutdown.

Gate: a real Paperclip heartbeat traverses server -> PRP -> runnerd -> Codex and
back without a mock control plane or TypeScript sandbox dispatcher.

### 6. Existing task-thread integration

- Store PRP/provider/semantic events as structured run events.
- Render provider reasoning summaries as collapsed Thinking entries. Never
  request, store, or claim to expose hidden chain-of-thought.
- Render intermediate assistant output as run-bound thread activity and persist
  the final response as one normal agent-authored issue comment.
- Render correlated semantic calls/results/denials with timing and details.
- Materialize confirmations, checkboxes, questions, task suggestions, and item
  verdicts through existing issue-thread interactions.
- Ensure responses create one continuation and no transient not-pending error.
- Use existing documents/revisions for plans and existing review, approval,
  work-product, attachment, workspace, and status components.
- Show model/provider, artifact identity, run/session, duration, usage, cost,
  environment, and terminal state with progressive disclosure.

Gate: browser coverage and a manual local run demonstrate the ordered thread,
interaction continuation, document mutation, final comment, usage, and finish.

### 7. Evals and reports

- Retain the mock suite for protocol isolation and fault injection.
- Add a real-Paperclip environment that boots the server/database, creates a
  `paperclip_runner` agent and fixture company, invokes a heartbeat, and checks
  persisted state.
- Use composable fixture fragments.
- Cover selection, auth, bindings, context, progress, documents, interactions,
  continuation, delegation, denial, discovery, finalization, cancellation,
  recovery, accounting, and company isolation.
- Retain model/config, package/runner digest, transcript, semantic calls,
  correlated assertions, before/after state, failures, usage, and cost.
- Regenerate and inspect overview/latest/test/attempt HTML pages.
- Run one targeted GPT-5.4-mini case, then the bounded affected mini roster.

Gate: deterministic real-server evals and the bounded live roster pass or have
fully classified retained failures, with current HTML reports.

### 8. Daytona follow-up design

Do not implement Daytona in this work. Document this later topology:

```text
Daytona sandbox
  paperclip-runnerd
    -> outbound WSS
       reachable Paperclip /api/runner/v1/connect
```

- No inbound sandbox port.
- Add runner `wss://`, certificate validation, DNS/non-loopback policy, and any
  required proxy behavior.
- Require WebSocket upgrades at Paperclip's reverse proxy.
- Keep the bootstrap ticket short-lived and separate from provider credentials.
- Use a digest-pinned sandbox image and durable workspace volume for state.
- Restrict egress to Paperclip and explicitly required provider/package hosts.
- Specify remote lease/suspend/restart/reconnect/upgrade/secret/process tests.
- Record current blockers and the exact future acceptance test.

## Required verification

- Existing adapters keep their old execution paths.
- `paperclip_runner` selects runnerd plus Codex; unknown providers fail.
- Wrong runner digest/version fails before provider startup.
- Bootstrap replay, expiry, reuse, binding mismatch, and cross-company use fail.
- Reconnect/lost ACK cannot duplicate events or mutations.
- Semantic calls cannot forge identity or authorization.
- Discovery changes with real policy and task mode.
- Every exposed action has success and denial coverage.
- Idempotent retry reuses one effect; conflicting retry fails.
- Secrets do not enter logs, events, state, reports, arguments, or stored tickets.
- Messages, thinking summaries, tools, diffs, final comments, and usage are ordered.
- Every interaction kind renders/resolves and wakes the right session once.
- Documents preserve revision conflicts.
- Stop, timeout, crashes, restart, and workspace failure settle correctly.
- Cost, budget, workspace, recovery, review, approval, and status remain intact.
- Token design gates pass for UI changes.
- Focused gates pass first, then full typecheck, tests, build, relevant browser
  suites, and eval verification.

## Definition of done

- Paperclip Runner is selectable with Codex while old adapters remain unchanged.
- A real local server launches verified Rust runnerd over authenticated PRP.
- Runnerd launches Codex without a broad Paperclip API credential.
- Paperclip executes semantic calls through its real authorities.
- Every advertised action is production-bound and tested.
- The existing thread shows run output, tools, interactions, documents, final
  response, model, usage, cost, and terminal state.
- A local browser smoke passes without mock control plane or TypeScript sandbox
  dispatcher.
- Deterministic and bounded mini eval evidence appears in updated HTML reports.
- The Daytona follow-up is concrete.
- Canonical architecture, adapter, protocol, operations, failure, and eval docs
  are current.
- Cohesive commits are pushed on the two existing branches, both worktrees are
  clean and equal their remotes, and the final report includes commits, tests,
  eval IDs/report paths, demonstrated workflow, and remaining limitations.

## Implementation ledger (2026-08-21)

- Complete: selectable `paperclip_runner` adapter with legacy adapters retained.
- Complete: Rust runnerd is the sole Paperclip sandbox proxy; Codex is the first
  provider and provider-specific TypeScript is outside the sandbox process tree.
- Complete: shared real-server PRP endpoint
  `/api/runner/v1/connect/:runId`, run-bound authority registration, bootstrap
  ticket/lease authentication, malformed/unknown run rejection, and buffered
  WebSocket upgrade handling.
- Complete: deterministic real-server vertical slice using embedded Paperclip
  Postgres, an active native heartbeat run, the shared server route, Rust
  runnerd, fake Codex, and the real `get_task_context` service authority.
- Complete for the current production catalog: 14 advertised operations are
  real-service bound. All 41 canonical actions have an explicit
  bound/withheld/prohibited disposition in the binding roster; unbound actions
  are absent rather than stubbed.
- Complete: existing task-thread projection, structured interactions, exact-once
  continuation fixes, model/usage/cost metadata, and Runner Lab DevTools reuse.
- Complete: coverage matrix and HTML Inventory tab include the shared PRP and
  real-server deterministic owners; the live report remains model-result-only.
- Verified: focused server/runner tests and typechecks. The Runner Lab server
  contract suite passed 68/69 in one parallel run; the sole 2-second resume
  timeout passed immediately in isolation and is retained as a timing-flake
  finding rather than hidden.
- Environment limitation: this Codex session exposed no in-app browser backend,
  so the manual `:4184` click-through remains to be performed even though the
  package server and projection tests pass.
- Intentionally deferred by this plan: remote Daytona/WSS implementation. The
  checked-in Daytona networking thesis remains the follow-up contract.
