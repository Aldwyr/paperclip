fn sleep_for_reconnect(base: Duration, attempt: &mut u32) {
    let multiplier = 1_u128 << (*attempt).min(5);
    let uncapped = base.as_millis().saturating_mul(multiplier);
    let capped = uncapped.min(5_000).max(1) as u64;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| u64::from(duration.subsec_nanos()));
    let jitter_percent = 75 + nanos % 51;
    *attempt = attempt.saturating_add(1);
    thread::sleep(Duration::from_millis(
        capped.saturating_mul(jitter_percent) / 100,
    ));
}

pub fn run_durable_runner(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
) -> Result<(), DurableRunnerError> {
    if config.p0_reserve_bytes >= config.max_outbox_bytes {
        return Err(DurableRunnerError::invalid(
            "P0 reserve must be smaller than the outbox limit",
        ));
    }
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if state.last_activity_at_unix_ms == 0 {
        state.last_activity_at_unix_ms = current_unix_ms()?;
    }
    if recovered && state.lifecycle == "revoked" {
        // Revocation is durable and terminal. Do not normalize, rewrite, start
        // a provider, resolve a destination, or consume the fresh bootstrap.
        drop(bootstrap_ticket);
        return Ok(());
    }
    let resuming_suspended_per_turn =
        recovered && state.lifecycle == "suspended" && state.lifecycle_mode == "per_turn";
    if recovered && state.lifecycle == "suspended" {
        state.stop_after_flush = false;
        state.lifecycle = "ready".to_owned();
        state.record_diagnostic("resuming an explicitly suspended durable runner");
    }
    // Bind listener mode before starting the harness. A fixed-port collision is
    // an unhealthy lease and must fail without launching provider work.
    let endpoint = RunnerTransportEndpoint::new(&config.connect_url)?;
    let mut provider = match start_configured_provider(&mut state, resuming_suspended_per_turn) {
        Ok(provider) => provider,
        Err(error) => {
            persist_provider_failure(&mut state, &store, &error.to_string())?;
            return Err(error);
        }
    };
    if recovered {
        if let Some(runtime) = provider.as_ref() {
            let descriptor =
                provider_descriptor(state.provider_config.as_ref(), Some(runtime.as_ref()));
            let provider_identity = state.provider_session_identity.clone();
            enqueue_event(
                &mut state,
                &config,
                "harness.ready",
                0,
                json!({
                    "providerDescriptor": descriptor,
                    "runtimeIdentity": runtime.runtime_identity(),
                    "threadId": runtime.session_identity(),
                    "sessionId": runtime.provider_session_id(),
                    "providerIdentity": provider_identity,
                    "resumed": true,
                }),
                None,
            )?;
        }
    }
    store.save(&state)?;
    if recovered {
        state.reconnect_count += 1;
        state.record_diagnostic("runner process restored the same durable identity");
        enqueue_event(
            &mut state,
            &config,
            "runner.reconciled",
            0,
            json!({
                "runnerInstanceId": config.runner_instance_id,
                "normalizedSessionId": config.normalized_session_id,
                "turnId": config.turn_id,
                "itemId": config.item_id,
                "outcome": "same_durable_session_resumed",
            }),
            None,
        )?;
        store.save(&state)?;
    }
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut connection_lease_token: Option<SensitiveString> = None;
    let mut connection_lease_id: Option<String> = None;
    let mut connection_lease_expires_at_unix_ms: Option<u64> = None;
    let mut connection_lease_revocation_epoch: Option<u64> = None;
    let started = Instant::now();
    let mut reconnect_attempt = 0_u32;
    let mut authenticated_once = false;
    let mut disconnected_since: Option<Instant> = None;

    'transport: loop {
        if started.elapsed() >= config.max_runtime && !state.active_turn {
            state.recoverable_failure = Some("transport_reconnect_deadline_exceeded".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic(
                "transport reconnect deadline exceeded before a safe rotation could flush",
            );
            store.save(&state)?;
            return Err(DurableRunnerError::invalid(
                "transport reconnect deadline exceeded; durable state is preserved",
            ));
        }
        if authenticated_once {
            let disconnected_at = disconnected_since.get_or_insert_with(Instant::now);
            if config
                .reconnect_grace
                .is_some_and(|grace| disconnected_at.elapsed() >= grace)
            {
                state.recoverable_failure = Some("transport_reconnect_grace_exceeded".to_owned());
                state.lifecycle = "recoverable_failure".to_owned();
                state.record_diagnostic(
                    "transport reconnect grace exceeded; durable state is preserved",
                );
                store.save(&state)?;
                return Err(DurableRunnerError::invalid(
                    "transport reconnect grace exceeded; durable state is preserved",
                ));
            }
        }
        if connection_lease_expires_at_unix_ms
            .is_some_and(|expires_at| current_unix_ms().is_ok_and(|now| now >= expires_at))
        {
            state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic(
                "connection lease expired; a fresh bootstrap may resume this state",
            );
            store.save(&state)?;
            connection_lease_token.take();
            return Err(DurableRunnerError::invalid(
                "connection lease expired; durable state requires a fresh bootstrap",
            ));
        }
        let (credential_token, credential_kind) = connection_lease_token
            .as_ref()
            .map(|token| (token.expose(), "lease"))
            .or_else(|| {
                bootstrap_ticket
                    .as_ref()
                    .map(|ticket| (ticket.expose(), "bootstrap"))
            })
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "transport capability is unavailable; a fresh runner bootstrap is required",
                )
            })?;
        let credential = CredentialMaterial::from_token(credential_token);
        let mut client =
            match endpoint.open(config.max_frame_bytes, config.ca_bundle_path.as_deref()) {
                Ok(Some(client)) => client,
                Ok(None) => {
                    thread::sleep(config.reconnect_delay);
                    continue;
                }
                Err(error) => {
                    let text = error.to_string();
                    state.record_diagnostic(format!("transport reconnect scheduled: {text}"));
                    store.save(&state)?;
                    sleep_for_reconnect(config.reconnect_delay, &mut reconnect_attempt);
                    continue;
                }
            };
        if let Err(error) = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            credential_kind,
            connection_lease_id.as_deref(),
            connection_lease_expires_at_unix_ms,
            connection_lease_revocation_epoch,
        ) {
            state.record_diagnostic(format!(
                "transport peer authentication failed closed: {error}"
            ));
            store.save(&state)?;
            sleep_for_reconnect(config.reconnect_delay, &mut reconnect_attempt);
            continue;
        }
        let mut welcome = loop {
            match client.receive_json() {
                Ok(Some(value)) => break value,
                Ok(None) if started.elapsed() <= config.max_runtime => continue,
                Ok(None) => {
                    return Err(DurableRunnerError::invalid("welcome timed out"));
                }
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    store.save(&state)?;
                    sleep_for_reconnect(config.reconnect_delay, &mut reconnect_attempt);
                    continue 'transport;
                }
            }
        };
        let (_, connection) = validate_welcome(&welcome, &state)?;
        authenticated_once = true;
        disconnected_since = None;
        reconnect_attempt = 0;
        let next_lease_token = match welcome.pointer_mut("/payload/connectionLeaseToken") {
            Some(Value::String(value)) => {
                let token = std::mem::take(value);
                *value = "[REDACTED]".to_owned();
                Some(SensitiveString::new(token))
            }
            _ => None,
        };
        if credential_kind == "bootstrap" && next_lease_token.is_none() {
            return Err(DurableRunnerError::invalid(
                "authenticated bootstrap welcome did not issue a connection lease",
            ));
        }
        if let Some(token) = next_lease_token {
            connection_lease_token = Some(token);
        }
        connection_lease_id = Some(connection.lease_id.clone());
        connection_lease_expires_at_unix_ms = Some(connection.lease_expires_at_unix_ms);
        connection_lease_revocation_epoch = Some(connection.revocation_epoch);
        // A bootstrap ticket is one-use. Clear it only after the mutually authenticated,
        // encrypted welcome has exchanged it for a bound connection lease.
        bootstrap_ticket.take();
        let payload = welcome
            .get("payload")
            .ok_or_else(|| DurableRunnerError::invalid("welcome payload is required"))?;
        if let Some(acked_source_seq) = payload.get("ackedSourceSeq").and_then(Value::as_u64) {
            state.apply_ack(acked_source_seq)?;
        }
        state.lifecycle =
            if state.lifecycle == "connecting" || state.lifecycle == "recoverable_failure" {
                "ready".to_owned()
            } else {
                state.lifecycle.clone()
            };
        state.recoverable_failure = None;
        store.save(&state)?;
        let mut sent_source_seq = state.acked_source_seq;

        let initial_delivery = (|| -> Result<(), DurableRunnerError> {
            if let Some(commands) = payload.get("pendingCommands").and_then(Value::as_array) {
                for command in commands {
                    match process_command_and_provider(
                        &mut state,
                        &store,
                        &config,
                        &mut provider,
                        command,
                    ) {
                        Ok(processed) => {
                            client.send_json(&command_result_envelope(&state, &processed))?
                        }
                        Err(error) => {
                            state.record_diagnostic(error.to_string());
                            store.save(&state)?;
                        }
                    }
                }
            }
            send_outbox(&mut client, &state, &mut sent_source_seq)
        })();
        if let Err(error) = initial_delivery {
            state.record_diagnostic(error.to_string());
            state.reconnect_count += 1;
            store.save(&state)?;
            sleep_for_reconnect(config.reconnect_delay, &mut reconnect_attempt);
            continue;
        }

        let mut revoke_deadline: Option<Instant> = None;
        let mut revoke_control_drained = false;
        let disconnected = loop {
            if !state.stop_after_flush {
                poll_provider(&mut provider, &mut state, &store, &config)?;
            }
            if started.elapsed() >= config.max_runtime && !state.active_turn {
                begin_automatic_suspend(
                    &mut state,
                    &store,
                    &config,
                    &mut provider,
                    "max_lifetime_rotation",
                )?;
            }
            if should_suspend_for_idle(&state)? {
                begin_automatic_suspend(
                    &mut state,
                    &store,
                    &config,
                    &mut provider,
                    "idle_timeout",
                )?;
            }
            if provider.is_some() {
                if let Err(error) = send_outbox(&mut client, &state, &mut sent_source_seq) {
                    // A run attachment deliberately rotates the immutable run binding and
                    // makes the control plane close the old authenticated connection. The
                    // command-result write can still succeed locally after the peer has
                    // closed, so the first observable failure may be this subsequent outbox
                    // flush. Treat every steady-state write failure like a receive-side
                    // disconnect: preserve the durable suffix and reconnect under the
                    // rotated lease identity instead of terminating runnerd.
                    state.record_diagnostic(error.to_string());
                    if state.lifecycle == "revoked" {
                        store.save(&state)?;
                        connection_lease_token.take();
                        bootstrap_ticket.take();
                        return Ok(());
                    }
                    state.reconnect_count += 1;
                    store.save(&state)?;
                    break true;
                }
            }
            if (state.stop_after_flush || state.lifecycle == "revoked")
                && state.outbox.is_empty()
                && (state.lifecycle != "revoked"
                    || revoke_control_drained
                    || revoke_deadline.is_none())
            {
                if let Some(mut runtime) = provider.take() {
                    runtime.shutdown().map_err(|error| {
                        DurableRunnerError::invalid(format!(
                            "failed to stop provider during durable exit: {error}"
                        ))
                    })?;
                }
                state.lifecycle = if state.lifecycle == "revoked" {
                    "revoked".to_owned()
                } else if state.lifecycle == "suspending" {
                    "suspended".to_owned()
                } else {
                    "stopped".to_owned()
                };
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if revoke_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                if state.outbox.is_empty() {
                    revoke_control_drained = true;
                    continue;
                }
                state.record_diagnostic(
                    "revocation flush deadline elapsed; unacked durable events remain preserved",
                );
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
                state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
                state.lifecycle = "recoverable_failure".to_owned();
                state.record_diagnostic(
                    "connection lease expired before more control data could be accepted",
                );
                store.save(&state)?;
                connection_lease_token.take();
                return Err(DurableRunnerError::invalid(
                    "connection lease expired; durable state requires a fresh bootstrap",
                ));
            }
            match client.receive_json() {
                Ok(None) => continue,
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    if state.lifecycle == "revoked" {
                        store.save(&state)?;
                        connection_lease_token.take();
                        bootstrap_ticket.take();
                        return Ok(());
                    }
                    state.reconnect_count += 1;
                    store.save(&state)?;
                    break true;
                }
                Ok(Some(message)) => {
                    if let Err(error) =
                        validate_control_identity(&message, &state, Some(&connection))
                    {
                        state.record_diagnostic(format!(
                            "control envelope identity mismatch failed closed: {error}"
                        ));
                        state.reconnect_count += 1;
                        store.save(&state)?;
                        break true;
                    }
                    match message.get("kind").and_then(Value::as_str) {
                        Some("ack") => {
                            let acked = message
                                .pointer("/payload/ackedSourceSeq")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| {
                                    DurableRunnerError::invalid("ACK cursor is required")
                                })?;
                            state.apply_ack(acked)?;
                            state.last_activity_at_unix_ms = current_unix_ms()?;
                            store.save(&state)?;
                        }
                        Some("command") => {
                            let command = message.get("payload").ok_or_else(|| {
                                DurableRunnerError::invalid("command payload is required")
                            })?;
                            match process_command_and_provider(
                                &mut state,
                                &store,
                                &config,
                                &mut provider,
                                command,
                            ) {
                                Ok(processed) => {
                                    state.last_activity_at_unix_ms = current_unix_ms()?;
                                    let delivery = client
                                        .send_json(&command_result_envelope(&state, &processed))
                                        .and_then(|()| {
                                            send_outbox(&mut client, &state, &mut sent_source_seq)
                                        });
                                    if let Err(error) = delivery {
                                        state.record_diagnostic(error.to_string());
                                        if state.lifecycle == "revoked" {
                                            store.save(&state)?;
                                            connection_lease_token.take();
                                            bootstrap_ticket.take();
                                            return Ok(());
                                        }
                                        state.reconnect_count += 1;
                                        store.save(&state)?;
                                        break true;
                                    }
                                    // A revoked connection remains open until the bounded drain
                                    // deadline even after the final command result is written. A
                                    // successful socket write is not a peer acknowledgement, and
                                    // exiting here can race the controller's durable commit.
                                }
                                Err(error) => {
                                    state.record_diagnostic(error.to_string());
                                    store.save(&state)?;
                                }
                            }
                        }
                        Some("revoke") => {
                            let revocation_epoch = message
                                .pointer("/payload/revocationEpoch")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| {
                                    DurableRunnerError::invalid(
                                        "revoke revocation epoch is required",
                                    )
                                })?;
                            if revocation_epoch <= connection.revocation_epoch {
                                return Err(DurableRunnerError::invalid(
                                    "revoke did not advance the authenticated revocation epoch",
                                ));
                            }
                            state.lifecycle = "revoked".to_owned();
                            state.stop_after_flush = true;
                            revoke_deadline.get_or_insert_with(|| {
                                Instant::now()
                                    .checked_add(REVOKE_FLUSH_TIMEOUT)
                                    .unwrap_or_else(Instant::now)
                            });
                            state.record_diagnostic(
                                "connection lease revoked; flushing durable events",
                            );
                            store.save(&state)?;
                            // A revoke may race the ACK for the last delivered event. Replay
                            // only the still-unacknowledged suffix once as part of the bounded
                            // revoke drain, rather than on every transport poll.
                            sent_source_seq = state.acked_source_seq;
                            if let Err(error) =
                                send_outbox(&mut client, &state, &mut sent_source_seq)
                            {
                                state.record_diagnostic(error.to_string());
                                store.save(&state)?;
                                connection_lease_token.take();
                                bootstrap_ticket.take();
                                return Ok(());
                            }
                        }
                        Some("ping") => {
                            let pong = client.send_json(&json!({
                                "protocol": PROTOCOL,
                                "version": PROTOCOL_VERSION,
                                "kind": "pong",
                                "runnerInstanceId": state.runner_instance_id,
                                "payload": {
                                    "lifecycle": state.lifecycle,
                                    "outboxBytes": state.outbox_bytes(),
                                    "ackedSourceSeq": state.acked_source_seq,
                                },
                            }));
                            if let Err(error) = pong {
                                state.record_diagnostic(error.to_string());
                                if state.lifecycle == "revoked" {
                                    store.save(&state)?;
                                    connection_lease_token.take();
                                    bootstrap_ticket.take();
                                    return Ok(());
                                }
                                state.reconnect_count += 1;
                                store.save(&state)?;
                                break true;
                            }
                        }
                        _ => {
                            state.record_diagnostic(
                                "malformed or unsupported control frame closed the connection",
                            );
                            store.save(&state)?;
                            if state.lifecycle == "revoked" {
                                connection_lease_token.take();
                                bootstrap_ticket.take();
                                return Ok(());
                            }
                            break true;
                        }
                    }
                }
            }
        };
        if disconnected {
            sleep_for_reconnect(config.reconnect_delay, &mut reconnect_attempt);
        }
    }
}

