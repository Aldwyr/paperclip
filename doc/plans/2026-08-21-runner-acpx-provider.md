# ACPX as a First-Class Paperclip Runner Provider

Status: provider implementation and paid Pi/Claude qualification complete. Both full rosters have zero integration failures; remaining Claude misses are measured model behavior.

## Goal

Add the closed `acpx_runtime` driver under `paperclip_runner`, with qualified Pi and Claude production profiles and Codex as a conformance control. ACPX is the transport/runtime; the ACP agent and effective model remain separately attributed in state, events, UI, and billing.

## Fixed v1 profiles

| Agent | ACP server | Harness | Qualified model |
| --- | --- | --- | --- |
| Pi | `pi-acp@0.0.33` | `@earendil-works/pi-coding-agent@0.84.2` | `openrouter/deepseek/deepseek-v4-flash-0731` |
| Claude | `@agentclientprotocol/claude-agent-acp@0.70.0` | Managed Claude credential profile | `claude-sonnet-5` |
| Codex control | `@agentclientprotocol/codex-acp@1.6.2` | Existing managed Codex profile | `gpt-5.6-sol` |

ACPX is pinned to `0.13.1`. Arbitrary commands, argv, agents, and model fallback are excluded from v1.

## Implementation checklist

- [x] Add strict ACPX configuration and immutable resolved-profile state to TypeScript and Rust.
- [x] Build a provider-neutral `AcpxRuntimeHost` around `acpx/runtime`.
- [x] Add a framed Node sidecar and a distinct Rust `AcpxProvider`; never identify it as Codex.
- [x] Rebase the ACPX runtime patch for spawn PID, stderr, cwd, notifications, client operations, permission requests, and ephemeral spawn environment injection.
- [x] Isolate ACPX and agent state under the Paperclip instance runtime with `0700` directories and `0600` files.
- [x] Generalize the authenticated runner tool bridge and implement Pi extension and Claude MCP/permission profiles.
- [x] Normalize ACP updates to PRP text, tool, workspace, plan, model, usage, runtime-request, completion, and provider-notice events.
- [x] Support per-turn checkpoint/load and warm reuse; keep permission waits alive and block safely after provider loss.
- [x] Add adapter/environment configuration, Runner Lab selection/status, and the five `ax-acpx-*` scenarios.
- [x] Add deterministic host, sidecar, bridge, Pi-extension, malformed-frame, process-loss, and permission-wait coverage. Live qualified agents provide the final agent-specific conformance boundary.
- [x] Add provider-aware `paperclip-evals` configs and immutable artifact/report metadata.
- [x] Complete the live paid Pi and Claude roster gates with zero runner, ACPX, ACP-agent, extension/MCP, or bridge failures.

## Qualification ledger

### Pi

- ACPX `0.13.1`, `pi-acp@0.0.33`, and `@earendil-works/pi-coding-agent@0.84.2` resolve by exact package and executable digest.
- The final full 35-case roster ran as `acpx-pi-qualification-03` against the same rebuilt package qualified for Claude, with zero retries and zero runner, ACPX, ACP-agent, extension, or bridge infrastructure failures.
- Behavioral result: 35/35. The earlier `acpx-pi-qualification-02` model miss did not recur; both immutable rosters remain retained.
- Provider-reported total cost was `$0.009493932` and the pricing-ledger estimate was `$0.005323750`. The most expensive case was `$0.000687344`, below the `$0.50` per-case hard cap.
- Immutable attempts retain the exact requested/effective `openrouter/deepseek/deepseek-v4-flash-0731` model with `provider_verified` provenance, biller, token/cache/reasoning usage, ACPX/profile, session, separate process identities, and clean exit metadata without credentials.
- `acpx-pi-metadata-02` independently verified clean exit, nonzero usage, and separate runnerd, sidecar, and ACP-agent process identities in the durable snapshot.
- Runner Lab verified a cold first turn and warm second turn with the same runner PID, sidecar PID, ACPX record, and provider session, plus all five ACPX scenario deep links at desktop and 390 px.

### Claude

