# Provider-neutral runner events and Runner Lab UX

Status: Implemented and qualified
Date: 2026-08-21
Owners: Runner protocol, provider adapters, Runner Lab, task-thread UI
Working branch: `PAP-16679-paperclip-runner` only; do not create or switch branches

## Implementation record

- All 15 provider-neutral families are schema-bound, negotiated, normalized in
  TypeScript and Rust, durably replayable, publicly projected, and represented
  by stable Runner Lab scenarios.
- Codex's closed 18-variant thread-item inventory is explicitly mapped or
  classified; OpenCode advertises unsupported/policy-disabled families rather
  than synthesizing structure.
- Package build, TypeScript/Rust suites, replay/conformance checks, server/UI
  integration tests, desktop/390px Runner Lab checks, and live Codex/OpenCode
  smoke tests pass.
- OpenCode full-roster qualification `opencode-full-clean-20260821` completed
  all 35 cases with zero infrastructure failures. Its sole initial scoring miss
  was an eval projection of a successful lazy-gateway result; the immutable
  artifact was retained, the projection was corrected, and
  `opencode-lazy-projection-fix-20260821` passed on the first attempt.
- A rebuilt OpenCode accounting probe preserved input, output, reasoning, and
  cached-token counts as numeric facts while continuing to redact credential
  tokens; model-priced estimated cost was populated from the canonical usage
  event.
- The OpenRouter key remains only in the ignored local `paperclip-evals/.env`.

## Summary

Promote the useful structure exposed by Codex, OpenCode, and future harnesses into
provider-neutral Paperclip Runner Protocol (PRP) event families. Render those
events consistently in Runner Lab and the production task thread without making
Codex's app-server schema the Paperclip contract.

The current Codex 0.148.0 app-server schema exposes 72 notification methods and
18 thread-item variants. Paperclip already handles assistant text, selected
reasoning/plan activity, semantic operations, approvals, usage, workspace
changes, workspace file references, and partial child-thread lineage. Other
useful signals are either retained only inside generic `item.*` payloads,
reduced to a coarse activity label, or ignored.

This plan adds first-class support for:

1. structured plans;
2. command and process execution;
3. MCP and dynamic tool progress;
4. web research;
5. delegation and subagents;
6. model routing, verification, and safety buffering;
7. context compaction;
8. viewed and generated artifacts, including images;
9. review mode;
10. hook execution;
11. memory citations;
12. automated safety/guardian reviews;
13. terminal input activity;
14. intentional waits/sleeps; and
15. provider warnings and deprecations.

Every capability receives a deterministic Runner Lab scenario. The same view
model and component must render preset scenarios, replayed artifacts, and real
dynamic chats; fixture-only components are forbidden.

## Goals

- Preserve provider structure that materially improves user trust and
  comprehension.
- Define stable Paperclip semantics that can be produced by Codex, OpenCode,
  Claude Code, Pi, managed agents, and future cloud harnesses.
- Keep run, turn, item, session, model, and authority attribution durable.
- Keep secrets, hidden chain-of-thought, unrestricted process output, and raw
  provider payloads outside public records.
- Make Runner Lab the visual and protocol acceptance surface for every event
  family.
- Maintain recovery, replay, ordering, deduplication, and cross-provider parity.
- Allow a provider to declare a family unsupported without fabricating events.

## Non-goals

- Mirroring every Codex app-server notification one-for-one.
- Exposing hidden chain-of-thought or raw reasoning text.
- Making experimental or unstable Codex fields mandatory for other providers.
- Turning Runner Lab into a full IDE, terminal emulator, browser, or image
  editor.
- Retaining unbounded command output, web results, hook output, or MCP payloads.
- Enabling provider features such as image generation merely because an event
  schema exists; feature enablement remains a separate policy decision.

## Architectural decisions

### 1. Canonical event families, not provider method names

Provider drivers translate native events into closed PRP families. A provider
method may map to multiple canonical events, and multiple provider methods may
map to one canonical event. Provider method names may appear only in bounded
operator/debug metadata, never as the semantic discriminator consumed by UI.

Recommended families:

| Family | Canonical events |
| --- | --- |
| Plan | `plan.updated` |
| Tool execution | `tool.execution.started`, `tool.execution.progressed`, `tool.execution.completed` |
| Research | `research.started`, `research.progressed`, `research.completed` |
| Delegation | `delegation.started`, `delegation.updated`, `delegation.completed` |
| Model | `model.route.changed`, `model.verification.updated` |
| Context | `context.compacted` |
| Artifact | `artifact.viewed`, `artifact.generated` |
| Review | `review.mode.changed` |
| Hooks | `hook.started`, `hook.completed` |
| Citation | `memory.citation.referenced` |
| Safety | `safety.review.started`, `safety.review.completed` |
| Terminal | `terminal.input.sent` |
| Wait | `wait.started`, `wait.completed` |
| Notice | `provider.notice.recorded` |