fn start_configured_provider(
    state: &mut DurableRunnerState,
    resuming_suspended_per_turn: bool,
) -> Result<Option<Box<dyn crate::codex_provider::Provider>>, DurableRunnerError> {
    let Some(provider_config) = state.provider_config.clone() else {
        return Ok(None);
    };
    let resume_thread_id = state.provider_session_id.clone();
    let tools = state
        .provider_tool_bridge
        .authorized_tools()
        .cloned()
        .collect::<Vec<_>>();
    let completion_contract = state.completion_contract.as_ref().map(|contract| {
        json!({
            "revision": contract.revision,
            "criterionIds": contract.criterion_ids,
        })
    });
    let replace_acpx_provider_session = (resuming_suspended_per_turn
        || std::env::var("PAPERCLIP_ACPX_PROVIDER_RECOVERY_POLICY")
            .is_ok_and(|value| value == "allow_replacement_after_governed_wait")
        || semantic_result_allows_governed_wait_replacement(state.semantic_result.as_ref()))
        && matches!(provider_config, crate::codex_provider::ProviderConfig::Acpx(_))
        && state.provider_session_identity.is_some();
    let replacement_provider_session_key = replace_acpx_provider_session.then(|| {
        format!(
            "{}:governed-wait-replacement:{}",
            state.normalized_session_id, state.run_id
        )
    });
    let runtime: Box<dyn crate::codex_provider::Provider> = match provider_config {
        crate::codex_provider::ProviderConfig::Local(local) => Box::new(
            crate::codex_provider::CodexProvider::start_with_completion_contract(
                &local,
                tools.into_iter(),
                resume_thread_id.as_deref(),
                completion_contract.as_ref(),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!("failed to start local provider: {error}"))
            })?,
        ),
        crate::codex_provider::ProviderConfig::ClaudeManaged(mut managed) => Box::new({
            if let Some(value) = state.provider_budget_ceiling_usd {
                managed.max_session_list_cost_usd = value;
            }
            crate::claude_managed_provider::ClaudeManagedProvider::start(
                &managed,
                tools,
                resume_thread_id.as_deref(),
                state.provider_event_cursor.as_deref(),
                state
                    .provider_usage_cumulative
                    .as_ref()
                    .and_then(|value| value.get("requests"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to start Claude Agent provider: {error}"
                ))
            })?
        }),
        crate::codex_provider::ProviderConfig::AwsAgentcore(mut agentcore) => Box::new({
            if let Some(value) = state.provider_budget_ceiling_usd {
                agentcore.max_estimated_session_cost_usd = value;
            }
            crate::aws_agentcore_provider::AwsAgentCoreHarnessProvider::start(
                &agentcore,
                tools,
                resume_thread_id.as_deref(),
                state.provider_event_cursor.as_deref(),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "failed to start AWS AgentCore provider: {error}"
                ))
            })?
        }),
        crate::codex_provider::ProviderConfig::Acpx(acpx) => Box::new(
            crate::acpx_provider::AcpxProvider::start(
                &acpx,
                tools,
                if replace_acpx_provider_session {
                    None
                } else {
                    state.provider_session_identity.as_ref()
                },
                replacement_provider_session_key.as_deref(),
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!("failed to start ACPX provider: {error}"))
            })?,
        ),
    };
    if !replace_acpx_provider_session {
        if let Some(expected) = state.provider_session_id.as_deref() {
        if expected != runtime.session_identity() {
            return Err(DurableRunnerError::invalid(
                "provider recovery returned a different durable session identity",
            ));
        }
        }
    }
    if !replace_acpx_provider_session {
        if let Some(expected) = state.provider_backend_session_id.as_deref() {
        if Some(expected) != runtime.provider_session_id() {
            return Err(DurableRunnerError::invalid(
                "provider recovery returned a different provider-native session identity",
            ));
        }
        }
    }
    let durable_identity = runtime.durable_session_identity();
    if !replace_acpx_provider_session {
        if let Some(expected) = state.provider_session_identity.as_ref() {
        if Some(expected) != durable_identity.as_ref() {
            return Err(DurableRunnerError::invalid(
                "provider recovery returned a different tagged session identity",
            ));
        }
        }
    } else {
        state.record_diagnostic(
            "ACPX rotated its provider-native session after a per-turn suspension or governed wait",
        );
    }
    state.provider_session_id = Some(runtime.session_identity().to_owned());
    state.provider_backend_session_id = runtime.provider_session_id().map(str::to_owned);
    state.provider_session_identity = durable_identity;
    Ok(Some(runtime))
}

fn semantic_result_allows_governed_wait_replacement(result: Option<&Value>) -> bool {
    result.is_some_and(|value| {
        value
            .get("reportedWorkDisposition")
            .and_then(Value::as_str)
            == Some("yielded")
            && value.pointer("/continuation/kind").and_then(Value::as_str)
                == Some("response_wake")
    })
}

fn provider_kind_name(kind: crate::codex_provider::ProviderKind) -> &'static str {
    match kind {
        crate::codex_provider::ProviderKind::Codex => "codex",
        crate::codex_provider::ProviderKind::Opencode => "opencode",
        crate::codex_provider::ProviderKind::ClaudeManaged => "claude_managed",
        crate::codex_provider::ProviderKind::AwsAgentcore => "aws_agentcore",
        crate::codex_provider::ProviderKind::Acpx => "acpx",
    }
}

fn provider_descriptor(
    config: Option<&crate::codex_provider::ProviderConfig>,
    runtime: Option<&dyn crate::codex_provider::Provider>,
) -> Value {
    let runtime_identity = runtime.map(|value| value.runtime_identity());
    match config {
        Some(crate::codex_provider::ProviderConfig::ClaudeManaged(value)) => json!({
            "provider": "claude_managed",
            "driver": "claude_managed_agents_api",
            "model": value.model,
            "executionKind": "remote_service",
            "providerVersion": value.agent_version,
            "service": "anthropic_managed_agents",
            "providerSessionId": runtime.and_then(|item| item.provider_session_id()),
            "processId": Value::Null,
        }),
        Some(crate::codex_provider::ProviderConfig::AwsAgentcore(value)) => json!({
            "provider": "aws_agentcore",
            "driver": "aws_agentcore_harness_api",
            "model": value.model,
            "executionKind": "remote_service",
            "providerVersion": value.harness_version,
            "service": "aws_bedrock_agentcore_harness",
            "providerSessionId": runtime.and_then(|item| item.provider_session_id()),
            "processId": Value::Null,
            "endpointArn": value.endpoint_arn,
            "endpointQualifier": value.endpoint_qualifier,
            "memoryId": value.memory_id,
            "eventExpiryDays": value.event_expiry_days,
        }),
        Some(crate::codex_provider::ProviderConfig::Acpx(value)) => json!({
            "provider": "acpx",
            "driver": "acpx_runtime",
            "agent": value.agent,
            "model": value.model,
            "requestedModel": value.model,
            "executionKind": "local_process",
            "providerVersion": value.acpx_version,
            "acpProtocolVersion": 1,
            "agentServerPackage": value.agent_server_package,
            "agentServerVersion": value.agent_server_version,
            "agentRuntimePackage": value.agent_runtime_package,
            "agentRuntimeVersion": value.agent_runtime_version,
            "providerSessionId": runtime.and_then(|item| item.provider_session_id()),
            "acpxRecordId": runtime.map(|item| item.session_identity()),
            "processId": match runtime_identity {
                Some(crate::codex_provider::ProviderRuntimeIdentity::LocalProcess { process_id, .. }) => Some(process_id),
                _ => None,
            },
            "agentProcessId": runtime.and_then(|item| item.agent_process_id()),
            "permissionMode": value.permission_mode,
        }),
        Some(crate::codex_provider::ProviderConfig::Local(value)) => json!({
            "provider": provider_kind_name(value.kind),
            "driver": if value.kind == crate::codex_provider::ProviderKind::Opencode { "opencode_server" } else { "codex_app_server" },
            "model": value.model,
            "collaborationMode": value.collaboration_mode,
            "approvalPolicy": value.approval_policy,
            "collaborationInstructions": value.include_collaboration_mode_instructions,
            "executionKind": "local_process",
            "providerVersion": if value.kind == crate::codex_provider::ProviderKind::Opencode { "1.18.17" } else { "unqualified" },
            "providerSessionId": runtime.and_then(|item| item.provider_session_id()),
            "processId": match runtime_identity {
                Some(crate::codex_provider::ProviderRuntimeIdentity::LocalProcess { process_id, .. }) => Some(process_id),
                _ => None,
            },
        }),
        None => json!({
            "provider": "codex",
            "driver": "codex_app_server",
            "model": Value::Null,
            "executionKind": "local_process",
            "providerVersion": "unqualified",
            "providerSessionId": Value::Null,
            "processId": Value::Null,
        }),
    }
}

