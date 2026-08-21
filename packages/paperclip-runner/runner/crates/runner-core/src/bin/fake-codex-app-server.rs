use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

fn send(value: Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        match method {
            "initialize" => {
                send(json!({"id": id, "result": {"user": {"sessionId": "fake-session"}}}))?
            }
            "thread/start" => {
                let tools = request
                    .pointer("/params/dynamicTools")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !tools.iter().any(|tool| {
                    tool.get("name").and_then(Value::as_str) == Some("get_task_context")
                }) {
                    return Err("authorized tool was not registered".into());
                }
                send(
                    json!({"id": id, "result": {"thread": {"id": "fake-thread", "sessionId": "fake-session"}}}),
                )?;
            }
            "turn/start" => {
                send(json!({"id": id, "result": {"turn": {"id": "fake-turn"}}}))?;
                send(json!({
                    "id": "rpc-tool-1", "method": "item/tool/call",
                    "params": {"threadId": "fake-thread", "turnId": "fake-turn", "callId": "call-1", "tool": "get_task_context", "arguments": {}}
                }))?;
            }
            _ => {}
        }
        if request.get("id").and_then(Value::as_str) == Some("rpc-tool-1")
            && request.get("result").is_some()
        {
            send(
                json!({"method": "turn/completed", "params": {"threadId": "fake-thread", "turn": {"id": "fake-turn", "status": "completed"}}}),
            )?;
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    run().map_or_else(
        |error| {
            eprintln!("fake-codex-app-server: {error}");
            ExitCode::FAILURE
        },
        |()| ExitCode::SUCCESS,
    )
}