`workspace.change.updated`, `workspace.diff.recorded`, and
`workspace.file.referenced` remain their existing separate families.

### 2. Three data layers

Each provider event passes through three explicit layers:

1. **Provider input** — native, ephemeral, version-specific.
2. **Canonical durable event** — bounded PRP schema, provider-neutral, replayable.
3. **Public projection** — least-privilege task-thread/Runner Lab DTO.

No UI reads provider input directly. DevTools may show a redacted canonical
debug envelope, but not an unbounded native payload.

### 3. Capability negotiation

Replace the informational `typedEvents: true` assumption with an explicit
negotiated roster while retaining the boolean for protocol-v1 compatibility:

```ts
typedEventFamilies?: Array<{
  family: string;
  version: 1;
  availability: "available" | "unsupported" | "policy_disabled";
  detailLevel: "summary" | "structured";
}>;
```

Existing peers without this field continue to negotiate the current baseline.
Drivers must not emit a family/version the control plane did not accept.

### 4. Attribution and ordering

Every new event carries:

- `runId`, `turnId`, and `itemId` where applicable;
- normalized session and source instance through the PRP envelope;
- a provider-neutral stable correlation ID;
- start/progress/terminal revision or sequence;
- provider and exact model when the event changes effective execution identity;
- timestamps from the emitting authority plus control-plane observation time.

Terminal events are idempotent. Progress may be coalesced for rendering but is
never allowed to reorder start or completion.

### 5. Redaction and retention

- Never retain hidden chain-of-thought.
- Plan text and reasoning summaries are treated as explicit assistant output,
  not chain-of-thought, but remain bounded and redacted.
- Command output, hook output, MCP results, research snippets, and generated
  prompts use byte/count limits and the shared secret redactor.
- `terminal.input.sent` never carries stdin content. It records only the target
  process correlation, byte count, input class, and whether input was
  user-originated or agent-originated.
- URLs are normalized and bounded; credentials, fragments containing secrets,
  and local host paths are removed from public projections.
- Image/generated-file paths must resolve inside the authorized workspace or to
  a registered Paperclip artifact.
- Raw provider payloads are not included in snapshots, eval artifacts, reports,
  or browser frames.

### 6. Shared UI implementation

Runner Lab preset scenarios, Runner Lab dynamic chats, replay pages, and the
production task thread use the same discriminated view types and components.
Each component supports:

- compact inline state;
- progressive disclosure for detail;
- running, successful, failed, interrupted, and unavailable states;
- keyboard and screen-reader operation;
- bounded mobile layout;
- provider-neutral copy;
- an evidence/debug link when richer detail exists.

Fixtures construct canonical events or the canonical projection input. They do
not inject component-specific props that a live session cannot produce.

## Capability workstreams and scenarios

### A. Structured plans

**Provider inputs**

- Codex `plan` items, `item/plan/delta`, and `turn/plan/updated`.
- OpenCode todo/plan parts or plugin events when available.
- Harnesses without structured plans remain unsupported.

**Canonical payload**

```ts
interface PlanUpdatedPayload {
  schema: "paperclip.plan.updated.v1";
  planId: string;
  revision: number;
  explanation: string | null;
  steps: Array<{
    stepId: string;
    body: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
  }>;
  complete: boolean;
}
```

Step IDs are stable across revisions where the provider supplies identity;
otherwise the driver deterministically reconciles normalized text and position.
An authoritative snapshot replaces prior status for the same revision; deltas
never become the authoritative final plan.

The control plane also synchronizes a completed authoritative plan into the
issue's `plan` document under the run actor's attribution. Plan text streams as
live run activity while the provider is generating it, but live deltas never
write document revisions. Provider completion of the plan item/snapshot is the
commit point and creates one issue-plan revision immediately without waiting for
the overall turn to finish. A later completed plan regeneration creates another
revision; status-only execution progress does not. Synchronization uses
optimistic concurrency, records the source run/turn/plan revision, and emits a
typed conflict rather than overwriting a concurrent board or agent edit.

**UI**

- Inline checklist with completed, active, blocked, and pending steps.
- Collapse completed plans after terminal turn, preserving a one-line summary.
- Show explanation separately from step text.
- Never label planning as Codex-specific.

**Runner Lab scenario**: `pe-structured-plan`

- Three revisions: initial plan, active-step transition, terminal completion.
- Includes step insertion and one blocked step to test reconciliation.
- Visual assertions: stable order, status glyphs, revision detail, mobile fold.

### B. Command and process execution

**Provider inputs**

- Codex `commandExecution`, `commandActions`, output deltas, terminal
  interaction, exit code, duration, cwd, and process ID.
- OpenCode shell/tool parts and process status.

**Canonical payload**

`tool.execution.*` uses a shared execution identity and:

