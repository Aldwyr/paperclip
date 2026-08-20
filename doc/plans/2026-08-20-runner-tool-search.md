# Paperclip Runner lazy tool discovery

Date: 2026-08-20
Status: fallback implemented and evaluated; native adapter pending transport support

Reference: [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search)

## Outcome

Keep the model's initial protocol surface small while allowing it to discover optional
Paperclip operations at runtime. Discovery never grants authority: the runner filters
what may be discovered, and the dispatcher independently authorizes every invocation.

OpenAI Tool Search is the preferred provider capability where the selected model and
driver support it. The runner also owns a provider-neutral fallback so Paperclip's
protocol and security semantics do not depend on one transport.

## Product contract

The initial model context contains:

- a deliberately small always-present task core;
- high-level descriptions of searchable namespaces, not every operation schema;
- either native `tool_search` or runner-managed `discover_capabilities`;
- explicit guidance that discovery should happen only when the task requires it.

Candidate namespace projection, kept below ten operations per namespace:

| Namespace | Purpose | Initial operations |
| --- | --- | --- |
| `discovery` | Find company tasks, agents, projects, and goals | `search_tasks`, `list_agents`, `get_agent`, `list_projects`, `list_goals` |
| `delegation` | Create bounded child work and dependencies | `create_task`, `set_dependencies` |
| `governance` | Read, request, discuss, and decide approvals | approval operations |
| `workspace` | Inspect and control task workspace services | workspace operations |
| `cases` | Read and maintain case records | case operations |
| `routines` | Read and maintain routines | routine operations |
| `company_skills` | Inspect and synchronize company skills | skill operations |
| `secrets` | Discover metadata and perform tightly governed secret reads | secret operations |
| `company_admin` | Portability and company administration | admin operations |

The exact always-present core is a measured product decision. Start with active-task
context/history, progress/status reporting, and terminal/disposition operations; use
eval results to decide whether document reads and writes remain eager or become
deferred.

## Architecture

### Canonical registry projection

Extend the canonical operation registry with discovery metadata: namespace, concise
search description, searchable aliases, sensitivity classification, and whether an
operation's name may be disclosed when unauthorized. Continue deriving provider
schemas and scenario descriptors from the same canonical operation identity.

### Discovery policy

Given a query and session identity, compute candidates from the canonical registry,
then filter by company, actor, task, mode, role, claims, enabled capabilities, scenario
policy, disabled-by-default status, and driver support. Rank only the permitted set.
Sensitive undiscoverable operations must not leak through names, counts, descriptions,
errors, or timing where practical.

Return trusted registry definitions only. Never accept a model-authored schema or an
untrusted remote definition as executable protocol authority.

### Invocation policy

Loaded tools receive no durable authority grant. Every call goes through the existing
semantic dispatcher and repeats the current policy decision. Revoked claims or changed
task state therefore take effect even if the schema remains in conversation context.

### Provider adapters

1. **Native adapter:** project namespaces/deferred functions and consume provider
   tool-search call/output events.
2. **Runner-managed adapter:** expose `discover_capabilities`; resolve the query
   locally; add selected trusted definitions on the next model continuation.
3. Normalize both paths into PRP events so Runner Lab and Evalbook do not depend on
   provider-specific event shapes.

### Protocol evidence

Add evidence events for discovery requested, candidates considered (redacted), policy
decision, definitions loaded, namespace activated, and discovery failure. Preserve the
query and returned operation IDs when safe, plus model/driver/configuration, token and
cost measurements. Link the eventual invocation back to the discovery event.

## Delivery phases

### D0 — transport spike

Prove whether the Codex app-server driver can send deferred definitions and surface
native tool-search events for the configured GPT-5.4-class model. Produce one recorded
attempt. Do not change default exposure.

Result: the current Codex app-server driver accepts dynamic tools at thread creation but
does not expose Responses API native Tool Search events or a supported mid-turn schema
append operation. Native support is therefore not claimed. The provider-neutral gateway
below is the implemented path.

### D1 — provider-neutral domain layer

Add discovery metadata and namespace validation to the canonical registry. Implement
the policy-filtered search service and normalized discovery event contract. Unit-test
ranking, nondisclosure, mode/role/claim filtering, and registry drift.

### D2 — runner-managed fallback

Implement `discover_capabilities`, continuation-time schema loading, policy recheck on
invocation, limits on results/searches/loaded tools, and deterministic errors. Ship
behind `toolExposure: "eager" | "lazy"`, defaulting to `eager`.

Implemented: lazy threads receive the always-present core plus
`discover_capabilities` and `invoke_discovered_capability`. Search is deterministic,
namespace-aware, limited to eight results, filtered by live exposure policy, and returns
only trusted catalog schemas. Invocation requires prior discovery and is reauthorized by
the semantic dispatcher. Loaded operation identities survive runner snapshots.

### D3 — native Tool Search adapter

If D0 succeeds, implement native namespace/deferred-tool projection and normalize its
events to the same domain contract. If D0 fails, retain the evidence and defer this
adapter without blocking the fallback.

### D4 — Runner Lab and reports

Render discovery inline in the issue thread, expose policy detail in Devtools, connect
loaded definitions to subsequent calls, and report eager/lazy configuration plus token,
latency, and cost deltas.

Implemented: discovery is retained as redacted `tool_discovery` evidence, appears on the
semantic-tool boundary, and Devtools reports exposure mode and loaded operation IDs.

### D5 — eval and rollout

Implement the lazy-discovery eval track in the sibling `paperclip-evals` repository.
Run deterministic checks first and live comparisons on GPT-5.4 mini only. Switch the
default to lazy after semantic parity, authorization/nondisclosure, observability, and
efficiency gates pass. Keep eager mode as a temporary diagnostic control until one
release cycle completes.

Initial result: all 35 GPT-5.4-mini live roster cases passed on
`20260820-full-protocol-lazy-01`, including three lazy-discovery cases and four new
multi-operation workflows. Eager remains the default pending a broader repetition and
efficiency comparison; this single green run is functional evidence, not a reliability
estimate.

## Guardrails and limits

- Maximum returned definitions per search and maximum loaded definitions per session.
- Maximum discovery calls per turn/session, with loop detection.
- No `generic_api_request` outside explicit skill-test scenarios.
- No disclosure of secret/admin tools to unauthorized actors.
- Namespace and operation descriptions are trusted code-reviewed content.
- Search results are company-scoped and deterministic for identical policy state.
- Tool invocation always rechecks live policy and terminal task state.
- Cache behavior is measured but never allowed to weaken authorization freshness.

## Acceptance criteria

- Lazy sessions begin without optional operation schemas.
- A permitted optional operation can be found and invoked end to end.
- An unauthorized operation is neither disclosed nor invokable.
- Revocation after loading prevents invocation.
- Native and fallback routes produce equivalent semantic PRP evidence.
- Runner Lab makes discovery and its causal invocation inspectable.
- Evalbook compares eager and lazy correctness, tokens, latency, and cost.
- No regression in the existing deterministic capability suite or protocol eval roster.

## Open decisions to resolve with evidence

1. Exact always-present core, especially document operations.
2. Lexical versus embedding-assisted local ranking; begin lexical and deterministic.
3. Whether sensitive namespaces are hidden entirely or return a generic unavailable
   result; prefer complete nondisclosure.
4. Session persistence rules for loaded schemas across compaction and continuation.
5. Whether native Tool Search is available through Codex app-server with the required
   event fidelity; D0 decides this rather than assuming it.