- Managed Claude authentication is available and the qualified ACP server completes initialization/session negotiation.
- The model issue was an identity-layer mismatch, not a fallback: the pinned Claude ACP server accepts the canonical `claude-sonnet-5`, resolves it through SDK `ModelInfo.resolvedModel`, activates the provider selector `sonnet`, and then reports that selector in ACP status. Paperclip now reapplies the exact canonical model before the first prompt, requires the ACP configuration call to succeed, verifies the pinned reported selector, and only then normalizes `sonnet` back to `claude-sonnet-5` for durable identity, UI, billing, replay, and model history. Any other selector or reroute still fails closed.
- Runner-owned `mcp__paperclip__*` calls are allowed through Claude ACP's local permission layer exactly once so the authenticated PRP bridge remains the authority. Built-in file/process calls still use the durable interactive approval path.
- A pinned `@agentclientprotocol/claude-agent-acp@0.70.0` patch forwards bounded aggregate SDK token/cache usage through ACP `_meta.usage`; raw SDK/ACP payloads remain outside durable state.
- The representative six-case smoke passed mutation, restraint, human confirmation, and workspace-control coverage with zero integration failures; `finish-task` and `block-task` were model-only misses.
- The final full 35-case roster ran as `acpx-claude-qualification-03` with zero retries and zero runner, ACPX, Claude ACP, MCP, or bridge infrastructure failures. Behavioral result: 33/35 (94.3%). In both misses the model wrote prose claiming the requested finish/block action but made no semantic operation call, so Paperclip correctly left the task `in_progress`.
- Provider-reported total cost was `$3.388296350` and the pricing-ledger estimate was `$1.968167100`. The most expensive case was `$0.189559100`, below the `$0.50` per-case hard cap.
- Every final attempt records requested/effective `claude-sonnet-5` with `provider_verified` provenance, nonzero input/output/cache usage, provider cost, ACPX/profile/session identity, separate runnerd/sidecar/agent PIDs, and clean exit metadata.

### Qualification defect found and fixed

- A slow Claude workflow exposed that the eval control plane derived its connection-lease TTL from the provider turn timeout. Runnerd durably acknowledged 59 events and three semantic results, but a later shutdown command arrived after the lease expired.
- The connection lease is now independent from the turn deadline and uses at least the production live-transport one-hour boundary. The provider timeout remains a separate classification/cancellation concern. A deterministic regression test locks this separation.
- The affected `workflow-workspace-recovery` case passed immediately after the fix, and the subsequent complete Claude and Pi rosters both finished with zero lease or shutdown failures.

### Codex conformance control

- Managed Codex credentials are staged ephemerally into the isolated ACP home and removed on close; the source credential remains untouched and never enters ACPX records.
- Exact model activation for `gpt-5.6-sol` succeeds.
- The live context smoke completed and shut down cleanly, but the ACP agent ignored the offered semantic task-context tool and searched the filesystem. This is recorded as ACP-agent/model behavior, not runner infrastructure, and does not replace the native Codex provider.

### Verification snapshot

- Runner TypeScript tests: 637/637. Rust workspace tests: 78/78 library tests plus all binary/provider/process integration tests. Package build and TypeScript/Rust/browser typechecks pass.
- SDK tests: 22/22. Scenario/Runner Lab component tests: 250/250. Server adapter/native-runtime tests: 81/81.
- Browser: Scenario Explorer 43/43 and Runner Lab/issue-thread 174/174, including all five ACPX scenarios, desktop/mobile, keyboard, and accessibility coverage.
- Replay goldens, TypeScript/Rust conformance parity, TypeScript/Rust replay parity, ACPX patch packaging (9/9), package boundaries, and the full offline clean-consumer pack/install dependency closure pass.
- Paperclip Evals Python tests: 35/35. Both provider rosters validate 35/35 and their final paid attempts ran without automatic retries.
- Final Pi/Claude artifact scans found no OpenRouter credential value, Anthropic/OpenRouter credential-shaped value, or Paperclip key assignment. No qualification runnerd, ACPX sidecar, Pi, or Claude ACP process remained afterward.
- The tracked-import gate passes against a prospective index containing the new Claude environment module. The real working index remains untouched until the surrounding working-tree changes are committed.

## Security invariants

- Only exact bundled profile executables are resolved; no `npx` or first-match `PATH` fallback.
- ACP child environments are allowlisted and injected just in time. Paperclip API keys and unrelated ambient secrets never reach children.
- Raw ACP JSON-RPC, hidden reasoning, stdin, unchecked host paths, bearer values, and unbounded output never enter durable evidence.
- The active Paperclip run attachment and tool catalog are authoritative. Stale provider tools are denied even if cached by an agent.
- A permission decision is delivered exactly once. Process loss while waiting blocks recoverably and never replays the prompt or approval.
- Existing Codex, OpenCode, Claude Managed, `codex_local`, and `claude_local` persisted state remains compatible.

## Completion gates

Pi and Claude must each complete cold, warm, suspended, restored, semantic-tool, permission-wait, and clean-shutdown qualification. Both 35-case rosters must have zero runner, ACPX, ACP-adapter, or bridge infrastructure failures; model misses remain measured behavior. Codex ACP completes smoke/conformance only.
