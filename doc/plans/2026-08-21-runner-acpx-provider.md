# ACPX as a First-Class Paperclip Runner Provider

Status: implementation in progress on `PAP-16679-paperclip-runner` and the existing `paperclip-evals` working tree.

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

- [ ] Add strict ACPX configuration and immutable resolved-profile state to TypeScript and Rust.
- [ ] Build a provider-neutral `AcpxRuntimeHost` around `acpx/runtime`.
- [ ] Add a framed Node sidecar and a distinct Rust `AcpxProvider`; never identify it as Codex.
- [ ] Rebase the ACPX runtime patch for spawn PID, stderr, cwd, notifications, client operations, permission requests, and ephemeral spawn environment injection.
- [ ] Isolate ACPX and agent state under the Paperclip instance runtime with `0700` directories and `0600` files.
- [ ] Generalize the authenticated runner tool bridge and implement Pi extension and Claude MCP/permission profiles.
- [ ] Normalize ACP updates to PRP text, tool, workspace, plan, model, usage, runtime-request, completion, and provider-notice events.
- [ ] Support per-turn checkpoint/load and warm reuse; keep permission waits alive and block safely after provider loss.
- [ ] Add adapter/environment configuration, Runner Lab selection/status, and the five `ax-acpx-*` scenarios.
- [ ] Add deterministic Pi-like, Claude-like, Codex-like, malformed, and hanging fake ACP servers.
- [ ] Add provider-aware `paperclip-evals` configs and immutable artifact/report metadata.
- [ ] Run package, protocol, Rust, server, Lab, browser, live smoke, and paid qualification gates.

## Security invariants

- Only exact bundled profile executables are resolved; no `npx` or first-match `PATH` fallback.
- ACP child environments are allowlisted and injected just in time. Paperclip API keys and unrelated ambient secrets never reach children.
- Raw ACP JSON-RPC, hidden reasoning, stdin, unchecked host paths, bearer values, and unbounded output never enter durable evidence.
- The active Paperclip run attachment and tool catalog are authoritative. Stale provider tools are denied even if cached by an agent.
- A permission decision is delivered exactly once. Process loss while waiting blocks recoverably and never replays the prompt or approval.
- Existing Codex, OpenCode, Claude Managed, `codex_local`, and `claude_local` persisted state remains compatible.

## Completion gates

Pi and Claude must each complete cold, warm, suspended, restored, semantic-tool, permission-wait, and clean-shutdown qualification. Both 35-case rosters must have zero runner, ACPX, ACP-adapter, or bridge infrastructure failures; model misses remain measured behavior. Codex ACP completes smoke/conformance only.