- `transport`: `process | mcp | dynamic | builtin`;
- `operation`: `read | search | list | execute | edit | unknown`;
- safe display name and workspace-relative target;
- command preview only when allowed;
- status, duration, exit code, output summary, truncation metadata;
- process correlation kept operator-only unless needed to deliver input.

Process output is chunked and capped per event and per execution. Completion
contains a digest and aggregate counts so replay can prove coalescing parity.

**UI**

- Semantic labels such as Read, Search, List files, and Run command.
- Live output drawer for execution, with explicit truncation.
- Exit badge and duration; failed commands remain visually distinct from a
  failed overall turn.
- Group repeated reads/searches without hiding failures.

**Runner Lab scenario**: `te-command-execution`

- Read, search, successful shell command, failed shell command, and truncated
  streaming output.
- Visual assertions: classifications, live/terminal states, exit code,
  duration, output expansion, secret redaction.

### C. MCP and dynamic tool progress

**Provider inputs**

- Codex `mcpToolCall`, `item/mcpToolCall/progress`, and `dynamicToolCall`.
- OpenCode MCP tool parts and runner-owned MCP bridge receipts.

**Canonical mapping**

Use `tool.execution.*` with `transport: "mcp" | "dynamic"`, preserving:

- canonical tool ID when it is a Paperclip semantic operation;
- otherwise bounded namespace/server/tool display names;
- read-only hint;
- progress message;
- duration and success/error state;
- MCP App resource linkage through existing `mcp_app.*` events.

Paperclip semantic calls retain their existing authorization/result evidence;
the execution event is presentation state and may not become a second source of
authority.

**Runner Lab scenario**: `mp-mcp-progress`

- Read-only MCP call with two progress updates.
- Mutating semantic call with correlated authorization evidence.
- Failed MCP call and cancelled call.
- Visual assertions: no duplicate tool rows, canonical-name mapping, progress,
  duration, error disclosure, evidence link.

### D. Web research

**Provider inputs**

- Codex `webSearch` items: search, open page, and find-in-page actions.
- OpenCode web/search tools when identifiable through structured metadata.

**Canonical payload**

`research.*` carries a research session ID, action kind, bounded query, safe URL
metadata, result count, and bounded source summaries. A result source contains
title, normalized URL, provider-reported source type, and optional snippet.
Paperclip does not fetch a URL merely because a provider reported it.

**UI**

- Search query row followed by pages opened and in-page searches.
- Expandable source list with external-link affordances and clear
  provider-reported labeling.
- Final citations may correlate to assistant-message references.

**Runner Lab scenario**: `rs-web-research`

- Search, open, find, duplicate result, malformed URL, and bounded result list.
- Visual assertions: action timeline, URL normalization, deduplication,
  truncation, external-link safety.

### E. Delegation and subagents

**Provider inputs**

- Codex `collabAgentToolCall`, `subAgentActivity`, child `thread/started`, status,
  and closure.
- OpenCode child sessions/tasks when available.

**Canonical payload**

`delegation.*` carries delegation ID, parent item, provider-neutral action
(`spawn | message | resume | wait | close`), child identities, optional role,
requested model, requested reasoning class, status, and bounded status message.
Prompts are not public by default; a bounded task summary may be retained only
when explicitly marked displayable.

**UI**

- Parent timeline row with child count and aggregate state.
- Expandable tree showing child role, provider/model, current task summary,
  duration, and outcome.
- Child activity remains attributable to its originating run and turn.

**Runner Lab scenario**: `da-subagent-delegation`

- Spawn two children, send input, one completes, one waits then is interrupted.
- Includes a child-session restore to verify stable identity.
- Visual assertions: hierarchy, concurrent states, parent/child attribution,
  terminal aggregation.

### F. Model routing, verification, and safety buffering

**Provider inputs**

- Codex `model/rerouted`, `model/verification`, and
  `model/safetyBuffering/updated`.
- OpenCode provider/model changes and provider notices when available.

**Canonical payloads**

- `model.route.changed`: requested model, prior effective model, new effective
  model, normalized reason, provider, and effective-from event sequence.
- `model.verification.updated`: verification classes, buffering state, safe
  user-facing explanation, and optional faster-model alternative.

Usage and cost receipts after a route change must name the effective model.
Persisted run metadata keeps both requested and actual model history.

**UI**

- Inline route-change notice, never silently changing the model badge.
- Non-alarming verification/buffering status with elapsed time.
- DevTools timeline shows the effective model ranges for accounting.

**Runner Lab scenario**: `mr-model-routing`

- Requested model, reroute, safety verification start/end, and usage before and
  after the route boundary.
- Visual assertions: truthful active-model label, reason, accounting split,
  no duplicate notice on replay.

### G. Context compaction

**Provider inputs**

- Codex `contextCompaction` item and legacy `thread/compacted` notification.
- OpenCode compaction/summarization signals where available.

**Canonical payload**