fn process_command_and_provider(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    provider: &mut Option<Box<dyn crate::codex_provider::Provider>>,
    command: &Value,
) -> Result<ProcessedCommand, DurableRunnerError> {
    let command_id = command
        .get("commandId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fresh = !state.processed_commands.contains_key(command_id);
    let before = state.clone();
    let processed = process_command(state, store, config, command)?;
    if !fresh || processed.status != "completed" {
        if !fresh
            && processed.status == "completed"
            && command.get("type").and_then(Value::as_str) == Some("semantic_tool.result")
            && provider.as_ref().is_some_and(|runtime| {
                matches!(
                    runtime.kind(),
                    crate::codex_provider::ProviderKind::ClaudeManaged
                        | crate::codex_provider::ProviderKind::AwsAgentcore
                )
            })
        {
            let result: crate::provider_bridge::ToolResult =
                serde_json::from_value(command["payload"].clone()).map_err(|error| {
                    DurableRunnerError::invalid(format!("semantic tool result is invalid: {error}"))
                })?;
            provider
                .as_mut()
                .expect("checked above")
                .deliver_tool_result(&result)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to reconcile remote provider tool result: {error}"
                    ))
                })?;
        }
        return Ok(processed);
    }
    match command.get("type").and_then(Value::as_str) {
        Some("run.prepare") => {
            if provider.is_none() {
                *provider = match start_configured_provider(state, false) {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let detail = error.to_string();
                        *state = before;
                        state.lifecycle = "recoverable_failure".to_owned();
                        state.recoverable_failure = Some(detail.clone());
                        state.record_diagnostic(detail.clone());
                        let mut failed = processed;
                        failed.status = "failed".to_owned();
                        failed.logical_effect_count = 0;
                        failed.result = sanitize_value(&json!({
                            "commandId": failed.command_id.clone(),
                            "controllerSeq": failed.controller_seq,
                            "status": "failed",
                            "logicalEffectCount": 0,
                            "detail": detail,
                        }));
                        state.last_controller_command_seq = failed.controller_seq;
                        state
                            .processed_commands
                            .insert(failed.command_id.clone(), failed.clone());
                        compact_processed_commands(state)?;
                        store.save(state)?;
                        return Ok(failed);
                    }
                };
                if let Some(runtime) = provider.as_ref() {
                    let descriptor =
                        provider_descriptor(state.provider_config.as_ref(), Some(runtime.as_ref()));
                    let provider_identity = state.provider_session_identity.clone();
                    enqueue_event(
                        state,
                        config,
                        "harness.ready",
                        0,
                        json!({
                            "providerDescriptor": descriptor,
                            "runtimeIdentity": runtime.runtime_identity(),
                            "threadId": runtime.session_identity(),
                            "sessionId": runtime.provider_session_id(),
                            "providerIdentity": provider_identity,
                            "resumed": state.reconnect_count > 0,
                        }),
                        None,
                    )?;
                    store.save(state)?;
                }
            }
        }
        Some("turn.start") => {
            let Some(runtime) = provider.as_mut() else {
                // The deterministic recovery harness remains the provider for
                // legacy transport conformance runs with no provider config.
                return Ok(processed);
            };
            let text = command
                .pointer("/payload/text")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("turn.start payload.text is required")
                })?;
            let cwd = state
                .provider_config
                .as_ref()
                .and_then(|value| value.local_cwd())
                .unwrap_or(".");
            let turn_id = state.turn_id.clone();
            runtime.start_turn(text, cwd, &turn_id).map_err(|error| {
                DurableRunnerError::invalid(format!("provider turn.start failed: {error}"))
            })?;
        }
        Some("run.attach") => {
            if !state.pending_provider_runtime_requests.is_empty() {
                return Err(DurableRunnerError::invalid(
                    "cannot attach a run while a provider runtime request is pending",
                ));
            }
            if let Some(runtime) = provider.as_mut() {
                runtime
                    .attach_run(
                        &state.run_id.clone(),
                        state
                            .provider_tool_bridge
                            .authorized_tools()
                            .cloned()
                            .collect(),
                    )
                    .map_err(|error| {
                        *state = before;
                        let _ = store.save(state);
                        DurableRunnerError::invalid(format!(
                            "failed to replace provider tools: {error}"
                        ))
                    })?;
            }
        }
        Some("request.resolve") => {
            let request_id = command
                .pointer("/payload/requestId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("request.resolve payload.requestId is required")
                })?;
            let turn_id = command
                .pointer("/payload/turnId")
                .and_then(Value::as_str)
                .unwrap_or(state.turn_id.as_str());
            let resolution = command
                .pointer("/payload/resolution")
                .unwrap_or(&command["payload"]);
            let (adapter, request_type) = {
                let pending = state
                    .pending_provider_runtime_requests
                    .get(request_id)
                    .ok_or_else(|| {
                        DurableRunnerError::invalid(
                            "request.resolve named a stale or expired runtime request",
                        )
                    })?;
                if pending.turn_id != turn_id {
                    return Err(DurableRunnerError::invalid(
                        "request.resolve named a stale runtime request turn",
                    ));
                }
                validate_runtime_request_resolution(&pending.request, resolution)?;
                (
                    pending
                        .request
                        .pointer("/origin/adapter")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    pending
                        .request
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                )
            };
            provider
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("request.resolve requires a provider"))?
                .resolve_runtime_request(request_id, turn_id, resolution)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to resolve provider runtime request: {error}"
                    ))
                })?;
            state.pending_provider_runtime_requests.remove(request_id);
            state.lifecycle = "active".to_owned();
            enqueue_event(
                state,
                config,
                "runtime_request.resolved",
                0,
                json!({
                    "requestId": request_id,
                    "turnId": turn_id,
                    "action": resolution.get("action"),
                    "response": resolution.get("response"),
                    "adapter": adapter,
                    "requestType": request_type,
                }),
                Some(&state.item_id.clone()),
            )?;
            store.save(state)?;
        }
        Some("turn.steer") => {
            let steering = (|| -> Result<(String, String), DurableRunnerError> {
                let text = command
                    .pointer("/payload/text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        DurableRunnerError::invalid("turn.steer payload.text is required")
                    })?;
                let turn_id = command
                    .pointer("/payload/turnId")
                    .and_then(Value::as_str)
                    .unwrap_or(state.turn_id.as_str());
                if turn_id != state.turn_id || !state.active_turn {
                    return Err(DurableRunnerError::invalid("turn.steer named a stale turn"));
                }
                provider
                    .as_mut()
                    .ok_or_else(|| DurableRunnerError::invalid("turn.steer requires a provider"))?
                    .steer_turn(turn_id, text)
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!("provider turn.steer failed: {error}"))
                    })?;
                Ok((turn_id.to_owned(), text.to_owned()))
            })();
            let (turn_id, _text) = match steering {
                Ok(value) => value,
                Err(error) => {
                    // process_command persisted its dedupe entry before the
                    // provider effect. Roll that state back so a rejected or
                    // timed-out steering command remains genuinely retryable.
                    *state = before;
                    store.save(state)?;
                    return Err(error);
                }
            };
            enqueue_event(
                state,
                config,
                "item.completed",
                1,
                json!({
                    "kind": "steering_acknowledgement",
                    "status": "acknowledged",
                    "text": "Steering acknowledged for the active turn.",
                    "commandId": command_id,
                    "correlationId": command.pointer("/payload/correlationId").cloned().unwrap_or(Value::Null),
                }),
                Some(&format!("{}:steer:{}", turn_id, command_id)),
            )?;
            store.save(state)?;
        }
        Some("semantic_tool.result") => {
            let result: crate::provider_bridge::ToolResult =
                serde_json::from_value(command["payload"].clone()).map_err(|error| {
                    DurableRunnerError::invalid(format!("semantic tool result is invalid: {error}"))
                })?;
            let completion_input = successful_completion_tool_input(&before, &result);
            provider
                .as_mut()
                .ok_or_else(|| {
                    DurableRunnerError::invalid("semantic tool result requires a provider")
                })?
                .deliver_tool_result(&result)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to return tool result to provider: {error}"
                    ))
                })?;
            if let Some(input) = completion_input {
                record_provider_semantic_result(
                    state,
                    config,
                    input,
                    Some(result.call_id.as_str()),
                )?;
                complete_turn_after_semantic_result(state, config)?;
                store.save(state)?;
            }
        }
        Some("turn.interrupt") => {
            let turn_id = command
                .pointer("/payload/turnId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("turn.interrupt payload.turnId is required")
                })?;
            provider
                .as_mut()
                .ok_or_else(|| DurableRunnerError::invalid("turn.interrupt requires a provider"))?
                .interrupt_turn(turn_id)
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("provider turn.interrupt failed: {error}"))
                })?;
        }
        Some("provider.thread.read") => {
            let response = provider
                .as_mut()
                .ok_or_else(|| {
                    DurableRunnerError::invalid("provider.thread.read requires a provider")
                })?
                .read()
                .map_err(|error| {
                    DurableRunnerError::invalid(format!("provider session read failed: {error}"))
                })?;
            enqueue_event(
                state,
                config,
                "provider.rpc_result",
                0,
                json!({ "commandId": command_id, "method": "thread/read", "result": response }),
                None,
            )?;
            store.save(state)?;
        }
        Some("session.budget.increase") => {
            let value = command
                .pointer("/payload/maxSessionListCostUsd")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    DurableRunnerError::invalid(
                        "session.budget.increase payload.maxSessionListCostUsd is required",
                    )
                })?;
            provider
                .as_mut()
                .ok_or_else(|| {
                    DurableRunnerError::invalid("session budget increase requires a provider")
                })?
                .increase_budget(value)
                .map_err(|error| {
                    *state = before.clone();
                    let _ = store.save(state);
                    DurableRunnerError::invalid(format!(
                        "failed to increase remote session budget: {error}"
                    ))
                })?;
            enqueue_event(
                state,
                config,
                "session.updated",
                0,
                json!({
                    "update": "budget_increased",
                    "maxSessionListCostUsd": value,
                }),
                None,
            )?;
            state.provider_budget_ceiling_usd = Some(value);
            state.lifecycle = if state.active_turn {
                "active".to_owned()
            } else {
                "warm_idle".to_owned()
            };
            store.save(state)?;
        }
        Some("session.destroy") => {
            let mut runtime = provider.take().ok_or_else(|| {
                DurableRunnerError::invalid("session.destroy requires a provider")
            })?;
            if let Err(error) = runtime.destroy_session() {
                *provider = Some(runtime);
                *state = before;
                let _ = store.save(state);
                return Err(DurableRunnerError::invalid(format!(
                    "failed to delete remote provider session: {error}"
                )));
            }
            state.provider_session_id = None;
            state.provider_backend_session_id = None;
            state.provider_event_cursor = None;
            state.lifecycle = "stopped".to_owned();
            state.stop_after_flush = true;
            enqueue_event(
                state,
                config,
                "session.closed",
                0,
                json!({ "remoteDeleted": true, "resumable": false }),
                None,
            )?;
            store.save(state)?;
        }
        Some("runner.shutdown") | Some("runner.suspend") => {
            if let Some(mut runtime) = provider.take() {
                runtime.shutdown().map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "failed to stop provider during runner shutdown: {error}"
                    ))
                })?;
            }
        }
        _ => {}
    }
    Ok(processed)
}

fn poll_provider(
    provider: &mut Option<Box<dyn crate::codex_provider::Provider>>,
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    let Some(runtime) = provider.as_mut() else {
        return Ok(());
    };
    loop {
        let event = match runtime.poll() {
            Ok(Some(event)) => event,
            Ok(None) => break,
            Err(error) => {
                let detail = error.to_string();
                expire_provider_runtime_requests_after_provider_loss(state, config)?;
                persist_provider_failure(state, store, &detail)?;
                return Err(DurableRunnerError::invalid(format!(
                    "provider failed: {detail}"
                )));
            }
        };
        let trace_frame_id = runtime.take_provider_trace_frame_id();
        let trace_first_source_seq = state.next_source_seq;
        let (mut trace_rule_id, mut trace_disposition, trace_dropped_fields, mut trace_reason) = match &event {
            crate::codex_provider::ProviderEvent::ToolCall { .. } => (
                "provider.tool_call",
                "mapped",
                Vec::new(),
                "Provider tool call mapped to semantic_tool.input",
            ),
            crate::codex_provider::ProviderEvent::SemanticResult { .. } => (
                "provider.semantic_result",
                "mapped",
                Vec::new(),
                "Provider semantic result mapped independently from final prose",
            ),
            crate::codex_provider::ProviderEvent::RuntimeRequest { .. } => (
                "provider.runtime_request",
                "mapped",
                Vec::new(),
                "Provider request mapped to runtime_request.created",
            ),
            crate::codex_provider::ProviderEvent::Notification { method, .. } if matches!(
                method.as_str(),
                "turn/started" | "turn/completed" | "item/started" | "item/delta" | "item/completed" | "thread/tokenUsage/updated" | "provider/budgetReached" | "acpx/process"
            ) => (
                "provider.notification.known",
                "mapped",
                Vec::new(),
                "Known provider notification mapped to canonical PRP event",
            ),
            crate::codex_provider::ProviderEvent::Notification { .. } => (
                "provider.notification.unknown",
                "generic",
                vec!["params".to_owned()],
                "Unknown provider notification retained as harness.diagnostic without provider-only fields",
            ),
            crate::codex_provider::ProviderEvent::Exited => (
                "provider.process.exited",
                "rejected",
                Vec::new(),
                "Provider exited before a new frame could be mapped",
            ),
        };
        match event {
            crate::codex_provider::ProviderEvent::ToolCall {
                call_id,
                operation_id,
                input,
            } => {
                state.last_activity_at_unix_ms = current_unix_ms()?;
                let pending_before_resume = state
                    .provider_tool_bridge
                    .pending_calls()
                    .any(|pending| pending.call_id == call_id);
                let call = match state.provider_tool_bridge.begin_call(
                    call_id.clone(),
                    operation_id.clone(),
                    input,
                ) {
                    Ok(call) => call,
                    Err(error) => {
                        let reason = error.to_string();
                        runtime
                            .deliver_tool_result(&crate::provider_bridge::ToolResult {
                                call_id: call_id.clone(),
                                operation_id: operation_id.clone(),
                                result: json!({
                                    "error": {
                                        "code": "invalid_tool_call",
                                        "message": reason,
                                        "retryable": true,
                                    }
                                }),
                                is_error: true,
                            })
                            .map_err(|delivery_error| {
                                DurableRunnerError::invalid(format!(
                                    "provider tool rejection could not be delivered: {delivery_error}"
                                ))
                            })?;
                        enqueue_event(
                            state,
                            config,
                            "harness.diagnostic",
                            1,
                            json!({
                                "operationId": operation_id,
                                "callId": call_id,
                                "code": "semantic_tool_denied",
                                "status": "failed",
                                "paperclipExecuted": false,
                                "reasons": ["schema_invalid_or_unauthorized_input"],
                                "summary": "Provider tool call was rejected before Paperclip execution.",
                            }),
                            Some(&state.item_id.clone()),
                        )?;
                        trace_rule_id = "provider.tool_call.rejected";
                        trace_disposition = "rejected";
                        trace_reason = "Provider tool call failed authorization or input validation and was returned to the provider for correction";
                        store.save(state)?;
                        if let Some(frame_id) = trace_frame_id {
                            let emitted_event_ids = (trace_first_source_seq..state.next_source_seq)
                                .map(|source_seq| {
                                    format!("event_{}_{source_seq:06}", state.runner_instance_id)
                                })
                                .collect::<Vec<_>>();
                            runtime.record_provider_trace_interpretation(
                                frame_id,
                                "rust_durable_normalization",
                                trace_rule_id,
                                trace_disposition,
                                emitted_event_ids,
                                trace_dropped_fields,
                                trace_reason,
                            );
                        }
                        continue;
                    }
                };
                if pending_before_resume {
                    enqueue_event(
                        state,
                        config,
                        "semantic_tool.reconciled",
                        0,
                        json!({
                            "semantic_tool": {
                                "schema": "paperclip.prp.semantic_tool.v1", "schemaVersion": 1,
                                "phase": "reconciled", "operationId": call.operation_id,
                                "callId": call.call_id,
                            },
                            "reason": "provider_replayed_pending_call",
                        }),
                        Some(&state.item_id.clone()),
                    )?;
                } else {
                    let input_digest = sha256_digest(canonical_json(&call.input).as_bytes());
                    enqueue_event(
                        state,
                        config,
                        "semantic_tool.input",
                        0,
                        json!({
                            "semantic_tool": {
                                "schema": "paperclip.prp.semantic_tool.v1", "schemaVersion": 1,
                                "phase": "input", "operationId": call.operation_id,
                                "callId": call.call_id,
                                "correlation": {
                                    "runId": state.run_id,
                                    "normalizedSessionId": state.normalized_session_id,
                                    "turnId": state.turn_id,
                                    "itemId": state.item_id,
                                },
                                "idempotencyKey": Value::Null,
                                "content": {
                                    "digest": input_digest,
                                    "redactionDisposition": "digest_only",
                                    "references": [],
                                },
                                "input": call.input,
                            }
                        }),
                        Some(&state.item_id.clone()),
                    )?;
                }
                store.save(state)?;
            }
            crate::codex_provider::ProviderEvent::Notification { method, params } => {
                state.last_activity_at_unix_ms = current_unix_ms()?;
                if method == "item/completed" {
                    let item = params.get("item").unwrap_or(&params);
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                        state.last_agent_message = item
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                            .map(|text| text.chars().take(1_000_000).collect());
                    }
                }
                for (canonical_type, canonical_payload, canonical_item_id) in
                    crate::provider_events::canonical_provider_events(&method, &params)
                {
                    if canonical_type == "run.result.proposed" {
                        // Codex can expose the semantic completion as a
                        // provider item rather than a dedicated notification.
                        // Route both representations through the same durable
                        // admission seam so terminal fallback cannot emit a
                        // second, structurally different result.
                        record_provider_semantic_result(
                            state,
                            config,
                            canonical_payload,
                            Some(&canonical_item_id),
                        )?;
                    } else {
                        enqueue_event(
                            state,
                            config,
                            &canonical_type,
                            if canonical_type.ends_with("completed") {
                                1
                            } else {
                                2
                            },
                            canonical_payload,
                            Some(&canonical_item_id),
                        )?;
                    }
                }
                let event_type = match method.as_str() {
                    "turn/started" => "turn.started",
                    "turn/completed" => {
                        match params.pointer("/turn/status").and_then(Value::as_str) {
                            Some("failed") => "turn.failed",
                            Some("interrupted") => "turn.interrupted",
                            Some("cancelled" | "canceled") => "turn.cancelled",
                            _ => "turn.completed",
                        }
                    }
                    "item/started" => "item.started",
                    "item/delta" => "item.delta",
                    "item/completed" => "item.completed",
                    "thread/tokenUsage/updated" => "usage.reported",
                    "provider/budgetReached" => "session.updated",
                    _ => "harness.diagnostic",
                };
                // Streaming deltas and startup chatter are intentionally coalescible,
                // but terminal items and accounting must survive pressure intact.
                let priority = match method.as_str() {
                    "turn/completed" | "thread/tokenUsage/updated" => 0,
                    "turn/started" | "item/completed" => 1,
                    _ => 2,
                };
                let payload = if method == "thread/tokenUsage/updated" {
                    let cumulative = normalized_usage_measurement(&params);
                    let baseline = state
                        .provider_usage_run_baseline
                        .as_ref()
                        .map(normalized_usage_measurement)
                        .unwrap_or_else(empty_usage_measurement);
                    let run_delta = usage_delta(&cumulative, &baseline);
                    state.provider_usage_cumulative = Some(cumulative.clone());
                    json!({
                        "provider": provider_kind_name(runtime.kind()),
                        "model": state.provider_config.as_ref().and_then(provider_model),
                        "providerSessionId": runtime.provider_session_id(),
                        "providerRequestId": params.get("request_id").or_else(|| params.get("requestId")).and_then(Value::as_str),
                        "cumulative": cumulative,
                        "runDelta": run_delta,
                    })
                } else if method == "acpx/process" {
                    json!({
                        "providerMethod": method,
                        "role": params.get("role").and_then(Value::as_str),
                        "pid": params.get("pid").and_then(Value::as_u64),
                        "processGroupId": params.get("processGroupId").and_then(Value::as_u64),
                        "startedAt": params.get("startedAt").and_then(Value::as_str),
                    })
                } else if matches!(
                    method.as_str(),
                    "turn/started"
                        | "item/started"
                        | "item/delta"
                        | "item/completed"
                        | "turn/completed"
                        | "provider/budgetReached"
                ) {
                    params.clone()
                } else {
                    json!({ "providerMethod": method, "detail": "provider event was not part of the normalized public contract" })
                };
                let is_terminal = matches!(
                    event_type,
                    "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted"
                );
                let bound_run_terminal = if is_terminal {
                    cancel_pending_runtime_requests_on_terminal(
                        state,
                        config,
                        "provider_turn_became_terminal",
                    )?;
                    enqueue_bound_result_event(state, config, event_type)?
                } else {
                    None
                };
                enqueue_event(
                    state,
                    config,
                    event_type,
                    priority,
                    payload,
                    Some(&state.item_id.clone()),
                )?;
                if method == "provider/budgetReached" {
                    state.lifecycle = "waiting_input".to_owned();
                }
                if is_terminal {
                    if let Some(terminal) = bound_run_terminal {
                        let item_id = state.item_id.clone();
                        enqueue_event(
                            state,
                            config,
                            "run.terminal",
                            0,
                            terminal,
                            Some(&item_id),
                        )?;
                    }
                    state.active_turn = false;
                    if state.lifecycle_mode == "warm" {
                        state.lifecycle = "warm_idle".to_owned();
                    } else {
                        state.lifecycle = "suspending".to_owned();
                        state.stop_after_flush = true;
                        enqueue_event(
                            state,
                            config,
                            "runner.suspending",
                            0,
                            json!({ "reason": "per_turn_complete", "resumable": true }),
                            None,
                        )?;
                    }
                }
                store.save(state)?;
            }
            crate::codex_provider::ProviderEvent::SemanticResult { result, item_id } => {
                state.last_activity_at_unix_ms = current_unix_ms()?;
                record_provider_semantic_result(state, config, result, item_id.as_deref())?;
                store.save(state)?;
            }
            crate::codex_provider::ProviderEvent::RuntimeRequest { request } => {
                state.last_activity_at_unix_ms = current_unix_ms()?;
                let request_id = request
                    .get("requestId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        DurableRunnerError::invalid("provider runtime request omitted requestId")
                    })?
                    .to_owned();
                let request_kind = request
                    .pointer("/origin/kind")
                    .and_then(Value::as_str)
                    .unwrap_or("runtime")
                    .to_owned();
                if state
                    .pending_provider_runtime_requests
                    .contains_key(&request_id)
                {
                    return Err(DurableRunnerError::invalid(
                        "provider reused a pending runtime request id",
                    ));
                }
                state.pending_provider_runtime_requests.insert(
                    request_id.clone(),
                    PendingProviderRuntimeRequest {
                        request_id: request_id.clone(),
                        turn_id: state.turn_id.clone(),
                        request_kind: request_kind.clone(),
                        created_at_unix_ms: state.last_activity_at_unix_ms,
                        request: request.clone(),
                    },
                );
                state.lifecycle = "waiting_input".to_owned();
                enqueue_event(
                    state,
                    config,
                    "runtime_request.created",
                    0,
                    json!({ "request": request }),
                    Some(&state.item_id.clone()),
                )?;
                store.save(state)?;
            }
            crate::codex_provider::ProviderEvent::Exited => {
                expire_provider_runtime_requests_after_provider_loss(state, config)?;
                persist_provider_failure(state, store, "local provider exited unexpectedly")?;
                return Err(DurableRunnerError::invalid(
                    "native_runner_process_exited: local provider exited unexpectedly",
                ));
            }
        }
        if let Some(frame_id) = trace_frame_id {
            let emitted_event_ids = (trace_first_source_seq..state.next_source_seq)
                .map(|source_seq| format!("event_{}_{source_seq:06}", state.runner_instance_id))
                .collect::<Vec<_>>();
            runtime.record_provider_trace_interpretation(
                frame_id,
                "rust_durable_normalization",
                trace_rule_id,
                trace_disposition,
                emitted_event_ids,
                trace_dropped_fields,
                trace_reason,
            );
        }
        if let Some(cursor) = runtime.durable_event_cursor() {
            state.provider_event_cursor = Some(cursor.to_owned());
            store.save(state)?;
        }
    }
    Ok(())
}

