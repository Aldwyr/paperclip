# Paperclip runner production-readiness plan

Status: complete

This plan tracks the end-to-end cutover to one production architecture:

```text
Paperclip control plane
  <-> authenticated durable PRP
paperclip-runnerd (the only Paperclip-owned process in the sandbox)
  <-> provider-native protocol
Codex / another provider
```

TypeScript may host the external mock control plane, eval orchestration, and UI. It must not be a second in-sandbox dispatcher or daemon.

## Exit criteria

The work is complete only when all of these are supported by current artifacts and test evidence:

- every live-roster outcome is retained and classified as infrastructure, provider lifecycle, eval-system, genuine model behavior, or flaky/underspecified;
- infrastructure retries are bounded, limited to explicitly retryable classes, and visible in reports;
- every canonical protocol action and discovery gateway maps to deterministic and live coverage, fixtures, matchers, gaps, and workflow coverage;
- reports reproduce overview, latest runs, definitions, attempts, correlated assertions, fixture/execution boundaries, state diffs, metadata, usage, and failures from retained artifacts;
- the runner lab uses the external mock control plane -> PRP -> runnerd -> provider path used by evals;
- recovery, authorization, drift, idempotency, bounds, cleanup, secret isolation, transcript, accounting, and state reconstruction have deterministic proof;
- a gated GPT-5.4-mini eval, complete mini roster, regenerated report, and interactive lab smoke pass;
- canonical docs describe one architecture and both repositories are committed, pushed, and clean.

## Work phases

### 1. Audit and preserve evidence

- Inventory current roster findings and retain all failed attempt diagnostics.
- Compare the 41-action catalog, discovery gateways, 106 deterministic cases, old skill requirements, current live roster, fixtures, and matchers.
- Audit report routes and UI behavior against every report exit criterion.
- Identify every runner-lab backend path that still constructs the legacy TypeScript live-session dispatcher.

### 2. Runner and PRP reliability

- Give provider-turn, runner-shutdown, transport, provider-exit, and orchestration failures distinct structured classifications.
- Retain bounded stderr, lifecycle, command, cursor, outbox, and state-directory diagnostics on failure.
- Ensure runner shutdown explicitly terminates the provider process group after durable flush.
- Add repeated fake-provider regression coverage for turn completion followed by shutdown.
- Implement bounded retry policy in the roster orchestrator for retryable infrastructure failures only.

Gate: deterministic Rust/TypeScript bridge and recovery suites pass repeatedly, followed by one GPT-5.4-mini eval.

### 3. Coverage completion

- Generate a reviewable coverage matrix from canonical catalogs and eval inventory.
- Port old-skill behavioral requirements as protocol requirements where still applicable.
- Add missing positive, negative, malformed-input, authorization, redaction, ordering, idempotency, state-transition, discovery, and workflow cases.
- Prefer composable fixture fragments over duplicated company snapshots.
- Validate that every requirement has a deterministic test or a documented reason why only a live eval applies.

### 4. Report completion

- Make artifacts the sole source for reproducible static reports.
- Test newest-first selection and latest test/model/configuration matrix semantics.
- Test navigation and clickable definitions/attempts.
- Correlate assertions to exact transcript/tool/state events.
- Render metadata, usage/cost, fixture state, execution boundary, before/after diffs, and partial/error/timeout states.

### 5. Runner-lab cutover

- Replace the issue-thread lab's legacy TypeScript execution service with the shared durable runner session orchestration used by evals.
- Expose start, interrupt, stop, reconnect, and new-session lifecycle operations through the external mock control plane.
- Project retained eval attempts and live sessions through shared transcript, tool-event, fixture-state, state-diff, usage, and identity models.
- Preserve the existing devtools tabs and navigation while making the session backend runnerd-based.

Gate: `http://127.0.0.1:4184/#/chat` completes a real mini turn and proves the runnerd topology.

### 6. Final verification and delivery

- Run the full deterministic verification suite.
- Run the complete GPT-5.4-mini roster with bounded spend and reported retries.
- Regenerate and inspect the HTML report.
- Smoke-test the runner lab through runnerd.
- Record passes, behavior failures, infrastructure failures, retries, tokens, cost, and remaining limitations.
- Update canonical operating/architecture/failure-investigation docs.
- Commit and push each repository and verify clean worktrees equal their remote refs.

## Completion evidence

- The eval CLI and runner lab both use external TypeScript mock control-plane
  orchestration -> authenticated durable PRP -> Rust `paperclip-runnerd` ->
  Codex. No TypeScript Paperclip daemon runs in the sandbox.
- Provider-turn, runner-shutdown, runner-exit, and eval-orchestration failures
  are structured and retained with bounded lifecycle diagnostics. Roster retries
  are capped and restricted to explicitly retryable artifacts.
- `protocol-coverage.json` and the eval `coverage-matrix.json` trace all 41
  canonical actions, both discovery gateways, 106 old-skill requirements, 35
  live cases, workflows, matchers, fixtures, and 12 lifecycle requirements.
  All 41 actions have an exact deterministic contract; 29 additionally map to
  legacy behavioral scenarios rather than conflating the two measures.
- Deterministic verification passed: 559 TypeScript tests, 48 Rust unit tests
  plus Rust integrations, 25 eval-framework tests, durable recovery, and a
  two-turn real GPT-5.4-mini runner-lab smoke.
- The final GPT-5.4-mini roster `20260820-production-readiness-final` passed
  35/35 with zero retries. The prior run's two behavior findings are retained;
  both were underspecified authored prompts and passed targeted and full reruns
  after the intended tool steps were made explicit.
- The static report was regenerated from 272 retained attempts at
  `paperclip-evals/evals/paperclip-runner/.runtime/report/index.html`; it includes
  overview/latest/inventory/test/attempt routes, correlated assertions, fixture
  and execution boundaries, state/devtools views, model/config/build/timing,
  usage/cost, navigation, and explicit failure states.

Passing isolated tests was not treated as sufficient: the release gate includes
the complete roster and a real multi-turn lab session through runnerd.
