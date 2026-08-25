use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::Duration;

use paperclip_runner_core::durable::{
    capture_bootstrap_ticket, run_durable_runner, BootstrapTicket, DurableRunnerConfig,
};
use paperclip_runner_core::local_runner::{run_local_runner, LocalRunnerError, RunnerConfig};
use serde_json::json;

const RUNNERD_BUILD_METADATA_SCHEMA: &str = "paperclip-runner/runnerd-build-metadata/v1";

fn build_metadata() -> serde_json::Value {
    json!({
        "schema": RUNNERD_BUILD_METADATA_SCHEMA,
        "binaryName": "paperclip-runnerd",
        "packageName": "@paperclipai/paperclip-runner",
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "binaryContractVersion": 1,
        "nativeExecutionVersion": 1,
        "harnessDriverVersion": 1,
        "prp": {
            "name": "paperclip.runner",
            "minimumVersion": 1,
            "maximumVersion": 1
        },
        "prpTransportModes": ["dial_ws_loopback", "dial_wss", "listen_ws"]
    })
}

fn value(args: &[String], name: &str) -> Result<String, LocalRunnerError> {
    let index = args
        .iter()
        .position(|argument| argument == name)
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing required argument {name}")))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))
}

fn optional_u64(args: &[String], name: &str) -> Result<Option<u64>, LocalRunnerError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    let value = args
        .get(index + 1)
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))?;
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| LocalRunnerError::invalid(format!("invalid {name}: {error}")))
}

fn usize_value(args: &[String], name: &str, default: usize) -> Result<usize, LocalRunnerError> {
    optional_u64(args, name)?.map_or(Ok(default), |value| {
        usize::try_from(value)
            .map_err(|error| LocalRunnerError::invalid(format!("invalid {name}: {error}")))
    })
}

fn duration_value(args: &[String], name: &str, default: u64) -> Result<Duration, LocalRunnerError> {
    Ok(Duration::from_millis(
        optional_u64(args, name)?.unwrap_or(default),
    ))
}

fn optional_duration_value(
    args: &[String],
    name: &str,
) -> Result<Option<Duration>, LocalRunnerError> {
    Ok(optional_u64(args, name)?.map(Duration::from_millis))
}

fn repeated_values(args: &[String], name: &str) -> Result<Vec<String>, LocalRunnerError> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            let value = args
                .get(index + 1)
                .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))?;
            values.push(value.clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(values)
}

/// Native runner keeps runnerd as the package-local process owner while the existing
/// Codex app-server remains the provider protocol implementation. Stdio stays
/// byte-for-byte JSON-RPC; runnerd writes process evidence only to stderr.
fn run_codex_app_server_proxy(args: &[String]) -> Result<(), LocalRunnerError> {
    let command_name = value(args, "--codex-command")?;
    let codex_args = repeated_values(args, "--codex-arg")?;
    let mut command = Command::new(&command_name);
    command
        .args(&codex_args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for key in [
        "ALL_PROXY",
        "CODEX_HOME",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "LANG",
        "LC_ALL",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "PATH",
        "PATHEXT",
        "SSL_CERT_FILE",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TMPDIR",
        "WINDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        LocalRunnerError::invalid(format!("failed to start Codex app-server: {error}"))
    })?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| LocalRunnerError::invalid("failed to capture Codex app-server stdin"))?;
    let mut child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| LocalRunnerError::invalid("failed to capture Codex app-server stdout"))?;
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut line = Vec::new();
        while stdin.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            if child_stdin.write_all(&line).is_err() || child_stdin.flush().is_err() {
                break;
            }
            line.clear();
        }
    });
    let stdout_relay = thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        let mut child_stdout = BufReader::new(&mut child_stdout);
        let mut line = Vec::new();
        let mut relayed = 0;
        loop {
            let bytes = child_stdout.read_until(b'\n', &mut line)?;
            if bytes == 0 {
                return Ok::<u64, io::Error>(relayed);
            }
            stdout.write_all(&line)?;
            stdout.flush()?;
            relayed += bytes as u64;
            line.clear();
        }
    });
    eprintln!(
        "paperclip-runnerd: native codex proxy started runner_pid={} codex_pid={}",
        std::process::id(),
        child.id()
    );
    let status = child.wait().map_err(|error| {
        LocalRunnerError::invalid(format!("failed to wait for Codex app-server: {error}"))
    })?;
    stdout_relay
        .join()
        .map_err(|_| LocalRunnerError::invalid("Codex app-server stdout relay panicked"))?
        .map_err(|error| {
            LocalRunnerError::invalid(format!("Codex app-server stdout relay failed: {error}"))
        })?;
    eprintln!(
        "paperclip-runnerd: native codex proxy exited success={} code={}",
        status.success(),
        status
            .code()
            .map_or_else(|| "signal".to_owned(), |code| code.to_string())
    );
    if status.success() {
        Ok(())
    } else {
        Err(LocalRunnerError::invalid(
            "Codex app-server exited unsuccessfully",
        ))
    }
}