fn provider_model(config: &crate::codex_provider::ProviderConfig) -> Option<&str> {
    match config {
        crate::codex_provider::ProviderConfig::Local(value) => value.model.as_deref(),
        crate::codex_provider::ProviderConfig::ClaudeManaged(value) => Some(value.model.as_str()),
        crate::codex_provider::ProviderConfig::AwsAgentcore(value) => Some(value.model.as_str()),
        crate::codex_provider::ProviderConfig::Acpx(value) => Some(value.model.as_str()),
    }
}

fn empty_usage_measurement() -> Value {
    json!({
        "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
        "cacheWriteTokens": 0, "reasoningTokens": 0, "activeSeconds": 0.0, "requests": 0,
        "providerCostUsd": 0.0,
    })
}

fn usage_number(value: &Value, snake: &str, camel: &str) -> f64 {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn normalized_usage_measurement(value: &Value) -> Value {
    let usage = value
        .get("usage")
        .or_else(|| value.pointer("/tokenUsage/total"))
        .or_else(|| value.get("tokenUsage"))
        .unwrap_or(value);
    let cost = usage.get("list_cost").or_else(|| usage.get("listCost"));
    // Managed Agents reports list cost as an integer number of US cents.
    // Local providers already publish providerCostUsd as dollars.
    let provider_cost = cost
        .and_then(|value| value.get("amount"))
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .map(|cents| cents / 100.0)
        .unwrap_or_else(|| {
            let normalized = usage_number(usage, "provider_cost_usd", "providerCostUsd");
            if normalized > 0.0 {
                normalized
            } else {
                usage_number(usage, "cost_usd", "costUsd")
            }
        });
    let cache_creation = usage
        .get("cache_creation")
        .or_else(|| usage.get("cacheCreation"));
    let cache_write_tokens = usage_number(usage, "cache_creation_input_tokens", "cacheWriteTokens")
        + cache_creation
            .map(|value| {
                usage_number(value, "ephemeral_5m_input_tokens", "ephemeral5mInputTokens")
                    + usage_number(value, "ephemeral_1h_input_tokens", "ephemeral1hInputTokens")
            })
            .unwrap_or(0.0);
    json!({
        "inputTokens": usage_number(usage, "input_tokens", "inputTokens") as u64,
        "outputTokens": usage_number(usage, "output_tokens", "outputTokens") as u64,
        "cacheReadTokens": ({
            let normalized = usage_number(usage, "cache_read_input_tokens", "cacheReadTokens");
            if normalized > 0.0 { normalized } else { usage_number(usage, "cached_input_tokens", "cachedInputTokens") }
        } as u64),
        "cacheWriteTokens": cache_write_tokens as u64,
        "reasoningTokens": usage_number(usage, "reasoning_tokens", "reasoningTokens") as u64,
        "activeSeconds": usage_number(usage, "active_seconds", "activeSeconds"),
        "requests": usage_number(usage, "requests", "requestCount") as u64,
        "providerCostUsd": provider_cost,
    })
}

fn usage_delta(cumulative: &Value, baseline: &Value) -> Value {
    let integer_delta = |field: &str| {
        cumulative
            .get(field)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_sub(baseline.get(field).and_then(Value::as_u64).unwrap_or(0))
    };
    let number_delta = |field: &str| {
        (cumulative.get(field).and_then(Value::as_f64).unwrap_or(0.0)
            - baseline.get(field).and_then(Value::as_f64).unwrap_or(0.0))
        .max(0.0)
    };
    json!({
        "inputTokens": integer_delta("inputTokens"),
        "outputTokens": integer_delta("outputTokens"),
        "cacheReadTokens": integer_delta("cacheReadTokens"),
        "cacheWriteTokens": integer_delta("cacheWriteTokens"),
        "reasoningTokens": integer_delta("reasoningTokens"),
        "activeSeconds": number_delta("activeSeconds"),
        "requests": integer_delta("requests"),
        "providerCostUsd": number_delta("providerCostUsd"),
    })
}

fn should_suspend_for_idle(state: &DurableRunnerState) -> Result<bool, DurableRunnerError> {
    should_suspend_for_idle_at(state, current_unix_ms()?)
}

fn should_suspend_for_idle_at(
    state: &DurableRunnerState,
    now_unix_ms: u64,
) -> Result<bool, DurableRunnerError> {
    if state.lifecycle_mode != "warm"
        || state.stop_after_flush
        || !matches!(state.lifecycle.as_str(), "warm_idle" | "waiting_input")
    {
        return Ok(false);
    }
    if state.lifecycle == "waiting_input"
        && matches!(
            state.provider_config,
            Some(crate::codex_provider::ProviderConfig::Acpx(_))
        )
    {
        return Ok(false);
    }
    let Some(timeout_ms) = state.idle_timeout_ms else {
        return Ok(false);
    };
    Ok(now_unix_ms.saturating_sub(state.last_activity_at_unix_ms) >= timeout_ms)
}

fn validate_runtime_request_resolution(
    request: &Value,
    resolution: &Value,
) -> Result<(), DurableRunnerError> {
    let action = resolution
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            DurableRunnerError::invalid("runtime request resolution.action is required")
        })?;
    if !matches!(
        action,
        "accept" | "accept_for_session" | "decline" | "cancel" | "submit"
    ) {
        return Err(DurableRunnerError::invalid(
            "unsupported runtime request resolution action",
        ));
    }
    if request.get("schema").and_then(Value::as_str) != Some("paperclip.runtime_request.v2") {
        return Ok(());
    }
    if action != "submit" {
        if matches!(action, "accept" | "accept_for_session") {
            return Err(DurableRunnerError::invalid(
                "structured input requires submit, decline, or cancel",
            ));
        }
        return Ok(());
    }
    let response = resolution.get("response").ok_or_else(|| {
        DurableRunnerError::invalid("structured input submission requires response")
    })?;
    let response_schema: Value = serde_json::from_str(include_str!(
        "../../../../../protocol/schemas/question-response.schema.json"
    ))
    .map_err(|_| DurableRunnerError::invalid("embedded question-response schema is invalid"))?;
    let response_validator = jsonschema::validator_for(&response_schema).map_err(|_| {
        DurableRunnerError::invalid("embedded question-response schema cannot compile")
    })?;
    if !response_validator.is_valid(response) {
        return Err(DurableRunnerError::invalid(
            "structured input response failed paperclip.question_response.v1 schema validation",
        ));
    }
    if response.get("schema").and_then(Value::as_str) != Some("paperclip.question_response.v1") {
        return Err(DurableRunnerError::invalid(
            "structured input response must use paperclip.question_response.v1",
        ));
    }
    let answers = response
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DurableRunnerError::invalid("structured input response.answers must be an object")
        })?;
    let questions = request
        .pointer("/input/questions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DurableRunnerError::invalid("persisted runtime request has no question set")
        })?;
    let question_set = request.get("input").unwrap_or(&Value::Null);
    let question_set_schema: Value = serde_json::from_str(include_str!(
        "../../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| DurableRunnerError::invalid("embedded question-set schema is invalid"))?;
    let question_set_validator = jsonschema::validator_for(&question_set_schema)
        .map_err(|_| DurableRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !question_set_validator.is_valid(question_set) {
        return Err(DurableRunnerError::invalid(
            "persisted runtime question set failed schema validation",
        ));
    }
    for answer_id in answers.keys() {
        if !questions
            .iter()
            .any(|question| question.get("id").and_then(Value::as_str) == Some(answer_id))
        {
            return Err(DurableRunnerError::invalid(format!(
                "structured input response named unknown question {answer_id}"
            )));
        }
    }
    for question in questions {
        let question_id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("persisted question omitted id"))?;
        let answer = answers.get(question_id);
        if answer.is_none() {
            if question
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err(DurableRunnerError::invalid(format!(
                    "structured input response omitted required question {question_id}"
                )));
            }
            continue;
        }
        let answer = answer.and_then(Value::as_object).ok_or_else(|| {
            DurableRunnerError::invalid(format!("answer {question_id} must be an object"))
        })?;
        if answer
            .get("selectedOptionIds")
            .is_some_and(|value| !value.is_array())
        {
            return Err(DurableRunnerError::invalid(format!(
                "answer {question_id} selectedOptionIds must be an array"
            )));
        }
        if answer.get("text").is_some_and(|value| !value.is_string())
            || answer
                .get("customText")
                .is_some_and(|value| !value.is_string())
        {
            return Err(DurableRunnerError::invalid(format!(
                "answer {question_id} text values must be strings"
            )));
        }
        let selected = answer
            .get("selectedOptionIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if selected.iter().any(|value| value.as_str().is_none()) {
            return Err(DurableRunnerError::invalid(format!(
                "answer {question_id} selectedOptionIds must contain strings"
            )));
        }
        let mut unique_selected = std::collections::BTreeSet::new();
        if selected
            .iter()
            .filter_map(Value::as_str)
            .any(|option_id| !unique_selected.insert(option_id))
        {
            return Err(DurableRunnerError::invalid(format!(
                "answer {question_id} selectedOptionIds cannot contain duplicates"
            )));
        }
        let mode = question
            .get("answerMode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = answer.get("text").and_then(Value::as_str);
        let custom = answer.get("customText").and_then(Value::as_str);
        if mode == "text" {
            if !selected.is_empty() || custom.is_some() {
                return Err(DurableRunnerError::invalid(format!(
                    "text answer {question_id} carries select fields"
                )));
            }
        } else {
            if text.is_some() {
                return Err(DurableRunnerError::invalid(format!(
                    "select answer {question_id} carries text"
                )));
            }
            if mode == "single_select" && selected.len() > 1 {
                return Err(DurableRunnerError::invalid(format!(
                    "single-select answer {question_id} selected multiple options"
                )));
            }
            if mode == "single_select"
                && !selected.is_empty()
                && custom.is_some_and(|value| !value.trim().is_empty())
            {
                return Err(DurableRunnerError::invalid(format!(
                    "single-select answer {question_id} cannot combine an option and custom text"
                )));
            }
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for option_id in selected.iter().filter_map(Value::as_str) {
                if !options
                    .iter()
                    .any(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                {
                    return Err(DurableRunnerError::invalid(format!(
                        "answer {question_id} selected unknown option {option_id}"
                    )));
                }
            }
            if custom.is_some()
                && question
                    .pointer("/customAnswer/enabled")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(DurableRunnerError::invalid(format!(
                    "answer {question_id} used a disabled custom answer"
                )));
            }
        }
        let has_value = !selected.is_empty()
            || text.is_some_and(|value| !value.trim().is_empty())
            || custom.is_some_and(|value| !value.trim().is_empty());
        if question
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !has_value
        {
            return Err(DurableRunnerError::invalid(format!(
                "answer {question_id} is required"
            )));
        }
        let bounded = if mode == "text" { text } else { custom };
        if let Some(value) = bounded {
            if value.chars().count() > 100_000 {
                return Err(DurableRunnerError::invalid(format!(
                    "answer {question_id} exceeds the maximum text size"
                )));
            }
            let validation = question.get("textValidation").unwrap_or(&Value::Null);
            if let Some(minimum) = validation.get("minLength").and_then(Value::as_u64) {
                if value.chars().count() < minimum as usize {
                    return Err(DurableRunnerError::invalid(format!(
                        "answer {question_id} is too short"
                    )));
                }
            }
            if let Some(maximum) = validation.get("maxLength").and_then(Value::as_u64) {
                if value.chars().count() > maximum as usize {
                    return Err(DurableRunnerError::invalid(format!(
                        "answer {question_id} is too long"
                    )));
                }
            }
            if let Some(pattern) = validation.get("pattern").and_then(Value::as_str) {
                let pattern_schema = json!({"type": "string", "pattern": pattern});
                let pattern_validator =
                    jsonschema::validator_for(&pattern_schema).map_err(|_| {
                        DurableRunnerError::invalid(format!(
                            "question {question_id} contains an invalid text pattern"
                        ))
                    })?;
                if !pattern_validator.is_valid(&json!(value)) {
                    return Err(DurableRunnerError::invalid(format!(
                        "answer {question_id} does not match its required format"
                    )));
                }
            }
            if let Some(input_type) = validation.get("inputType").and_then(Value::as_str) {
                if matches!(input_type, "number" | "integer") {
                    let numeric = value.parse::<f64>().map_err(|_| {
                        DurableRunnerError::invalid(format!(
                            "answer {question_id} must be a valid {input_type}"
                        ))
                    })?;
                    if !numeric.is_finite() {
                        return Err(DurableRunnerError::invalid(format!(
                            "answer {question_id} must be a finite {input_type}"
                        )));
                    }
                    if input_type == "integer" && numeric.fract() != 0.0 {
                        return Err(DurableRunnerError::invalid(format!(
                            "answer {question_id} must be an integer"
                        )));
                    }
                    if validation
                        .get("minimum")
                        .and_then(Value::as_f64)
                        .is_some_and(|minimum| numeric < minimum)
                        || validation
                            .get("maximum")
                            .and_then(Value::as_f64)
                            .is_some_and(|maximum| numeric > maximum)
                    {
                        return Err(DurableRunnerError::invalid(format!(
                            "answer {question_id} is outside its numeric bounds"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

fn expire_provider_runtime_requests_after_provider_loss(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    if state.pending_provider_runtime_requests.is_empty() {
        return Ok(());
    }
    let is_acpx = matches!(
        state.provider_config,
        Some(crate::codex_provider::ProviderConfig::Acpx(_))
    );
    let pending = std::mem::take(&mut state.pending_provider_runtime_requests);
    for request in pending.into_values() {
        enqueue_event(
            state,
            config,
            "runtime_request.expired",
            0,
            json!({
                "requestId": request.request_id,
                "turnId": request.turn_id,
                "requestKind": request.request_kind,
                "reason": "provider_process_lost",
                "replayAllowed": false,
                "adapter": request.request.pointer("/origin/adapter").and_then(Value::as_str),
                "requestType": request.request.get("type").and_then(Value::as_str),
                "request": request.request,
            }),
            Some(&state.item_id.clone()),
        )?;
    }
    if is_acpx {
        state.active_turn = false;
        enqueue_event(
            state,
            config,
            "turn.failed",
            0,
            json!({
                "turn": { "id": state.turn_id, "status": "failed" },
                "error": {
                    "code": "acpx_permission_transport_lost",
                    "message": "The ACP process exited while runtime input was pending; the request will not be replayed against the dead provider.",
                    "recoverable": true,
                }
            }),
            Some(&state.item_id.clone()),
        )?;
    }
    Ok(())
}

fn cancel_pending_runtime_requests_on_terminal(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    reason: &str,
) -> Result<(), DurableRunnerError> {
    let pending = std::mem::take(&mut state.pending_provider_runtime_requests);
    for request in pending.into_values() {
        enqueue_event(
            state,
            config,
            "runtime_request.cancelled",
            0,
            json!({
                "requestId": request.request_id,
                "turnId": request.turn_id,
                "requestKind": request.request_kind,
                "reason": reason,
                "adapter": request.request.pointer("/origin/adapter").and_then(Value::as_str),
                "requestType": request.request.get("type").and_then(Value::as_str),
            }),
            Some(&state.item_id.clone()),
        )?;
    }
    Ok(())
}

fn enqueue_bound_result_event(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    event_type: &str,
) -> Result<Option<Value>, DurableRunnerError> {
    let Some(contract) = state.completion_contract.as_ref() else {
        return Ok(None);
    };
    let succeeded = event_type == "turn.completed";
    let cancelled = matches!(event_type, "turn.cancelled" | "turn.interrupted");
    let semantic_disposition = state
        .semantic_result
        .as_ref()
        .and_then(|result| result.get("reportedWorkDisposition"))
        .and_then(Value::as_str);
    let disposition = semantic_disposition.unwrap_or(if succeeded {
        "done"
    } else {
        "needs_review"
    });
    if state.semantic_result.is_some() {
        return Ok(Some(json!({
            "schema": "paperclip.prp.terminal.v1",
            "turnTerminalState": if succeeded {
                "completed"
            } else if event_type == "turn.interrupted" {
                "interrupted"
            } else if cancelled {
                "cancelled"
            } else {
                "failed"
            },
            "runTerminalState": if succeeded {
                "succeeded"
            } else if cancelled {
                "cancelled"
            } else {
                "failed"
            },
            "reportedWorkDisposition": disposition,
        })));
    }
    let summary = state.last_agent_message.clone().unwrap_or_else(|| {
        if succeeded {
            "The provider completed the requested work.".to_owned()
        } else if cancelled {
            "The provider run stopped before it completed.".to_owned()
        } else {
            "The provider run failed before it completed.".to_owned()
        }
    });
    let evidence_ref = "provider:agent-message";
    let criteria = contract
        .criterion_ids
        .iter()
        .map(|criterion_id| {
            json!({
                "criterionId": criterion_id,
                "status": if succeeded { "satisfied" } else { "unknown" },
                "evidenceRefs": if succeeded {
                    vec![evidence_ref]
                } else {
                    Vec::<&str>::new()
                },
            })
        })
        .collect::<Vec<_>>();
    let result = json!({
        "schema": "paperclip.run_result.v1",
        "reportedWorkDisposition": disposition,
        "summary": summary,
        "completionClaim": {
            "contractRevision": contract.revision,
            "objectiveSatisfied": succeeded,
            "criteria": criteria,
            "remainingWork": if succeeded {
                Vec::<Value>::new()
            } else {
                vec![json!({
                    "description": "Review the stopped provider run and continue the task.",
                    "blocksCompletion": true,
                })]
            },
        },
        "evidence": if succeeded {
            vec![json!({ "ref": evidence_ref })]
        } else {
            Vec::<Value>::new()
        },
        "verification": [],
        "attentionRequests": if succeeded {
            Vec::<Value>::new()
        } else {
            vec![json!({
                "kind": "review",
                "summary": "Review the stopped provider run before continuing.",
                "ownerClass": "human",
            })]
        },
        "artifacts": [],
    });
    let turn_terminal_state = if succeeded {
        "completed"
    } else if event_type == "turn.interrupted" {
        "interrupted"
    } else if cancelled {
        "cancelled"
    } else {
        "failed"
    };
    let terminal = json!({
        "schema": "paperclip.prp.terminal.v1",
        "turnTerminalState": turn_terminal_state,
        "runTerminalState": if succeeded {
            "succeeded"
        } else if cancelled {
            "cancelled"
        } else {
            "failed"
        },
        "reportedWorkDisposition": disposition,
    });
    let item_id = state.item_id.clone();
    enqueue_event(
        state,
        config,
        "run.result.proposed",
        0,
        result,
        Some(&item_id),
    )?;
    Ok(Some(terminal))
}

fn record_provider_semantic_result(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    result: Value,
    provider_item_id: Option<&str>,
) -> Result<(), DurableRunnerError> {
    if let Some(summary) = result
        .get("summary")
        .and_then(Value::as_str)
        .filter(|summary| !summary.is_empty())
    {
        state.last_agent_message = Some(summary.chars().take(1_000_000).collect());
    }
    if state.semantic_result.is_none() {
        state.semantic_result = Some(result.clone());
        let item_id = provider_item_id.unwrap_or(state.item_id.as_str()).to_owned();
        enqueue_event(
            state,
            config,
            "run.result.proposed",
            0,
            result,
            Some(&item_id),
        )?;
    } else {
        let item_id = state.item_id.clone();
        enqueue_event(
            state,
            config,
            "harness.diagnostic",
            1,
            json!({
                "code": "duplicate_semantic_result_ignored",
                "message": "Duplicate provider semantic result ignored; the first result remains authoritative.",
            }),
            Some(&item_id),
        )?;
    }
    Ok(())
}

fn successful_completion_tool_input(
    state_before_result: &DurableRunnerState,
    result: &crate::provider_bridge::ToolResult,
) -> Option<Value> {
    if result.is_error
        || !matches!(
            result.operation_id.as_str(),
            "paperclip_finish" | "paperclip_block"
        )
    {
        return None;
    }
    state_before_result
        .provider_tool_bridge
        .pending_calls()
        .find(|pending| {
            pending.call_id == result.call_id && pending.operation_id == result.operation_id
        })
        .map(|pending| {
            let mut input = pending.input.clone();
            // The controller's semantic-tool authority accepts the same legacy
            // provider shape as the TypeScript driver and deterministically fills
            // these two collection fields. Persist that canonical shape here too:
            // a PRP run.result.proposed event requires both fields even when empty.
            if let Some(object) = input.as_object_mut() {
                object
                    .entry("attentionRequests".to_owned())
                    .or_insert_with(|| json!([]));
                object
                    .entry("artifacts".to_owned())
                    .or_insert_with(|| json!([]));
            }
            input
        })
}

fn complete_turn_after_semantic_result(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    cancel_pending_runtime_requests_on_terminal(
        state,
        config,
        "semantic_completion_accepted",
    )?;
    let terminal = enqueue_bound_result_event(state, config, "turn.completed")?
        .ok_or_else(|| DurableRunnerError::invalid("semantic completion omitted a run result"))?;
    let item_id = state.item_id.clone();
    enqueue_event(
        state,
        config,
        "turn.completed",
        0,
        json!({
            "status": "completed",
            "turn": { "id": state.turn_id, "status": "completed", "items": [] },
            "reason": "semantic_completion_accepted",
        }),
        Some(&item_id),
    )?;
    enqueue_event(
        state,
        config,
        "run.terminal",
        0,
        terminal,
        Some(&item_id),
    )?;
    state.active_turn = false;
    if state.lifecycle_mode == "warm" {
        state.lifecycle = "warm_idle".to_owned();
    } else {
        state.lifecycle = "suspending".to_owned();
        state.stop_after_flush = true;
        enqueue_event(
            state,
            config,
            "runner.suspending",
            0,
            json!({ "reason": "per_turn_complete", "resumable": true }),
            None,
        )?;
    }
    Ok(())
}

fn begin_automatic_suspend(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    provider: &mut Option<Box<dyn crate::codex_provider::Provider>>,
    reason: &str,
) -> Result<(), DurableRunnerError> {
    if state.stop_after_flush {
        return Ok(());
    }
    if let Some(mut runtime) = provider.take() {
        runtime.shutdown().map_err(|error| {
            DurableRunnerError::invalid(format!(
                "failed to checkpoint provider for suspension: {error}"
            ))
        })?;
    }
    state.lifecycle = "suspending".to_owned();
    state.stop_after_flush = true;
    enqueue_event(
        state,
        config,
        "runner.suspending",
        0,
        json!({ "reason": reason, "afterDurableFlush": true, "resumable": true }),
        None,
    )?;
    enqueue_event(
        state,
        config,
        "runner.suspended",
        0,
        json!({ "reason": reason, "resumable": true }),
        None,
    )?;
    store.save(state)
}

fn provider_failure_code(detail: &str) -> &'static str {
    if detail.contains("stdout frame exceeded") || detail.contains("provider_frame_too_large") {
        "provider_frame_too_large"
    } else if detail.contains("terminated and cannot be resumed") {
        "provider_session_terminated"
    } else {
        "provider_transport_failed"
    }
}

fn persist_provider_failure(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    detail: &str,
) -> Result<(), DurableRunnerError> {
    let code = provider_failure_code(detail);
    state.recoverable_failure = Some(code.to_owned());
    state.lifecycle = if code == "provider_session_terminated" {
        "terminated".to_owned()
    } else {
        "recoverable_failure".to_owned()
    };
    state.record_diagnostic(format!("{code}: {detail}"));
    store.save(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_provider::{Provider, ProviderEvent, ProviderKind};
    use crate::local_runner::LocalRunnerError;
    use crate::provider_bridge::{
        AuthorizedTool, AuthorizedToolSet, ToolResult, TOOL_SET_SCHEMA,
    };
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc, Mutex};

    static ENVIRONMENT_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn governed_response_wake_allows_acpx_provider_replacement() {
        let yielded = json!({
            "reportedWorkDisposition": "yielded",
            "continuation": { "kind": "response_wake" },
        });
        assert!(semantic_result_allows_governed_wait_replacement(Some(
            &yielded
        )));
        assert!(!semantic_result_allows_governed_wait_replacement(Some(
            &json!({
                "reportedWorkDisposition": "done",
                "continuation": { "kind": "response_wake" },
            })
        )));
        assert!(!semantic_result_allows_governed_wait_replacement(Some(
            &json!({
                "reportedWorkDisposition": "yielded",
                "continuation": { "kind": "same_agent" },
            })
        )));
    }

    struct OversizedFrameProvider;

    struct SteeringProvider {
        calls: Arc<Mutex<Vec<(String, String)>>>,
        fail_next: Arc<Mutex<bool>>,
    }

    impl Provider for SteeringProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Codex
        }
        fn runtime_identity(&self) -> crate::codex_provider::ProviderRuntimeIdentity {
            crate::codex_provider::ProviderRuntimeIdentity::LocalProcess {
                process_id: 2,
                provider_session_id: "steering".to_owned(),
            }
        }
        fn session_identity(&self) -> &str {
            "steering-thread"
        }
        fn provider_session_id(&self) -> Option<&str> {
            Some("steering-session")
        }
        fn start_turn(
            &mut self,
            _message: &str,
            _cwd: &str,
            _turn_id: &str,
        ) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn steer_turn(&mut self, turn_id: &str, message: &str) -> Result<Value, LocalRunnerError> {
            let mut fail_next = self.fail_next.lock().unwrap();
            if *fail_next {
                *fail_next = false;
                return Err(LocalRunnerError::invalid("provider rejected steering"));
            }
            drop(fail_next);
            self.calls
                .lock()
                .unwrap()
                .push((turn_id.to_owned(), message.to_owned()));
            Ok(json!({"acknowledged": true}))
        }
        fn interrupt_turn(&mut self, _turn_id: &str) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn read(&mut self) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
            Ok(None)
        }
        fn deliver_tool_result(&mut self, _result: &ToolResult) -> Result<(), LocalRunnerError> {
            unreachable!()
        }
        fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
            Ok(())
        }
    }

    impl Provider for OversizedFrameProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Codex
        }
        fn runtime_identity(&self) -> crate::codex_provider::ProviderRuntimeIdentity {
            crate::codex_provider::ProviderRuntimeIdentity::LocalProcess {
                process_id: 1,
                provider_session_id: "oversized".to_owned(),
            }
        }
        fn session_identity(&self) -> &str {
            "test-thread"
        }
        fn provider_session_id(&self) -> Option<&str> {
            Some("test-session")
        }
        fn start_turn(
            &mut self,
            _message: &str,
            _cwd: &str,
            _turn_id: &str,
        ) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn interrupt_turn(&mut self, _turn_id: &str) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn read(&mut self) -> Result<Value, LocalRunnerError> {
            unreachable!()
        }
        fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
            Err(LocalRunnerError::invalid(
                "harness stdout frame exceeded 4194304 bytes",
            ))
        }
        fn deliver_tool_result(&mut self, _result: &ToolResult) -> Result<(), LocalRunnerError> {
            unreachable!()
        }
        fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
            Ok(())
        }
    }

    #[test]
    fn usage_counts_remain_observable_while_credential_tokens_are_redacted() {
        let sanitized = crate::durable::sanitize_value(&json!({
            "authorizationBoundary": "active_task",
            "tokenUsage": { "total": {
                "inputTokens": 12, "outputTokens": 3,
                "cacheReadTokens": 0, "cacheWriteTokens": 5
            } },
            "accessToken": "secret-value",
        }));
        assert_eq!(
            sanitized.pointer("/authorizationBoundary"),
            Some(&json!("active_task"))
        );
        assert_eq!(
            sanitized.pointer("/tokenUsage/total/inputTokens"),
            Some(&json!(12))
        );
        assert_eq!(
            sanitized.pointer("/tokenUsage/total/cacheReadTokens"),
            Some(&json!(0))
        );
        assert_eq!(
            sanitized.pointer("/tokenUsage/total/cacheWriteTokens"),
            Some(&json!(5))
        );
        assert_eq!(
            sanitized.pointer("/accessToken"),
            Some(&json!("[REDACTED]"))
        );
        assert_eq!(
            normalized_usage_measurement(&json!({
                "tokenUsage": { "total": {
                    "inputTokens": 12, "outputTokens": 3,
                    "cachedInputTokens": 7, "reasoningTokens": 2,
                    "costUsd": 0.004
                }}
            })),
            json!({
                "inputTokens": 12, "outputTokens": 3, "cacheReadTokens": 7,
                "cacheWriteTokens": 0, "reasoningTokens": 2,
                "activeSeconds": 0.0, "requests": 0,
                "providerCostUsd": 0.004
            })
        );
    }

    #[test]
    fn bearer_values_are_redacted_without_erasing_safe_failure_context() {
        let sanitized = crate::durable::redact_text(
            "MCP request failed: Authorization: Bearer secret-token, status 401 Unauthorized",
        );
        assert_eq!(
            sanitized,
            "MCP request failed: Authorization: Bearer [REDACTED], status 401 Unauthorized"
        );
        assert!(!sanitized.contains("secret-token"));
        assert_eq!(
            crate::durable::redact_text("Bearer first; retry used bearer second\nfailed"),
            "Bearer [REDACTED]; retry used bearer [REDACTED]\nfailed"
        );
    }

    #[test]
    fn durable_events_strip_binary_payloads_but_preserve_artifact_metadata() {
        let sanitized = crate::durable::sanitize_value(&json!({
            "item": {
                "id": "image-1",
                "artifactPath": "/tmp/frog.png",
                "imageUrl": format!("data:image/png;base64,{}", "A".repeat(1_200_000)),
            }
        }));
        assert_eq!(sanitized.pointer("/item/id"), Some(&json!("image-1")));
        assert_eq!(
            sanitized.pointer("/item/artifactPath"),
            Some(&json!("/tmp/frog.png"))
        );
        assert_eq!(
            sanitized.pointer("/item/imageUrl").and_then(Value::as_str),
            Some("[OMITTED data URL: 1200022 bytes]")
        );
        assert!(serde_json::to_vec(&sanitized).unwrap().len() < 1_024);
    }

    #[test]
    fn provider_failure_codes_are_stable() {
        assert_eq!(
            provider_failure_code("harness stdout frame exceeded 4194304 bytes"),
            "provider_frame_too_large"
        );
        assert_eq!(
            provider_failure_code("invalid JSON-RPC"),
            "provider_transport_failed"
        );
    }

    #[test]
    fn provider_semantic_result_is_durable_and_precedes_the_terminal() {
        let root = temporary_root("provider-semantic-result");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        state.completion_contract = Some(CompletionContractBinding {
            revision: "1".to_owned(),
            criterion_ids: vec!["objective".to_owned()],
        });
        let result = json!({
            "schema": "paperclip.run_result.v1",
            "reportedWorkDisposition": "done",
            "summary": "PAPERCLIP_E2E_OK_test",
            "completionClaim": {
                "contractRevision": "1",
                "objectiveSatisfied": true,
                "criteria": [{
                    "criterionId": "objective",
                    "status": "satisfied",
                    "evidenceRefs": []
                }],
                "remainingWork": []
            },
            "evidence": [],
            "verification": [],
            "attentionRequests": [],
            "artifacts": []
        });

        record_provider_semantic_result(
            &mut state,
            &runner_config,
            result.clone(),
            Some("finish-1"),
        )
        .unwrap();
        let terminal = enqueue_bound_result_event(
            &mut state,
            &runner_config,
            "turn.completed",
        )
        .unwrap()
        .unwrap();

        assert_eq!(state.semantic_result, Some(result.clone()));
        assert_eq!(state.last_agent_message.as_deref(), Some("PAPERCLIP_E2E_OK_test"));
        let proposed = state
            .outbox
            .iter()
            .filter(|event| event.event_type == "run.result.proposed")
            .collect::<Vec<_>>();
        assert_eq!(proposed.len(), 1);
        assert_eq!(proposed[0].item_id.as_deref(), Some("finish-1"));
        assert_eq!(
            proposed[0].envelope.pointer("/payload/payload"),
            Some(&result)
        );
        assert_eq!(terminal["turnTerminalState"], "completed");
        assert_eq!(terminal["runTerminalState"], "succeeded");
        assert_eq!(terminal["reportedWorkDisposition"], "done");

        record_provider_semantic_result(
            &mut state,
            &runner_config,
            json!({"reportedWorkDisposition": "blocked", "summary": "later"}),
            Some("finish-2"),
        )
        .unwrap();
        assert_eq!(state.semantic_result, Some(result));
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "run.result.proposed")
                .count(),
            1
        );
        assert!(state.outbox.iter().any(|event| {
            event.event_type == "harness.diagnostic"
                && event.envelope["payload"]["payload"]["code"]
                    == "duplicate_semantic_result_ignored"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn successful_completion_tool_result_commits_the_original_semantic_input() {
        let root = temporary_root("completion-tool-result");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        state
            .provider_tool_bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: "sha256:completion-tools".to_owned(),
                operations: vec![AuthorizedTool {
                    operation_id: "paperclip_finish".to_owned(),
                    version: 1,
                    description: "Finish the task.".to_owned(),
                    input_schema: json!({"type": "object"}),
                    response_schema: json!({"type": "object"}),
                }],
            })
            .unwrap();
        let semantic_input = json!({
            "schema": "paperclip.run_result.v1",
            "reportedWorkDisposition": "done",
            "summary": "finished",
            "completionClaim": {
                "contractRevision": "1",
                "objectiveSatisfied": true,
                "criteria": [],
                "remainingWork": []
            },
            "evidence": [],
            "verification": []
        });
        let canonical_semantic_input = json!({
            "schema": "paperclip.run_result.v1",
            "reportedWorkDisposition": "done",
            "summary": "finished",
            "completionClaim": {
                "contractRevision": "1",
                "objectiveSatisfied": true,
                "criteria": [],
                "remainingWork": []
            },
            "evidence": [],
            "verification": [],
            "attentionRequests": [],
            "artifacts": []
        });
        state
            .provider_tool_bridge
            .begin_call(
                "finish-1".to_owned(),
                "paperclip_finish".to_owned(),
                semantic_input.clone(),
            )
            .unwrap();
        let accepted = ToolResult {
            call_id: "finish-1".to_owned(),
            operation_id: "paperclip_finish".to_owned(),
            result: json!({"success": true}),
            is_error: false,
        };
        assert_eq!(
            successful_completion_tool_input(&state, &accepted),
            Some(canonical_semantic_input.clone())
        );
        assert_eq!(
            successful_completion_tool_input(
                &state,
                &ToolResult {
                    is_error: true,
                    ..accepted.clone()
                }
            ),
            None
        );
        assert_eq!(
            successful_completion_tool_input(
                &state,
                &ToolResult {
                    operation_id: "get_task_context".to_owned(),
                    ..accepted
                }
            ),
            None
        );
        state.completion_contract = Some(CompletionContractBinding {
            revision: "1".to_owned(),
            criterion_ids: Vec::new(),
        });
        state.active_turn = true;
        state.lifecycle = "active".to_owned();
        record_provider_semantic_result(
            &mut state,
            &runner_config,
            canonical_semantic_input,
            Some("finish-1"),
        )
        .unwrap();
        complete_turn_after_semantic_result(&mut state, &runner_config).unwrap();
        assert!(!state.active_turn);
        assert!(state.stop_after_flush);
        assert_eq!(state.lifecycle, "suspending");
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "run.result.proposed")
                .count(),
            1
        );
        assert!(state
            .outbox
            .iter()
            .any(|event| event.event_type == "turn.completed"));
        assert!(state
            .outbox
            .iter()
            .any(|event| event.event_type == "run.terminal"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn structured_input_revalidates_patterns_and_finite_numbers() {
        let request = |validation: Value| {
            json!({
                "schema": "paperclip.runtime_request.v2",
                "requestKind": "runtime",
                "requestId": "input-1",
                "type": "input",
                "status": "pending",
                "prompt": "Answer",
                "input": {
                    "schema": "paperclip.question_set.v1",
                    "questions": [{
                        "id": "value",
                        "prompt": "Value?",
                        "required": true,
                        "answerMode": "text",
                        "textValidation": validation
                    }]
                }
            })
        };
        let response = |value: &str| {
            json!({
                "action": "submit",
                "response": {
                    "schema": "paperclip.question_response.v1",
                    "answers": {"value": {"text": value}}
                }
            })
        };

        assert!(validate_runtime_request_resolution(
            &request(json!({"pattern": "^[A-Z]{2}$"})),
            &response("US"),
        )
        .is_ok());
        assert!(validate_runtime_request_resolution(
            &request(json!({"pattern": "^[A-Z]{2}$"})),
            &response("us"),
        )
        .is_err());
        assert!(validate_runtime_request_resolution(
            &request(json!({"inputType": "number"})),
            &response("NaN"),
        )
        .is_err());
    }

    #[test]
    fn warm_idle_clock_expires_only_safe_inactive_states() {
        let root = temporary_root("warm-idle-clock");
        let mut runner_config = config(&root);
        runner_config.lifecycle_mode = "warm".to_owned();
        runner_config.idle_timeout = Some(Duration::from_millis(300_000));
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        state.lifecycle_mode = "warm".to_owned();
        state.idle_timeout_ms = Some(300_000);
        state.last_activity_at_unix_ms = 1_000_000;

        for lifecycle in ["warm_idle", "waiting_input"] {
            state.lifecycle = lifecycle.to_owned();
            assert!(!should_suspend_for_idle_at(&state, 1_299_999).unwrap());
            assert!(should_suspend_for_idle_at(&state, 1_300_000).unwrap());
        }
        state.provider_config = Some(crate::codex_provider::ProviderConfig::Acpx(
            crate::codex_provider::AcpxProviderConfig {
                agent: "pi".to_owned(),
                model: "openrouter/deepseek/deepseek-v4-flash-0731".to_owned(),
                acpx_version: "0.13.1".to_owned(),
                agent_server_package: "pi-acp".to_owned(),
                agent_server_version: "0.0.33".to_owned(),
                agent_runtime_package: Some("@earendil-works/pi-coding-agent".to_owned()),
                agent_runtime_version: Some("0.84.2".to_owned()),
                command_digest: "sha256:qualified".to_owned(),
                sidecar_command: PathBuf::from("node"),
                sidecar_args: Vec::new(),
                runtime_directory: "/tmp/acpx".to_owned(),
                normalized_session_id: "session".to_owned(),
                run_id: "run".to_owned(),
                cwd: "/tmp/workspace".to_owned(),
                instructions: "safe".to_owned(),
                permission_mode: "approve-all".to_owned(),
                permission_mode_pinned: true,
                runtime_context: None,
            },
        ));
        state.lifecycle = "waiting_input".to_owned();
        assert!(!should_suspend_for_idle_at(&state, 86_400_000).unwrap());
        state.provider_config = None;
        for lifecycle in ["active", "ready", "suspending", "suspended"] {
            state.lifecycle = lifecycle.to_owned();
            assert!(!should_suspend_for_idle_at(&state, 2_000_000).unwrap());
        }
        state.lifecycle = "active".to_owned();
        state.stop_after_flush = true;
        assert!(!should_suspend_for_idle_at(&state, 2_000_000).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn acpx_process_loss_expires_pending_permission_without_replay() {
        let root = temporary_root("acpx-permission-loss");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        state.provider_config = Some(crate::codex_provider::ProviderConfig::Acpx(
            crate::codex_provider::AcpxProviderConfig {
                agent: "pi".to_owned(),
                model: "openrouter/deepseek/deepseek-v4-flash-0731".to_owned(),
                acpx_version: "0.13.1".to_owned(),
                agent_server_package: "pi-acp".to_owned(),
                agent_server_version: "0.0.33".to_owned(),
                agent_runtime_package: Some("@earendil-works/pi-coding-agent".to_owned()),
                agent_runtime_version: Some("0.84.2".to_owned()),
                command_digest: "sha256:qualified".to_owned(),
                sidecar_command: PathBuf::from("node"),
                sidecar_args: Vec::new(),
                runtime_directory: "/tmp/acpx".to_owned(),
                normalized_session_id: "session".to_owned(),
                run_id: "run".to_owned(),
                cwd: "/tmp/workspace".to_owned(),
                instructions: "safe".to_owned(),
                permission_mode: "approve-all".to_owned(),
                permission_mode_pinned: true,
                runtime_context: None,
            },
        ));
        state.active_turn = true;
        state.lifecycle = "waiting_input".to_owned();
        state.pending_provider_runtime_requests.insert(
            "permission-1".to_owned(),
            PendingProviderRuntimeRequest {
                request_id: "permission-1".to_owned(),
                turn_id: state.turn_id.clone(),
                request_kind: "file_approval".to_owned(),
                created_at_unix_ms: 1,
                request: Value::Null,
            },
        );

        expire_provider_runtime_requests_after_provider_loss(&mut state, &runner_config).unwrap();

        assert!(state.pending_provider_runtime_requests.is_empty());
        assert!(!state.active_turn);
        assert!(state.outbox.iter().any(|event| {
            event.envelope["payload"]["eventType"] == "runtime_request.expired"
                && event.envelope["payload"]["payload"]["replayAllowed"] == false
        }));
        assert!(state.outbox.iter().any(|event| {
            event.envelope["payload"]["eventType"] == "turn.failed"
                && event.envelope["payload"]["payload"]["error"]["code"]
                    == "acpx_permission_transport_lost"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn provider_loss_expires_a_canonical_input_once_with_the_complete_question_set() {
        let root = temporary_root("canonical-input-loss");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        let request = json!({
            "schema": "paperclip.runtime_request.v2",
            "requestKind": "runtime",
            "requestId": "input-1",
            "type": "input",
            "status": "pending",
            "prompt": "Which target?",
            "input": {
                "schema": "paperclip.question_set.v1",
                "questions": [{
                    "id": "target",
                    "prompt": "Which target?",
                    "required": true,
                    "answerMode": "single_select",
                    "options": [{"id": "staging", "label": "Staging"}]
                }]
            },
            "origin": {"adapter": "codex-app-server"}
        });
        state.pending_provider_runtime_requests.insert(
            "input-1".to_owned(),
            PendingProviderRuntimeRequest {
                request_id: "input-1".to_owned(),
                turn_id: state.turn_id.clone(),
                request_kind: "runtime".to_owned(),
                created_at_unix_ms: 1,
                request: request.clone(),
            },
        );

        expire_provider_runtime_requests_after_provider_loss(&mut state, &runner_config).unwrap();
        expire_provider_runtime_requests_after_provider_loss(&mut state, &runner_config).unwrap();

        let expirations = state
            .outbox
            .iter()
            .filter(|event| event.envelope["payload"]["eventType"] == "runtime_request.expired")
            .collect::<Vec<_>>();
        assert_eq!(expirations.len(), 1);
        assert_eq!(
            expirations[0].envelope["payload"]["payload"]["request"],
            request
        );
        assert_eq!(
            expirations[0].envelope["payload"]["payload"]["reason"],
            "provider_process_lost"
        );
        assert_eq!(
            expirations[0].envelope["payload"]["payload"]["replayAllowed"],
            false
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_provider_frame_persists_a_recoverable_failure() {
        let root = temporary_root("oversized-provider-frame");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&runner_config).unwrap();
        let mut provider: Option<Box<dyn Provider>> = Some(Box::new(OversizedFrameProvider));

        let error = poll_provider(&mut provider, &mut state, &store, &runner_config).unwrap_err();
        assert!(error
            .to_string()
            .contains("stdout frame exceeded 4194304 bytes"));
        let (restored, recovered) = store.load_or_create(&runner_config).unwrap();
        assert!(recovered);
        assert_eq!(restored.lifecycle, "recoverable_failure");
        assert_eq!(
            restored.recoverable_failure.as_deref(),
            Some("provider_frame_too_large")
        );
        assert!(restored
            .diagnostics
            .iter()
            .any(|entry| entry.contains("provider_frame_too_large")));
        let _ = fs::remove_dir_all(root);
    }

    fn config(root: &Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:1/durable_runner/connect".to_owned(),
            ca_bundle_path: None,
            state_dir: root.to_path_buf(),
            runner_instance_id: "runner_durable_runner_stable".to_owned(),
            environment_lease_id: "lease_durable_runner_stable".to_owned(),
            run_id: "run_durable_runner_stable".to_owned(),
            normalized_session_id: "session_durable_runner_stable".to_owned(),
            turn_id: "turn_durable_runner_stable".to_owned(),
            item_id: "item_durable_runner_stable".to_owned(),
            runner_version: "0.3.0".to_owned(),
            runner_digest: "sha256:durable_runner-approved".to_owned(),
            fake_harness_path: None,
            fake_harness_script_path: None,
            max_outbox_bytes: 16 * 1024,
            p0_reserve_bytes: 8 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_millis(10),
            lifecycle_mode: "per_turn".to_owned(),
            idle_timeout: None,
        }
    }

    #[test]
    fn legacy_codex_provider_fields_deserialize_as_codex() {
        let root = temporary_root("legacy-provider-state");
        let runner_config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (state, _) = store.load_or_create(&runner_config).unwrap();
        let mut value = serde_json::to_value(state).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("providerConfig");
        object.remove("providerSessionId");
        object.insert(
            "codexProviderConfig".to_owned(),
            json!({
                "command": "codex", "args": ["app-server"], "cwd": "/tmp",
                "model": null, "instructions": "legacy"
            }),
        );
        object.insert("codexProviderThreadId".to_owned(), json!("thread-legacy"));
        let restored: DurableRunnerState = serde_json::from_value(value).unwrap();
        assert_eq!(
            restored.provider_config.unwrap().kind(),
            crate::codex_provider::ProviderKind::Codex
        );
        assert_eq!(
            restored.provider_session_id.as_deref(),
            Some("thread-legacy")
        );
        let _ = fs::remove_dir_all(root);
    }

    fn temporary_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperclip-runner-durable_runner-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Value {
        json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": id,
            "controllerSeq": sequence,
            "type": command_type,
            "issuedAt": deterministic_time(sequence),
            "payload": payload,
        })
    }

    fn read_masked_client_text(stream: &mut TcpStream) -> (Value, Vec<u8>) {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header[0] & 0x0f, 0x1);
        assert_ne!(header[1] & 0x80, 0);
        let mut captured = header.to_vec();
        let mut length = usize::from(header[1] & 0x7f);
        if length == 126 {
            let mut extended = [0_u8; 2];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0_u8; 8];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::try_from(u64::from_be_bytes(extended)).unwrap();
        }
        let mut mask = [0_u8; 4];
        stream.read_exact(&mut mask).unwrap();
        captured.extend_from_slice(&mask);
        let mut payload = vec![0_u8; length];
        stream.read_exact(&mut payload).unwrap();
        captured.extend_from_slice(&payload);
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % mask.len()];
        }
        (serde_json::from_slice(&payload).unwrap(), captured)
    }

    fn send_server_json(stream: &mut TcpStream, value: &Value) {
        let payload = serde_json::to_vec(value).unwrap();
        let mut frame = vec![0x81];
        if payload.len() <= 125 {
            frame.push(payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(&payload);
        stream.write_all(&frame).unwrap();
        stream.flush().unwrap();
    }

    #[test]
    fn durable_state_restores_identity_outbox_and_cumulative_ack() {
        let root = temporary_root("restore");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, recovered) = store.load_or_create(&config).unwrap();
        assert!(!recovered);
        let session_id = state.normalized_session_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "session.started",
            0,
            json!({ "session": session_id }),
            None,
        )
        .unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        let first_event_id = state.outbox[0].source_event_id.clone();
        store.save(&state).unwrap();

        let (mut restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(restored.runner_instance_id, config.runner_instance_id);
        assert_eq!(restored.normalized_session_id, config.normalized_session_id);
        assert_eq!(restored.outbox[0].source_event_id, first_event_id);
        restored.apply_ack(1).unwrap();
        assert_eq!(restored.acked_source_seq, 1);
        assert_eq!(restored.outbox.len(), 1);
        assert!(restored.apply_ack(0).is_err());
        assert!(restored.apply_ack(3).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_command_has_one_logical_effect_and_no_new_events() {
        let root = temporary_root("command-dedupe");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command("command_prepare", 1, "run.prepare", json!({}));
        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert!(first.command_digest.starts_with("sha256:"));
        assert_eq!(first.command_digest.len(), "sha256:".len() + 64);
        let event_count = state.outbox.len();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.result, second.result);
        assert_eq!(first.logical_effect_count, 1);
        assert_eq!(state.outbox.len(), event_count);
        assert_eq!(state.processed_commands.len(), 1);
        assert!(process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_prepare",
                1,
                "run.prepare",
                json!({ "changed": true })
            )
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn steering_is_bound_to_the_active_turn_and_duplicate_commands_do_not_redispatch() {
        let root = temporary_root("steering-command-dedupe");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.active_turn = true;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_next = Arc::new(Mutex::new(false));
        let mut provider: Option<Box<dyn Provider>> = Some(Box::new(SteeringProvider {
            calls: calls.clone(),
            fail_next,
        }));
        let steering = command(
            "command-steer-1",
            1,
            "turn.steer",
            json!({ "turnId": config.turn_id, "text": "Prioritize mobile overflow." }),
        );

        let first =
            process_command_and_provider(&mut state, &store, &config, &mut provider, &steering)
                .unwrap();
        let event_count = state.outbox.len();
        let duplicate =
            process_command_and_provider(&mut state, &store, &config, &mut provider, &steering)
                .unwrap();

        assert_eq!(first.status, "completed");
        assert_eq!(duplicate.result, first.result);
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(
                config.turn_id.clone(),
                "Prioritize mobile overflow.".to_owned()
            ),]
        );
        assert_eq!(state.outbox.len(), event_count);
        assert!(state.outbox.iter().any(|event| {
            event.envelope["payload"]["eventType"] == "item.completed"
                && event.envelope["payload"]["payload"]["kind"] == "steering_acknowledgement"
                && event.envelope["payload"]["payload"]["commandId"] == "command-steer-1"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejected_steering_rolls_back_the_dedupe_ledger_for_retry() {
        let root = temporary_root("steering-command-retry");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state.active_turn = true;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_next = Arc::new(Mutex::new(true));
        let mut provider: Option<Box<dyn Provider>> = Some(Box::new(SteeringProvider {
            calls: calls.clone(),
            fail_next,
        }));
        let steering = command(
            "command-steer-retry",
            1,
            "turn.steer",
            json!({ "turnId": config.turn_id, "text": "Retry me." }),
        );

        let first_error =
            process_command_and_provider(&mut state, &store, &config, &mut provider, &steering)
                .unwrap_err();
        assert!(first_error
            .to_string()
            .contains("provider rejected steering"));
        assert!(!state.processed_commands.contains_key("command-steer-retry"));
        assert_eq!(state.last_controller_command_seq, 0);

        let retry =
            process_command_and_provider(&mut state, &store, &config, &mut provider, &steering)
                .unwrap();
        assert_eq!(retry.status, "completed");
        assert_eq!(calls.lock().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn provider_bootstrap_failure_returns_a_failed_prepare_result() {
        let root = temporary_root("provider-bootstrap-failure");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command(
            "command_prepare_missing_provider",
            1,
            "run.prepare",
            json!({
                "provider": {
                    "kind": "codex",
                    "command": root.join("definitely-not-a-provider"),
                    "args": [],
                    "cwd": root,
                    "model": null,
                    "instructions": "test"
                }
            }),
        );
        let processed =
            process_command_and_provider(&mut state, &store, &config, &mut None, &value).unwrap();
        assert_eq!(processed.status, "failed");
        assert_eq!(processed.logical_effect_count, 0);
        assert!(processed.result["detail"]
            .as_str()
            .unwrap()
            .contains("failed to start local provider"));
        assert_eq!(state.lifecycle, "recoverable_failure");
        assert_eq!(state.last_controller_command_seq, 1);
        assert!(state.outbox.is_empty());
        let replay =
            process_command_and_provider(&mut state, &store, &config, &mut None, &value).unwrap();
        assert_eq!(replay.status, "failed");
        let open_after_failure = process_command_and_provider(
            &mut state,
            &store,
            &config,
            &mut None,
            &command(
                "command_open_after_failed_prepare",
                2,
                "session.open",
                json!({}),
            ),
        )
        .unwrap();
        assert_eq!(open_after_failure.status, "rejected");
        assert!(open_after_failure.result["detail"]
            .as_str()
            .unwrap()
            .contains("provider bootstrap failed"));
        assert!(state.outbox.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn processed_command_ledger_compacts_to_a_fixed_bound_without_reenabling_effects() {
        let root = temporary_root("command-compaction");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        for sequence in 1..=256_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_256 = fs::metadata(store.path()).unwrap().len();
        for sequence in 257..=512_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_512 = fs::metadata(store.path()).unwrap().len();
        assert_eq!(
            state.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        assert_eq!(state.compacted_command_count, 384);
        assert_eq!(
            state.compacted_command_filter.len(),
            COMPACTED_COMMAND_FILTER_BYTES * 2
        );
        assert!(size_after_512 <= size_after_256 + 1024);

        let replay = process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_compaction_0001",
                513,
                "run.prepare",
                json!({ "changed": true }),
            ),
        )
        .unwrap();
        assert_eq!(replay.status, "rejected");
        assert_eq!(replay.logical_effect_count, 0);
        assert_eq!(state.last_controller_command_seq, 513);
        assert!(!state
            .outbox
            .iter()
            .any(|event| event.event_type == "workspace.ready"));
        let (restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(
            restored.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malicious_loopback_listener_gets_no_capability_and_cannot_forge_control() {
        let root = temporary_root("malicious-loopback");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (state, _) = store.load_or_create(&config).unwrap();
        let secret = "bootstrap-malicious-listener-regression";
        let credential = CredentialMaterial::from_token(secret);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (wire_sender, wire_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
                )
                .unwrap();
            stream.flush().unwrap();
            let (hello, frame) = read_masked_client_text(&mut stream);
            let hello_payload = hello.get("payload").unwrap();
            let challenge_payload = json!({
                "credentialId": hello_payload.get("credentialId").unwrap(),
                "credentialKind": "bootstrap",
                "clientNonce": hello_payload.get("clientNonce").unwrap(),
                "serverNonce": "malicious-server-nonce",
                "runnerInstanceId": hello_payload.get("runnerInstanceId").unwrap(),
                "environmentLeaseId": hello_payload.get("environmentLeaseId").unwrap(),
                "runId": hello_payload.get("runId").unwrap(),
                "normalizedSessionId": hello_payload.get("normalizedSessionId").unwrap(),
                "turnId": hello_payload.get("turnId").unwrap(),
                "itemId": hello_payload.get("itemId").unwrap(),
                "runnerVersion": hello_payload.get("runnerVersion").unwrap(),
                "runnerDigest": hello_payload.get("runnerDigest").unwrap(),
                "selectedVersion": PROTOCOL_VERSION,
                "credentialLeaseId": Value::Null,
                "credentialExpiresAt": "2099-01-01T00:00:00.000Z",
                "credentialExpiresAtUnixMs": 4_070_908_800_000_u64,
                "revocationEpoch": 0,
                "serverProof": "00".repeat(32),
            });
            send_server_json(
                &mut stream,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": challenge_payload,
                }),
            );
            request.extend_from_slice(&frame);
            wire_sender.send(request).unwrap();
        });
        let target = resolve_ws_target_with(
            &format!("ws://{address}/durable_runner/connect"),
            |_host, _port| Ok(vec![address]),
        )
        .unwrap();
        let mut client = WsClient::connect(&target, config.max_frame_bytes, None).unwrap();
        let error = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            "bootstrap",
            None,
            None,
            None,
        )
        .err()
        .unwrap();
        assert!(error
            .to_string()
            .contains("transport authentication proof is invalid"));
        assert!(client.secure_channel.is_none());
        let wire = wire_receiver.recv().unwrap();
        assert!(!wire
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
        assert_eq!(state.acked_source_seq, 0);
        assert!(state.processed_commands.is_empty());
        server.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_terminal_command_failure_restores_exact_prior_state_on_every_retry() {
        let root = temporary_root("command-atomic-p1");
        let mut config = config(&root);
        let sizing_state = DurableRunnerState::new(&config);
        let accepted_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            1,
            "turn.accepted",
            0,
            json!({ "turnId": sizing_state.turn_id, "sameSession": true }),
            None,
        ))
        .unwrap()
        .len();
        let started_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            2,
            "item.started",
            1,
            json!({ "kind": "assistant_message" }),
            Some(&sizing_state.item_id),
        ))
        .unwrap()
        .len();
        let non_p0_limit = accepted_size + started_size - 1;
        config.p0_reserve_bytes = 8 * 1024;
        config.max_outbox_bytes = non_p0_limit + config.p0_reserve_bytes;

        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let before_state = serde_json::to_vec(&state).unwrap();
        let before_file = fs::read(store.path()).unwrap();
        let value = command("command_tight_p1", 1, "turn.start", json!({}));

        let first_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        let second_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(second_error, first_error);
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        assert!(state.outbox.is_empty());
        assert!(state.processed_commands.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn p0_exhaustion_commits_only_unrecoverable_result_and_retry_is_stable() {
        let root = temporary_root("command-atomic-p0");
        let mut probe_config = config(&root);
        probe_config.max_outbox_bytes = 128 * 1024;
        probe_config.p0_reserve_bytes = 1;
        let mut probe = DurableRunnerState::new(&probe_config);
        execute_command_effect(
            &mut probe,
            &probe_config,
            "turn.start",
            &json!({ "text": "Durable runner" }),
        )
        .unwrap();
        assert!(probe.outbox.len() >= 5);
        let bytes_before_mandatory_p0 = probe
            .outbox
            .iter()
            .take(4)
            .map(|event| event.byte_size)
            .sum::<usize>();

        let mut config = config(&root);
        config.p0_reserve_bytes = 1;
        config.max_outbox_bytes = bytes_before_mandatory_p0 + 1;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command(
            "command_tight_p0",
            1,
            "turn.start",
            json!({ "text": "Durable runner" }),
        );

        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.status, "failed");
        assert_eq!(first.logical_effect_count, 0);
        assert_eq!(state.lifecycle, "unrecoverable");
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.next_source_seq, 1);
        assert!(state.outbox.is_empty());
        assert_eq!(state.processed_commands.len(), 1);
        let after_first = serde_json::to_vec(&state).unwrap();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(second.result, first.result);
        assert_eq!(serde_json::to_vec(&state).unwrap(), after_first);
        let (persisted, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert!(persisted.outbox.is_empty());
        assert_eq!(persisted.next_source_seq, 1);
        assert_eq!(persisted.processed_commands.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pressure_coalesces_p2_preserves_p0_and_stays_bounded() {
        let root = temporary_root("pressure");
        let mut config = config(&root);
        config.max_outbox_bytes = 12 * 1024;
        config.p0_reserve_bytes = 6 * 1024;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_pressure", 1, "fault.storage_pressure", json!({})),
        )
        .unwrap();
        assert!(state.backpressure);
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "item.delta")
                .count(),
            1
        );
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        let persisted = fs::read_to_string(store.path()).unwrap();
        assert!(!persisted.contains("must-not-persist"));
        assert!(persisted.contains("[REDACTED]"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn coalesced_p2_preserves_every_ordered_provider_notification() {
        let root = temporary_root("ordered-p2-coalesce");
        let config = config(&root);
        let mut state = DurableRunnerState::new(&config);
        let item_id = state.item_id.clone();
        for payload in [
            json!({ "method": "item/started", "params": { "item": { "id": "reasoning-1" } } }),
            json!({ "method": "item/reasoning/summaryTextDelta", "params": { "delta": "Inspecting" } }),
            json!({ "method": "item/completed", "params": { "item": { "id": "reasoning-1" } } }),
        ] {
            enqueue_event(
                &mut state,
                &config,
                "provider.event",
                2,
                payload,
                Some(&item_id),
            )
            .unwrap();
        }

        assert_eq!(state.outbox.len(), 1);
        let payload = state.outbox[0]
            .envelope
            .pointer("/payload/payload")
            .unwrap();
        assert_eq!(payload["coalescedCount"], json!(3));
        assert_eq!(
            payload["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "item/started",
                "item/reasoning/summaryTextDelta",
                "item/completed",
            ],
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_coalesced_p2_retains_prior_event_and_never_exceeds_bounds() {
        let root = temporary_root("oversized-p2-coalesce");
        let mut config = config(&root);
        config.max_outbox_bytes = 8 * 1024;
        config.p0_reserve_bytes = 4 * 1024;
        let mut state = DurableRunnerState::new(&config);
        let item_id = state.item_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "small durable delta" }),
            Some(&item_id),
        )
        .unwrap();
        let prior = state.outbox[0].clone();

        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "x".repeat(16 * 1024) }),
            Some(&item_id),
        )
        .unwrap();

        let retained = state
            .outbox
            .iter()
            .find(|event| event.event_type == "item.delta")
            .unwrap();
        assert_eq!(retained, &prior);
        assert!(state.backpressure);
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert!(state.peak_outbox_bytes <= config.max_outbox_bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drain_rejects_new_turn_and_revoke_preserves_unacked_events() {
        let root = temporary_root("drain");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_drain", 1, "runner.drain", json!({})),
        )
        .unwrap();
        let before = state.outbox.len();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_turn", 2, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox.len(), before);
        state.lifecycle = "revoked".to_owned();
        store.save(&state).unwrap();
        let (restored, _) = store.load_or_create(&config).unwrap();
        assert_eq!(restored.lifecycle, "revoked");
        assert_eq!(restored.outbox.len(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_p0_records_an_explicit_unrecoverable_outcome() {
        let root = temporary_root("unrecoverable");
        let mut config = config(&root);
        config.max_outbox_bytes = 512;
        config.p0_reserve_bytes = 256;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let result = enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "evidence": "x".repeat(4_096) }),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.lifecycle, "unrecoverable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_validation_rejects_public_private_wildcard_and_mixed_answers() {
        for (label, url, addresses) in [
            (
                "public",
                "ws://8.8.8.8:443/durable_runner/connect",
                vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()],
            ),
            (
                "private",
                "ws://10.1.2.3:3100/durable_runner/connect",
                vec!["10.1.2.3:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "wildcard",
                "ws://0.0.0.0:3100/durable_runner/connect",
                vec!["0.0.0.0:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "mixed-answer",
                "ws://mixed.test:3100/durable_runner/connect",
                vec![
                    "127.0.0.1:3100".parse::<SocketAddr>().unwrap(),
                    "192.0.2.9:3100".parse::<SocketAddr>().unwrap(),
                ],
            ),
        ] {
            let result = resolve_ws_target_with(url, |_host, _port| Ok(addresses));
            assert!(result.is_err(), "{label} destination must fail closed");
        }
    }

    #[test]
    fn destination_validation_rejects_malformed_userinfo_query_and_fragment_before_resolution() {
        for url in [
            "WS://127.0.0.1:3100/durable_runner/connect",
            "ws://127.0.0.1:0/durable_runner/connect",
            "ws://[::1:3100/durable_runner/connect",
            "ws://user@127.0.0.1:3100/durable_runner/connect",
            "ws://127.0.0.1:3100/durable_runner/connect?ticket=ambiguous",
            "ws://127.0.0.1:3100/durable_runner/connect#fragment",
            "ws://127.0.0.1:3100/durable_runner\\connect",
        ] {
            let mut resolution_attempted = false;
            let result = resolve_ws_target_with(url, |_host, _port| {
                resolution_attempted = true;
                Ok(vec!["127.0.0.1:3100".parse().unwrap()])
            });
            assert!(result.is_err(), "ambiguous URL must be rejected: {url}");
            assert!(
                !resolution_attempted,
                "malformed URL reached destination resolution: {url}"
            );
        }
    }

    #[test]
    fn destination_validation_allows_verified_wss_remote_addresses_and_default_ports() {
        let target = resolve_ws_target_with(
            "wss://paperclip.example.test/api/runner/v1/connect/run",
            |host, port| {
                assert_eq!(host, "paperclip.example.test");
                assert_eq!(port, 443);
                Ok(vec!["192.0.2.10:443".parse().unwrap()])
            },
        )
        .unwrap();
        assert!(target.secure);
        assert_eq!(target.host, "paperclip.example.test");

        let loopback =
            resolve_ws_target_with("ws://127.0.0.1/api/runner/v1/connect/run", |_host, port| {
                assert_eq!(port, 80);
                Ok(vec!["127.0.0.1:80".parse().unwrap()])
            })
            .unwrap();
        assert!(!loopback.secure);
    }

    #[test]
    fn destination_validation_accepts_only_concrete_loopback_answers() {
        let target = resolve_ws_target_with(
            "ws://localhost:3100/durable_runner/connect",
            |_host, _port| {
                Ok(vec![
                    "127.42.0.9:3100".parse().unwrap(),
                    "[::1]:3100".parse().unwrap(),
                ])
            },
        )
        .unwrap();
        assert_eq!(target.addresses.len(), 2);
        assert!(target
            .addresses
            .iter()
            .all(|address| address.ip().is_loopback()));
    }

    #[test]
    fn oversized_outbound_websocket_frame_is_rejected_before_write() {
        let error = encode_frame(0x1, b"ninebytes", Some([0; 4]), 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("outbound WebSocket frame exceeds"));
    }

    #[test]
    fn oversized_inbound_websocket_frame_is_rejected_before_allocation() {
        let error = checked_inbound_frame_length(9, 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("inbound WebSocket frame exceeds"));
    }

    fn listener_client(request: &str) -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.write_all(request.as_bytes()).unwrap();
        client.flush().unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn runner_listener_accepts_only_the_exact_websocket_path_without_compression() {
        let (mut wrong_path_client, wrong_path_server) = listener_client(
            "GET /unrelated HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        let error = WsClient::accept(wrong_path_server, "/api/runner/v1/connect/run-1", 1024)
            .err()
            .unwrap();
        assert!(error.to_string().contains("unrelated HTTP path"));
        let response = read_http_headers(&mut wrong_path_client, "test response").unwrap();
        assert!(response.starts_with("HTTP/1.1 404 "));

        let (_compression_client, compression_server) = listener_client(
            "GET /api/runner/v1/connect/run-1 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
        );
        let error = WsClient::accept(compression_server, "/api/runner/v1/connect/run-1", 1024)
            .err()
            .unwrap();
        assert!(error
            .to_string()
            .contains("does not support WebSocket compression"));
    }

    #[test]
    fn runner_listener_requires_masked_client_frames_and_enforces_control_limits() {
        let (mut client, server) = listener_client(
            "GET /api/runner/v1/connect/run-1 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        let mut accepted = WsClient::accept(server, "/api/runner/v1/connect/run-1", 1024).unwrap();
        let response = read_http_headers(&mut client, "test response").unwrap();
        assert!(response.starts_with("HTTP/1.1 101 "));
        client
            .write_all(&encode_frame(0x1, b"{}", None, 1024).unwrap())
            .unwrap();
        let error = accepted.receive_plain_json().unwrap_err();
        assert!(error.to_string().contains("masking direction is invalid"));

        let (mut control_client, control_server) = listener_client(
            "GET /api/runner/v1/connect/run-1 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        let mut accepted =
            WsClient::accept(control_server, "/api/runner/v1/connect/run-1", 1024).unwrap();
        let _ = read_http_headers(&mut control_client, "test response").unwrap();
        control_client.write_all(&[0x89, 0xFE, 0, 126]).unwrap();
        let error = accepted.receive_plain_json().unwrap_err();
        assert!(error
            .to_string()
            .contains("control frame exceeds 125 bytes"));
    }

    #[test]
    fn runner_listener_preserves_a_partially_received_frame_across_poll_timeouts() {
        let (mut client, server) = listener_client(
            "GET /api/runner/v1/connect/run-1 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        let mut accepted = WsClient::accept(server, "/api/runner/v1/connect/run-1", 1024).unwrap();
        let _ = read_http_headers(&mut client, "test response").unwrap();
        let frame =
            encode_frame(0x1, br#"{"crosses":"timeout"}"#, Some([1, 2, 3, 4]), 1024).unwrap();
        let split = frame.len() - 4;
        let writer = thread::spawn(move || {
            client.write_all(&frame[..split]).unwrap();
            thread::sleep(Duration::from_millis(400));
            client.write_all(&frame[split..]).unwrap();
        });
        let value = accepted.receive_plain_json().unwrap().unwrap();
        writer.join().unwrap();
        assert_eq!(value, json!({ "crosses": "timeout" }));
    }

    #[test]
    fn revoked_runner_rejects_turn_with_zero_effects_and_preserves_existing_outbox() {
        let root = temporary_root("revoked-command");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        state.lifecycle = "revoked".to_owned();
        let before = state.outbox.clone();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_after_revoke", 1, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox, before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_state_write_ignores_preplanted_predictable_symlink_and_uses_private_modes() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-symlink");
        let victim = root.join("victim.txt");
        fs::write(&victim, "unchanged").unwrap();
        let planted = root.join("runner-state.json.next");
        symlink(&victim, &planted).unwrap();
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        store.save(&DurableRunnerState::new(&config)).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "unchanged");
        assert!(fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(store.path()).unwrap().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn durable_state_load_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-load-symlink");
        let config = config(&root);
        let victim = root.join("victim.json");
        fs::write(
            &victim,
            serde_json::to_vec(&DurableRunnerState::new(&config)).unwrap(),
        )
        .unwrap();
        symlink(&victim, root.join("runner-state.json")).unwrap();
        let store = DurableStateStore::new(&root).unwrap();
        assert!(store.load_or_create(&config).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn captured_bootstrap_is_removed_and_absent_from_a_real_child_environment() {
        let _guard = ENVIRONMENT_TEST_LOCK.lock().unwrap();
        let secret = format!("bootstrap-environment-regression-{}", std::process::id());
        std::env::set_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", &secret);
        let ticket = capture_bootstrap_ticket().unwrap().unwrap();
        assert!(std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET").is_none());

        let mut child = SupervisedProcess::spawn(
            Path::new("/usr/bin/env"),
            &[],
            Duration::from_millis(50),
            16 * 1024,
        )
        .unwrap();
        let mut environment = Vec::new();
        while let Some(line) = child
            .receive_stdout_line(Duration::from_millis(250))
            .unwrap()
        {
            environment.push(line);
        }
        let exit = child.wait().unwrap();
        assert!(exit.success);
        let dump = environment.join("\n");
        assert!(!dump.contains("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"));
        assert!(!dump.contains(&secret));
        drop(ticket);
    }
}
