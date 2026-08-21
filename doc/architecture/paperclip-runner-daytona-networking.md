# Paperclip Runner in Daytona sandboxes

## Intended topology

Paperclip creates the run and a short-lived, one-use runner bootstrap ticket. The Daytona sandbox starts only `paperclip-runnerd`; runnerd then starts the configured provider (Codex initially). Runnerd initiates an outbound WebSocket connection to Paperclip's PRP endpoint. No inbound sandbox port is opened and the provider never receives a Paperclip API credential.

```text
Paperclip HTTPS/WSS control plane
              ^
              | outbound WSS, authenticated PRP
              |
Daytona sandbox: paperclip-runnerd -> Codex app-server
```

The PRP identity binds company, issue, agent, run, environment lease, runner instance, normalized session, artifact version, artifact digest, and catalog digest. After the one-use ticket challenge succeeds, runnerd receives a renewable connection lease. Revocation, expiry, replay cursors, and the durable outbox continue to work across transient network loss and sandbox/provider restarts.

## Network policy

- Allow DNS and outbound TCP 443 only to the configured Paperclip control-plane host (plus provider destinations explicitly required by the provider runtime).
- Deny inbound connectivity to runnerd and Codex.
- Use `wss://` with normal certificate and hostname validation. Never disable TLS validation for private deployments; install their trust root in the sandbox image instead.
- Do not put the bootstrap ticket in argv, files, provider environment, logs, or model context. Inject it into runnerd's initial environment/secret channel; runnerd already removes it from its environment immediately.
- Runnerd is the only process allowed to reach PRP. The provider communicates with runnerd over inherited pipes.

## Lifecycle

1. Paperclip allocates the Daytona environment and persists its environment lease.
2. Paperclip creates a runner ticket with a very short expiry and binds it to the run, environment lease, runner digest/version, and allowed catalog digest.
3. The sandbox startup command launches the pinned runnerd artifact with the public WSS endpoint and non-secret identity fields. The ticket is supplied separately as secret environment material.
4. After PRP authentication, Paperclip sends `run.prepare`; only then may runnerd start Codex and advertise the run-authorized tools.
5. Suspend/drain/revoke commands stop new turns and durably flush terminal events. Paperclip revokes the lease before destroying or recycling the sandbox.
6. A recovered sandbox reuses its durable runner state and an unexpired connection lease; it must not mint a second provider session when a resumable one exists.

## Required implementation before remote enablement

The current Rust transport deliberately accepts only loopback `ws://` endpoints. Remote Daytona support stays disabled until runnerd supports `wss://`, DNS/non-loopback destinations, certificate validation, proxy behavior where required, bounded connect/read/write timeouts, and an outbound-host allowlist. Those changes need Rust unit tests plus a TLS integration test covering valid certificate, hostname mismatch, untrusted issuer, expired lease, replay, revoke, and reconnect.

Local Paperclip execution remains the proving ground: it uses the same authenticated PRP messages and runnerd/provider process boundary, with only the listener address and TLS layer differing from Daytona.