`context.compacted` carries compaction ID, reason class, pre/post token counts
when known, checkpoint reference, and whether continuation remained in the same
provider session. It never contains the hidden summary used by the model.

**UI**

- Timeline divider: “Context compacted; session continued.”
- Token meter reflects the new context state without reducing cumulative billable
  usage.
- Restored warm sessions retain the marker.

**Runner Lab scenario**: `cc-context-compaction`

- Near-window warning, compaction, continued command, and terminal response.
- Visual assertions: context versus cumulative usage, session continuity, replay
  stability.

### H. Viewed and generated artifacts

**Provider inputs**

- Codex `imageView` and `imageGeneration`.
- OpenCode file/image tool results.
- Existing Paperclip documents, deliverables, and workspace references.

**Canonical payloads**

- `artifact.viewed`: registered artifact/workspace reference plus media type;
  never an unchecked absolute path.
- `artifact.generated`: status, media type, registered artifact/workspace
  reference, dimensions when known, transparent-background flag, revised prompt
  only if safe/displayable, and structured failure.

Generated assets should be registered through Paperclip's artifact/work-product
flow before production task-thread display. Runner Lab may use checked-in fixture
assets.

**UI**

- Thumbnail/card, open preview, metadata, and download/open action.
- Generation progress and failure states.
- Reuse the individual-file viewer when the artifact is workspace-backed.

**Runner Lab scenario**: `ag-generated-artifact`

- Image viewed, generation in progress, successful image, transparent output,
  and failed generation.
- Visual assertions: thumbnail, modal preview, safe path, failure, missing-byte
  fallback.

### I. Review mode

**Provider inputs**

- Codex `enteredReviewMode` and `exitedReviewMode` items.
- Equivalent harness modes when declared.

**Canonical payload**

`review.mode.changed` carries mode ID, `entered | exited`, bounded review scope,
and correlation to the resulting review output. It does not replace Paperclip's
governed task-review/approval semantics.

**UI**

- Review-mode banner within the active turn.
- Exit row linked to review findings or final response.
- Distinguish “agent is reviewing code” from “Paperclip approval required.”

**Runner Lab scenario**: `rv-review-mode`

- Enter, inspect files, emit findings, exit, then request Paperclip review.
- Visual assertions: separate provider review mode and control-plane approval.

### J. Hook execution

**Provider inputs**

- Codex `hook/started` and `hook/completed`.
- OpenCode plugins/hooks where structured lifecycle is available.

**Canonical payloads**

`hook.*` carries hook ID, scope, event class, source class, status, duration, and
bounded status summary. Source paths and raw output remain operator-only unless
inside the authorized workspace and explicitly safe.

**UI**

- Compact automation/check row with status and duration.
- Failed blocking hook is prominent; successful hooks collapse.
- DevTools distinguishes provider hooks from Paperclip semantic operations.

**Runner Lab scenario**: `hk-hook-lifecycle`

- Successful pre-turn hook, failing post-tool hook, non-blocking warning hook.
- Visual assertions: ordering, blocking status, output withholding, duration.

### K. Memory citations

**Provider inputs**

- Codex agent-message `memoryCitation` entries and thread IDs.
- Future provider memory/source annotations.

**Canonical payload**

`memory.citation.referenced` carries citation ID, safe source class, stable
Paperclip/provider-neutral reference, bounded label, and message correlation.
Provider thread IDs are translated to authorized session/thread references or
withheld; they are never exposed raw.

**UI**

- “Used memory from…” citation chips below the associated assistant message.
- Authorized Paperclip sources open in place; unavailable sources explain why
  they cannot be opened.

**Runner Lab scenario**: `mc-memory-citations`

- Two authorized citations, one unavailable citation, and duplicate references.
- Visual assertions: correlation, deduplication, unavailable state, no raw
  provider thread ID.

### L. Automated safety/guardian reviews

**Provider inputs**

- Codex auto-approval/guardian review start and completion notifications.
- Equivalent provider safety review lifecycle when available.

**Canonical payloads**

`safety.review.*` carries review ID, target execution when present, action
class, state, normalized decision class, timing, and a safe explanation. The
Codex input is unstable, so its adapter mapping is version-gated and cannot
define the canonical schema.

**UI**

- Temporary “Safety review in progress” state attached to the target tool.
- Completed result states whether execution continued, required a user
  decision, or was denied.
- Never imply Paperclip itself made a provider safety decision.

**Runner Lab scenario**: `sr-safety-review`

- Review attached to a command, network review without a target item, allow,
  deny, and provider-schema downgrade.
- Visual assertions: correlation, provider attribution, unstable-version
  fallback.

### M. Terminal input activity

**Provider inputs**

- Codex terminal-interaction notifications.
- OpenCode PTY/stdin tool events.

**Canonical payload**

