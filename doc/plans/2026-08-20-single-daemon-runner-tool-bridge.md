# Single-daemon sandbox runner and tool bridge

Date: 2026-08-20
Status: implemented; provider reliability follow-up remains

## Target

The sandbox contains one Paperclip-owned process: `paperclip-runnerd`. It owns
the authenticated durable connection to the Paperclip control plane, launches
the selected provider harness (Codex, Claude, ACPX, or another adapter), exposes
only the tools authorized for the run, and forwards tool calls to the control
plane. No Node/TypeScript Paperclip dispatcher runs in the sandbox.

```text
Paperclip control plane
  <== authenticated, durable PRP ==>
paperclip-runnerd (sandbox)
  <== provider protocol ==>
Codex / Claude / ACPX
```

## Ownership

- The control plane owns company state, authorization, action execution,
  idempotency, audit, and the authorized action set for each run.
- Runnerd owns process containment, provider lifecycle, protocol translation,
  durable event delivery, correlated tool-call forwarding, interruption, and
  recovery.
- Provider adapters translate a provider's native tool protocol into the same
  runner-internal `ToolCall`/`ToolResult` interface. They contain no Paperclip
  business rules.
- TypeScript in this package is the reference control plane, eval UI, and
  conformance oracle. It is not part of the sandbox runtime.

## Protocol cutover

1. `run.prepare` supplies the provider configuration and authorized tool
   definitions (name, description, input schema, response schema, contract
   version). Runnerd rejects duplicate names, unsupported versions, and schema
   changes on a resumed durable identity.
2. `turn.start` starts or resumes the provider turn.
3. A provider tool call becomes a durable `semantic_tool` input event with a
   runner-generated stable `callId`. The provider turn waits without retrying.
4. The control plane validates, authorizes, and executes the call, then sends a
   `semantic_tool.result` command correlated by `callId`.
5. Runnerd durably records the result before acknowledging the command and
   returns it to the provider exactly once. Duplicate identical results are
   accepted; conflicting duplicates fail closed.
6. Provider output, usage, terminal state, and failures remain normal PRP
   events. Reconnection replays unacknowledged input events and restores pending
   calls without duplicating effects.

## Implementation phases

### Phase A — contracts and generic bridge

- Add versioned PRP command payloads for run configuration and tool results.
- Add Rust types and validation for authorized tool definitions.
- Add a provider-neutral Rust harness interface and correlated pending-call
  state persisted in the durable state file.
- Generate the Rust catalog manifest used by conformance tests from
  `src/protocol-actions`; never maintain a second handwritten action list.

### Phase B — provider adapters

- Codex app-server: register dynamic tools on thread start, translate dynamic
  tool callbacks, and return correlated results.
- ACPX/ACP: expose the same internal interface through ACP tool calls.
- Claude: add its native tool-use/result translation without changing PRP.

### Phase C — control-plane bridge

- Extend the reference mock control plane to send authorized definitions in
  `run.prepare`, consume semantic input events, execute through its authority
  adapter, and return result commands.
- The production Paperclip adapter invokes real route/service authorities and
  never copies them into runnerd.

### Phase D — eval cutover and removal

- Start only runnerd plus the selected provider in the eval sandbox.
- Run the protocol eval inventory through the remote mock control plane.
- Assert process evidence contains runnerd and provider, but no Node dispatcher.
- Remove the TypeScript live session's direct provider-tool dispatch path after
  parity, recovery, denial, and cost reporting pass.

## Required proof

- Catalog drift: all authorized definitions originate from the canonical
  per-action modules; Rust has no handwritten operation-name list.
- End to end: provider → runnerd → control plane → runnerd → provider.
- Authorization denial and unknown tool fail closed without provider fallback.
- Lost ACK and reconnect do not duplicate a tool effect.
- Conflicting duplicate results fail closed.
- Interrupt while waiting on a tool result terminates cleanly.
- Usage/model/process evidence reaches the eval report.
- The live eval process tree has exactly one Paperclip sandbox daemon.

## Deletion gate

The TypeScript direct-dispatch live path may be deleted only after the complete
live suite passes through the Rust bridge. Until then it must be explicitly
labeled a reference/legacy path and cannot be reported as production topology.

## 2026-08-20 verification record

- Rust owns Codex app-server lifecycle and dynamic-tool JSON-RPC.
- Authorized definitions and their digest arrive in `run.prepare`; unknown,
  drifted, and conflicting calls/results fail closed.
- Semantic inputs and correlated results are durable PRP events/commands.
- The eval CLI now uses the external mock authority plus Rust runner topology.
- The fake Codex boundary integration and the complete Rust suite pass.
- Real GPT-5.4-mini single- and multi-call cases pass with final assistant text,
  token counts, estimated cost, state effects, and ordered evidence preserved.
- The 35-case final roster produced 24 passes, two model/eval behavior findings,
  and nine provider/runner shutdown timeouts. Previously timed-out multi-step
  cases passed individually after the command-delivery race fix. These are kept
  as reliability findings rather than rewritten as semantic failures.

The older `CapabilityLiveSessionService` remains a runner-lab/reference API. It
is no longer used by the live eval CLI and must not be described as the sandbox
runtime. Removal or consolidation with the lab UI is a separate deletion task.