fn run_durable_mode(
    args: &[String],
    bootstrap_ticket: Option<BootstrapTicket>,
) -> Result<(), LocalRunnerError> {
    let lifecycle_mode = args
        .iter()
        .position(|argument| argument == "--lifecycle-mode")
        .map(|index| {
            args.get(index + 1)
                .cloned()
                .ok_or_else(|| LocalRunnerError::invalid("missing value for --lifecycle-mode"))
        })
        .transpose()?
        .unwrap_or_else(|| "per_turn".to_owned());
    if lifecycle_mode != "per_turn" && lifecycle_mode != "warm" {
        return Err(LocalRunnerError::invalid(
            "--lifecycle-mode must be per_turn or warm",
        ));
    }
    let idle_timeout = optional_duration_value(args, "--idle-timeout-ms")?;
    if lifecycle_mode == "warm" && idle_timeout.is_none() {
        return Err(LocalRunnerError::invalid(
            "warm lifecycle requires --idle-timeout-ms",
        ));
    }
    if lifecycle_mode == "per_turn" && idle_timeout.is_some() {
        return Err(LocalRunnerError::invalid(
            "per_turn lifecycle does not accept --idle-timeout-ms",
        ));
    }
    let max_runtime = optional_duration_value(args, "--max-lifetime-ms")?
        .or(optional_duration_value(args, "--max-runtime-ms")?)
        .unwrap_or(Duration::MAX);
    let connect_url = match (
        args.iter().any(|argument| argument == "--connect-url"),
        args.iter().any(|argument| argument == "--listen-address")
            || args.iter().any(|argument| argument == "--listen-port")
            || args.iter().any(|argument| argument == "--listen-path"),
    ) {
        (true, false) => value(args, "--connect-url")?,
        (false, true) => {
            let address = value(args, "--listen-address")?;
            let port = value(args, "--listen-port")?;
            let path = value(args, "--listen-path")?;
            if address != "0.0.0.0" || port != "43127" {
                return Err(LocalRunnerError::invalid(
                    "runner listener requires --listen-address 0.0.0.0 and --listen-port 43127",
                ));
            }
            if !path.starts_with("/api/runner/v1/connect/") || path.contains(['?', '#', '\\']) {
                return Err(LocalRunnerError::invalid("runner listener path is invalid"));
            }
            format!("listen://{address}:{port}{path}")
        }
        _ => {
            return Err(LocalRunnerError::invalid(
                "durable runner requires exactly one of --connect-url or --listen-address/--listen-port/--listen-path",
            ))
        }
    };
    let config = DurableRunnerConfig {
        connect_url,
        ca_bundle_path: args
            .iter()
            .any(|argument| argument == "--ca-bundle-path")
            .then(|| value(args, "--ca-bundle-path").map(PathBuf::from))
            .transpose()?,
        state_dir: PathBuf::from(value(args, "--state-dir")?),
        runner_instance_id: value(args, "--runner-id")?,
        environment_lease_id: value(args, "--environment-lease-id")?,
        run_id: value(args, "--run-id")?,
        normalized_session_id: value(args, "--session-id")?,
        turn_id: value(args, "--turn-id")?,
        item_id: value(args, "--item-id")?,
        runner_version: value(args, "--runner-version")?,
        runner_digest: value(args, "--runner-digest")?,
        fake_harness_path: args
            .iter()
            .any(|argument| argument == "--fake-harness")
            .then(|| value(args, "--fake-harness").map(PathBuf::from))
            .transpose()?,
        fake_harness_script_path: args
            .iter()
            .any(|argument| argument == "--fake-harness-script")
            .then(|| value(args, "--fake-harness-script").map(PathBuf::from))
            .transpose()?,
        max_outbox_bytes: usize_value(args, "--max-outbox-bytes", 64 * 1024)?,
        p0_reserve_bytes: usize_value(args, "--p0-reserve-bytes", 32 * 1024)?,
        max_frame_bytes: usize_value(args, "--max-frame-bytes", 1024 * 1024)?,
        reconnect_delay: duration_value(args, "--reconnect-delay-ms", 25)?,
        reconnect_grace: optional_duration_value(args, "--reconnect-grace-ms")?,
        max_runtime,
        lifecycle_mode,
        idle_timeout,
    };
    let bootstrap_ticket = bootstrap_ticket
        .ok_or_else(|| LocalRunnerError::invalid("runner bootstrap ticket is not available"))?;
    run_durable_runner(config, bootstrap_ticket)
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))
}