`terminal.input.sent` carries execution ID, input origin, input class
(`text | control | eof`), byte count, and timestamp. It explicitly excludes
stdin content.

**UI**

- Small child row under the running command: “Agent sent input” or “You sent
  input.”
- Control characters use semantic labels such as Interrupt or EOF.

**Runner Lab scenario**: `ti-terminal-input`

- Agent text input, user input, control-C, and EOF.
- Visual assertions: no content leakage, correct origin, correlation, sequence.

### N. Intentional waits and sleeps

**Provider inputs**

- Codex `sleep` item.
- Harness wait/timer primitives.

**Canonical payloads**

`wait.*` carries wait ID, reason class, planned duration, elapsed duration, and
terminal state. It is distinct from runner warm-idle and waiting-for-human
lifecycle states.

**UI**

- Countdown/progress row while active.
- “Wait completed” or “Wait interrupted” terminal state.
- Does not make the overall turn look hung.

**Runner Lab scenario**: `wt-intentional-wait`

- Completed wait, interrupted wait, and wait adjacent to warm-idle transition.
- Visual assertions: countdown state, lifecycle distinction, deterministic fake
  clock.

### O. Provider warnings and deprecations

**Provider inputs**

- Codex error, warning, guardian warning, deprecation notice, config warning,
  environment warning, and sandbox setup notifications.
- OpenCode diagnostics and provider errors.

**Canonical payload**

`provider.notice.recorded` carries severity, stable category, safe summary,
scope (`turn | session | environment | account`), recoverability, and operator
detail reference. Unknown diagnostics fail into an operator-only category rather
than becoming public raw text.

**UI**

- User-actionable notices appear inline with recovery guidance.
- Operator-only notices appear in DevTools and affect run health without
  leaking details.
- Deprecations are grouped and do not spam every turn.

**Runner Lab scenario**: `pn-provider-notices`

- Recoverable warning, deprecation, sandbox warning, redacted provider error,
  and repeated notice deduplication.
- Visual assertions: severity, scope, dedupe, redaction, user/operator split.

## Runner Lab scenario roster

All scenarios appear in Scenario Explorer and have stable deep links:

| Slug | Capability | Primary widget |
| --- | --- | --- |
| `pe-structured-plan` | Structured plans | Plan checklist |
| `te-command-execution` | Commands/processes | Execution card/output drawer |
| `mp-mcp-progress` | MCP/dynamic tools | Tool progress card |
| `rs-web-research` | Web research | Research/source timeline |
| `da-subagent-delegation` | Delegation | Subagent tree |
| `mr-model-routing` | Model routing/safety | Model transition notice |
| `cc-context-compaction` | Context compaction | Context timeline marker |
| `ag-generated-artifact` | Viewed/generated artifacts | Artifact preview card |
| `rv-review-mode` | Review mode | Review-mode banner |
| `hk-hook-lifecycle` | Hooks | Hook status row |
| `mc-memory-citations` | Memory citations | Citation chips |
| `sr-safety-review` | Guardian/safety review | Attached safety state |
| `ti-terminal-input` | Terminal input | Input activity row |
| `wt-intentional-wait` | Wait/sleep | Countdown row |
| `pn-provider-notices` | Warnings/deprecations | Notice banner/DevTools row |

Scenario requirements:

- deterministic authored timestamps and IDs;
- no network or provider credential;
- canonical event fixture plus expected projected view;
- success, active, failure/interruption, malformed, and replay/dedupe cases where
  applicable;
- desktop and 390px visual coverage;
- keyboard navigation and accessible names;
- public-view redaction assertion;
- dynamic-chat parity test proving the live projector produces the same item;
- DevTools evidence correlation;
- screenshot route included in the maintained acceptance matrix.

## Implementation phases

### Phase 0 — Freeze the inventory and decisions

- Check in the generated Codex 0.148.0 event/item inventory as a test fixture or
  generated audit artifact without treating it as a Paperclip schema.
- Add an adapter coverage matrix: native signal, canonical mapping, retention,
  public visibility, Runner Lab scenario, and tests.
- Record the product decisions at the end of this document.
- Decide whether protocol-v1 adds event families additively or whether a v2
  negotiation envelope is required. Recommendation: additive v1 schemas plus
  optional `typedEventFamilies`, because the PRP envelope already versions each
  event.

Gate: every native signal is classified as mapped, intentionally generic,
operator-only, unsupported, or ignored with rationale.

### Phase 1 — Protocol foundations

- Add one JSON Schema payload per canonical family.
- Extend the event enum and conditional payload validation.
- Extend capabilities with typed event-family negotiation.
- Regenerate TypeScript validators and Rust protocol types.
- Add bounds, redaction disposition, attribution, ordering, and terminal-state
  rules to the protocol specification.
- Add conformance fixtures for each family, including malformed and oversized
  events.

Gate: generated artifacts match source schemas; TypeScript/Rust conformance and
replay parity pass for every new family.

