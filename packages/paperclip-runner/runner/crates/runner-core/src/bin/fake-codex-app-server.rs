use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

#[derive(Clone, Copy, Default)]
struct Mode {
    large_event: bool,
    oversized_event: bool,
    linger_after_turn_start: bool,
}

fn send(value: Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mode = Mode {
        large_event: args.iter().any(|arg| arg == "--large-event"),
        oversized_event: args.iter().any(|arg| arg == "--oversized-event"),
        linger_after_turn_start: args.iter().any(|arg| arg == "--linger-after-turn-start"),
    };
    let mut turn_count = 0_u64;
    let mut active_turn_id: Option<String> = None;
    let mut planning_thread = false;
    let mut pending_tool_turns = BTreeMap::<String, String>::new();
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
            "collaborationMode/list" => send(json!({
                "id": id,
                "result": {"data": [{"name": "Plan", "mode": "plan", "model": "gpt-test", "reasoning_effort": "high"}]}
            }))?,
            "thread/start" | "thread/resume" => {
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
                let config = request.pointer("/params/config").and_then(Value::as_object);
                planning_thread = config
                    .and_then(|value| value.get("include_collaboration_mode_instructions"))
                    .and_then(Value::as_bool)
                    == Some(true);
                for key in [
                    "skills.include_instructions",
                    "include_apps_instructions",
                    "features.apps",
                    "features.plugins",
                    "features.multi_agent",
                    "features.memories",
                    "features.image_generation",
                ] {
                    if config
                        .and_then(|value| value.get(key))
                        .and_then(Value::as_bool)
                        != Some(false)
                    {
                        return Err(format!("skillless thread config omitted {key}=false").into());
                    }
                }
                send(
                    json!({"id": id, "result": {"thread": {"id": "fake-thread", "sessionId": "fake-session"}}}),
                )?;
            }
            "thread/read" => {
                send(json!({
                    "id": id,
                    "result": {
                        "thread": {
                            "id": "fake-thread",
                            "sessionId": "fake-session",
                            "turns": [],
                            "tokenUsage": {"total": {"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0}}
                        }
                    }
                }))?;
            }
            "turn/start" => {
                if planning_thread {
                    let collaboration_mode = request.pointer("/params/collaborationMode");
                    if collaboration_mode
                        .and_then(|value| value.get("mode"))
                        .and_then(Value::as_str)
                        != Some("plan")
                        || collaboration_mode
                            .and_then(|value| value.pointer("/settings/model"))
                            .and_then(Value::as_str)
                            != Some("gpt-test")
                        || !collaboration_mode
                            .and_then(|value| value.pointer("/settings/developer_instructions"))
                            .is_some_and(Value::is_null)
                    {
                        return Err(
                            "planning turn omitted the qualified collaboration mode payload".into(),
                        );
                    }
                }
                turn_count += 1;
                let turn_id = if turn_count == 1 {
                    "fake-turn".to_owned()
                } else {
                    format!("fake-turn-{turn_count}")
                };
                active_turn_id = Some(turn_id.clone());
                let call_id = format!("call-{turn_count}");
                let request_id = format!("rpc-tool-{turn_count}");
                send(json!({"id": id, "result": {"turn": {"id": turn_id}}}))?;
                send(json!({
                    "method": "turn/started",
                    "params": {"threadId": "fake-thread", "turn": {"id": turn_id, "status": "inProgress"}}
                }))?;
                if mode.large_event || mode.oversized_event {
                    let bytes = if mode.oversized_event {
                        4 * 1024 * 1024 + 128
                    } else {
                        1_200_000
                    };
                    send(json!({
                        "method": "item/completed",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "item": {"id": "large-item", "type": "image", "imageUrl": format!("data:image/png;base64,{}", "A".repeat(bytes))}
                        }
                    }))?;
                }
                if mode.linger_after_turn_start {
                    continue;
                }
                pending_tool_turns.insert(request_id.clone(), turn_id.clone());
                send(json!({
                    "id": request_id, "method": "item/tool/call",
                    "params": {"threadId": "fake-thread", "turnId": turn_id, "callId": call_id, "tool": "get_task_context", "arguments": {}}
                }))?;
            }
            "turn/steer" => {
                let expected_turn_id = request
                    .pointer("/params/expectedTurnId")
                    .and_then(Value::as_str);
                if expected_turn_id != active_turn_id.as_deref() {
                    send(json!({
                        "id": id,
                        "error": {"code": -32000, "message": "stale active turn"}
                    }))?;
                } else {
                    send(json!({"id": id, "result": {"acknowledged": true}}))?;
                }
            }
            "turn/interrupt" => send(json!({"id": id, "result": {}}))?,
            _ => {}
        }
        let completed_turn = request
            .get("id")
            .and_then(Value::as_str)
            .and_then(|request_id| pending_tool_turns.remove(request_id));
        if let Some(turn_id) = completed_turn.filter(|_| request.get("result").is_some()) {
            send(json!({
                "method": "paperclip/runResult",
                "params": {
                    "threadId": "fake-thread",
                    "turnId": turn_id,
                    "itemId": "semantic-result",
                    "result": {
                        "schema": "paperclip.prp.result.v1",
                        "reportedWorkDisposition": "done",
                        "summary": "Fake provider completed the operation."
                    }
                }
            }))?;
            send(
                json!({"method": "turn/completed", "params": {"threadId": "fake-thread", "turn": {"id": turn_id, "status": "completed"}}}),
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