fn run(bootstrap_ticket: Option<BootstrapTicket>) -> Result<(), LocalRunnerError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.as_slice() == ["--build-metadata"] {
        println!("{}", build_metadata());
        return Ok(());
    }
    if args
        .iter()
        .any(|argument| argument == "--codex-app-server-proxy")
    {
        return run_codex_app_server_proxy(&args);
    }
    if args.iter().any(|argument| argument == "--connect-url")
        || args.iter().any(|argument| argument == "--listen-address")
    {
        return run_durable_mode(&args, bootstrap_ticket);
    }
    run_local_runner(RunnerConfig {
        run_id: value(&args, "--run-id")?,
        normalized_session_id: value(&args, "--session-id")?,
        runner_instance_id: value(&args, "--runner-id")?,
        fake_harness_path: PathBuf::from(value(&args, "--fake-harness")?),
        script_path: PathBuf::from(value(&args, "--script")?),
        delay_override_ms: optional_u64(&args, "--delay-ms")?,
        log_max_lines: usize_value(&args, "--log-max-lines", 32)?,
        log_max_bytes: usize_value(&args, "--log-max-bytes", 16_384)?,
        harness_max_line_bytes: usize_value(&args, "--harness-max-line-bytes", 64 * 1024)?,
        shutdown_grace: Duration::from_millis(
            optional_u64(&args, "--shutdown-grace-ms")?.unwrap_or(100),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_metadata_names_the_versioned_eval_contracts() {
        let metadata = build_metadata();
        assert_eq!(metadata["schema"], RUNNERD_BUILD_METADATA_SCHEMA);
        assert_eq!(metadata["packageVersion"], "0.1.2");
        assert_eq!(metadata["binaryContractVersion"], 1);
        assert_eq!(metadata["nativeExecutionVersion"], 1);
        assert_eq!(metadata["harnessDriverVersion"], 1);
        assert_eq!(metadata["prp"]["minimumVersion"], 1);
        assert_eq!(metadata["prp"]["maximumVersion"], 1);
        assert_eq!(
            metadata["prpTransportModes"],
            json!(["dial_ws_loopback", "dial_wss", "listen_ws"])
        );
    }
}

fn main() -> ExitCode {
    // Capture and remove the bootstrap capability before argument parsing or child work.
    let bootstrap_ticket = match capture_bootstrap_ticket() {
        Ok(ticket) => ticket,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            return ExitCode::FAILURE;
        }
    };
    match run(bootstrap_ticket) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            ExitCode::FAILURE
        }
    }
}