### Phase 2 — Shared normalizer and durable state

- Introduce provider-neutral normalizer helpers instead of embedding shape
  interpretation inside UI projection.
- Persist canonical correlation/revision state required for resume and
  deduplication.
- Add event-family support to `NativeSessionBackend`, `HarnessDriver`, and Rust
  provider traits without making support mandatory.
- Ensure run attachment changes cannot reattribute prior session events.
- Make terminal races deterministic: provider terminal, tool terminal, and
  runner suspend may arrive in any order without losing evidence.

Gate: fake-provider restart/replay suites preserve identity and emit each
terminal fact exactly once.

### Phase 3 — Codex adapter mapping

- Map all 15 families from the qualified Codex schema.
- Keep unstable guardian fields behind version/capability guards.
- Treat completed plan snapshots as authoritative over streamed plan deltas.
- Split requested/effective model accounting at reroute boundaries.
- Map all 18 thread-item variants explicitly, even when the result is
  `unsupported` or operator-only, so new variants cannot silently disappear.
- Add schema-drift test that fails when the qualified Codex inventory changes
  without an updated classification.

Gate: deterministic fake Codex coverage proves every mapping, redaction,
unsupported path, recovery, and duplicate case.

### Phase 4 — OpenCode adapter mapping

- Inventory OpenCode session/part/event shapes at the pinned qualified version.
- Map equivalent tool, plan/todo, research, subtask, compaction, artifact, and
  diagnostic signals.
- Report unsupported families honestly in negotiation.
- Do not infer high-confidence semantics from plain assistant prose except for
  separately runner-verified derivations such as workspace file references.

Gate: fake OpenCode coverage plus a bounded live OpenRouter smoke produces the
same canonical shapes for shared capabilities.

### Phase 5 — Projection and shared widgets

- Extend the issue-thread view union with one semantic item per required widget.
- Update live projection, public view copying, bounds, and redaction.
- Implement shared components with compact and expanded states.
- Remove provider names from generic activity copy; provider identity comes from
  session metadata.
- Keep raw payload inspection in DevTools only through bounded canonical debug
  fields.

Gate: component, projection, public-view, accessibility, and token-gate tests
pass.

### Phase 6 — Runner Lab scenarios

- Add all 15 scenario slugs and fixture builders.
- Add scenario selector labels and deep-link routing.
- Add deterministic browser assertions and screenshots.
- For each scenario, run a corresponding dynamic fake-provider session and
  compare its projected item shape with the preset fixture.
- Add combined “provider activity kitchen sink” scenario only after the
  individual scenarios are stable; it is not a substitute for them.

Gate: every scenario renders in fake, replay, and dynamic-chat projection, with
no browser console errors and no fixture-only branches.

### Phase 7 — Production task-thread integration

- Reuse the shared view types/components where the production thread permits.
- Apply board/operator visibility policy centrally.
- Store canonical PRP events as run events and materialize only explicitly
  durable issue-thread records.
- Correlate final assistant comments with plan, citations, artifacts, tool
  execution, delegation, and model history.
- Preserve current adapters and legacy transcript rendering.

Gate: server/UI tests plus live Codex and OpenCode smokes show ordered activity,
correct visibility, usage/model truth, and clean shutdown.

### Phase 8 — Evals, docs, and qualification

- Carry event-family versions and support through eval request, artifact,
  scoring, report matrix, and replay.
- Add deterministic assertions for canonical event presence, attribution,
  redaction, terminal status, and absence of raw provider payloads.
- Add live smoke cases only where a deterministic provider cannot establish
  native support.
- Document provider coverage and known unsupported families.
- Add a schema-inventory upgrade procedure for each qualified harness version.

Gate: zero infrastructure failures, complete scenario roster, clean secret scan,
and classified provider/model misses.

## Verification matrix

Each event family requires:

1. JSON Schema positive, malformed, traversal/URL, oversized, and secret tests.
2. TypeScript driver mapping tests.
3. Rust driver mapping and durable replay tests.
4. Out-of-order, duplicate, reconnect, cancellation, and suspend tests.
5. Public projection tests proving forbidden fields are absent.
6. Component state and accessibility tests.
7. Preset Runner Lab scenario tests.
8. Dynamic fake-provider parity tests.
9. Desktop/mobile browser smoke and screenshot.
10. Codex and OpenCode support/unsupported qualification evidence.

Required commands will include:

```sh
pnpm --filter @paperclipai/paperclip-runner generate:protocol-types
pnpm --filter @paperclipai/paperclip-runner check:protocol-types
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner build:issue-thread
pnpm check:token-gates
cargo test --workspace
```

Use focused suites during development, then the package and browser gates when
each phase is complete.

## Completion criteria

- All 15 canonical families are specified and negotiated.
- Codex mappings are explicit for all 18 qualified thread-item variants and all
  relevant notifications.
- OpenCode maps its equivalent qualified signals and explicitly reports the
  remainder unsupported.
- Every family has a Runner Lab scenario, deep link, dynamic-chat parity test,
  replay test, and accessible widget.
- Production task-thread visibility follows the approved policy.
- Requested and effective model history agree with usage/cost accounting.
- Warm-session suspend/resume retains plan, tool, delegation, compaction,
  citation, and model-route correlations.
- No secret, hidden reasoning, raw stdin, unrestricted output, unchecked host
  path, or raw provider payload appears in durable/public artifacts.
- Existing Codex/OpenCode runs and old persisted state remain recoverable.
- Protocol generation, conformance, replay parity, TypeScript, Rust, UI, and
  browser suites pass.

## Product decisions to make together

The recommendations below keep implementation moving, but they are not final
until confirmed.

### Decision 1 — Board visibility versus Runner Lab detail

**Accepted:** production task threads show bounded summaries and deliberate
widgets; Runner Lab/DevTools may show richer redacted command output, tool
results, plan details, and hook details. Neither surface receives raw native
provider payloads.

### Decision 2 — Generated artifact ownership

**Accepted:** a generated file/image must become a registered Paperclip
artifact/work product before it appears as a durable production-thread preview.
Runner Lab fixtures may use checked-in local assets.

### Decision 3 — Subagent presentation

**Accepted:** inline parent summary plus an expandable child tree; do not
interleave every child message into the parent conversation by default.

### Decision 4 — Plan persistence

**Accepted:** automatically synchronize the provider's structured plan into the
Paperclip issue `plan` document. The canonical `plan.updated` event remains the
source of live presentation state; a control-plane-owned synchronization step
creates document revisions under the run actor's attribution.

Plan content streams in the run UI while it is generated. Completion of the
provider plan item/snapshot creates exactly one new issue-plan revision
immediately; it does not wait for turn completion. A subsequent completed plan
regeneration creates a subsequent revision. Status-only step execution changes
remain run activity and do not create document revisions.

The synchronization must not silently overwrite a concurrent board/agent edit.
It uses the issue document's optimistic revision contract, records the source
run/turn/plan revision, and emits a visible typed conflict when its base revision
is stale. The concurrent edit is preserved and applying/rebasing the provider
plan requires an explicit action.

### Decision 5 — Command output visibility

**Accepted:** Runner Lab gets bounded redacted output by default; production
task threads show the last bounded excerpt only after expansion. Output is not
materialized as an issue comment.

### Decision 6 — Web results and citations

**Accepted:** show provider-reported sources with a clear label and safe
external links; do not have Paperclip refetch or independently verify them in
this phase.

### Decision 7 — Terminal input

**Accepted:** never retain or display stdin content, even in DevTools; retain
only origin, class, and byte count.

### Decision 8 — Provider parity policy

**Accepted:** canonical families are optional negotiated capabilities. UI is
consistent when present, while providers may report unsupported or
policy-disabled. Do not synthesize unsupported structure from prose.

### Decision 9 — Synchronized plan document shape

**Accepted:** write a normal Markdown checklist to the
issue `plan` document, while keeping source run, turn, provider plan ID/revision,
and synchronization metadata in structured document revision metadata rather
than polluting the visible Markdown body.

### Decision 10 — Plan synchronization conflict UX

**Accepted:** keep showing the completed provider plan in
the run timeline with a “Not synchronized — plan changed concurrently” state,
and offer Compare and Apply as an explicit control-plane action. Never retry an
overwrite automatically.

### Decision 11 — Automatic artifact registration scope

**Accepted:** automatically register only structured
`artifact.generated` outputs. Workspace diffs and ordinary file references keep
their existing widgets and become durable artifacts only through an explicit
deliverable/work-product operation.

### Decision 12 — Hook visibility

**Accepted:** successful hooks are collapsed production
activity; failed or blocking hooks appear inline. Runner Lab/DevTools may show
bounded redacted hook summaries, but never raw hook output.

### Decision 13 — Memory citation access

**Accepted:** only authorized, resolved Paperclip sources
are clickable. Unresolved/provider-only citations remain visible as unavailable
source chips without exposing raw provider thread IDs.

### Decision 14 — Provider notice routing

**Accepted:** user-actionable warnings appear inline;
account, environment, deprecation, and operator diagnostics live in DevTools
unless they prevent the current turn from proceeding.

## Accepted implementation decisions

### Decision 15 — Automatic plan synchronization scope

**Accepted:** synchronize completed structured plans for
every production runner session attached to an issue, including background
heartbeats. Mock/eval sessions mutate only their isolated mock control plane.

### Decision 16 — Delivery sequence

**Accepted:** land the protocol/negotiation foundation,
then deliver shippable vertical waves: core work visibility (plan, commands,
MCP, compaction), provenance/coordination (research, delegation, model,
citations), and specialized lifecycle (artifacts, review, hooks, safety,
terminal input, waits, notices). Each family gets its scenario in the wave that
implements it.

Each wave is end-to-end: schemas, Rust and TypeScript provider mappings, shared
widgets, Runner Lab scenarios, production projection, and deterministic tests
must pass before the next wave begins. Codex and OpenCode are both classified in
the wave; genuinely absent OpenCode capabilities are explicitly unsupported.

### Decision 17 — Image generation enablement

**Accepted:** implement the canonical generated-artifact
events and Runner Lab scenario without enabling image generation in production
provider policy. Enablement is a later, separately governed change.

### Decision 18 — Command output bounds

**Accepted:** retain at most 64 KiB of redacted output per
execution in Runner Lab evidence and expose only the last 8 KiB in the expanded
production widget, with byte counts, truncation state, and a digest. Never retain
an unbounded “full output” copy.

### Decision 19 — Child-agent message detail

**Accepted:** the parent tree shows child status, current
task summary, and tool/activity summaries. Assistant prose stays in the child
session and is reachable only through an authorized drill-in rather than copied
into the parent record.

### Decision 20 — Rollout controls

**Accepted:** use negotiated event-family capabilities as
the rollout control. UI components tolerate each family independently; no
single global experimental flag blocks already-qualified families.

Deterministic coverage is required for every family. Each wave receives one
representative live Codex and OpenCode smoke for supported capabilities, then
the affected eval roster runs after all waves.

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-08-21 | Draft recommendations recorded; awaiting product answers | Preserve implementation context without silently treating assumptions as approved |
| 2026-08-21 | Use bounded production widgets and richer redacted Runner Lab/DevTools detail | Give board users useful progress without widening the public evidence boundary |
| 2026-08-21 | Register generated files/images as Paperclip artifacts before durable production preview | Make durable previews governed, addressable work products rather than transient provider paths |
| 2026-08-21 | Automatically synchronize structured provider plans into the issue `plan` document | Keep the issue plan current without requiring the model to repeat an already-structured plan through a semantic tool |
| 2026-08-21 | Negotiate event families independently per provider | Preserve rich provider capabilities without fabricating parity or blocking providers that lack a family |
| 2026-08-21 | Stream plan generation as run activity and commit one issue-plan revision when generation completes | Preserve responsive UX without producing document revisions for deltas or status-only execution progress |
| 2026-08-21 | Preserve concurrent issue-plan edits and expose a typed synchronization conflict | Never let background provider synchronization silently overwrite board or agent work |
| 2026-08-21 | Present delegation as a parent summary with an expandable child tree | Keep the main timeline legible while retaining inspectable child activity |
| 2026-08-21 | Show bounded redacted command output after expansion in production | Make execution diagnosable without turning process output into unbounded thread content |
| 2026-08-21 | Make provider-reported web sources safely clickable without refetching | Provide useful research provenance while clearly separating provider reports from Paperclip verification |
| 2026-08-21 | Never retain terminal input content | Origin, class, and byte count are sufficient UX evidence without accepting stdin-secret risk |
| 2026-08-21 | Store synchronized plans as normal Markdown with structured provenance metadata | Keep plan documents readable while preserving machine-verifiable origin outside the body |
| 2026-08-21 | Resolve plan-sync conflicts through an inline Compare and Apply flow | Keep the generated plan inspectable without silently overwriting concurrent edits |
| 2026-08-21 | Auto-register only structured generated-artifact outputs | Avoid turning every workspace mutation into a durable work product |
| 2026-08-21 | Collapse successful hooks and surface failed or blocking hooks inline | Preserve signal without filling the task conversation with routine automation |
| 2026-08-21 | Show unresolved memory citations as unavailable and expose only authorized Paperclip sources | Preserve provenance without leaking provider-local identities or inaccessible links |
| 2026-08-21 | Route actionable or blocking notices inline and operational notices to DevTools | Keep the conversation useful while retaining operator diagnostics |
| 2026-08-21 | Synchronize completed plans for all production issue-attached runs | Keep background and interactive planning behavior consistent while leaving mocks isolated |
| 2026-08-21 | Deliver three end-to-end vertical waves | Make every wave independently inspectable and production-complete |
| 2026-08-21 | Implement image event/UI support without enabling live image generation | Separate observability support from provider capability policy |
| 2026-08-21 | Bound command output to 64 KiB retained and 8 KiB production-visible | Preserve diagnosis while limiting retention and public exposure |
| 2026-08-21 | Keep child prose in child sessions with parent summaries and drill-in | Avoid duplicating child transcripts while retaining useful coordination state |
| 2026-08-21 | Use event-family negotiation as the sole rollout control | Avoid redundant flags and allow providers to qualify families independently |
| 2026-08-21 | Require deterministic family coverage and representative live qualification per wave | Bound paid testing while still exercising real provider integration |
