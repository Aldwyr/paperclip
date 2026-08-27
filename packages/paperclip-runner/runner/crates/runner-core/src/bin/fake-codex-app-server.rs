use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Mode {
    large_event: bool,
    oversized_event: bool,
    linger_after_turn_start: bool,
    runtime_question: bool,
    runtime_elicitation: bool,
    structured_activity: bool,
    include_skill_instructions: bool,
    expected_approval_policy: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatefulFakeState {
    thread_id: String,
    active_turn_id: Option<String>,
}

fn argument(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn send(value: Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run_scenario(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.iter().any(|arg| arg == "--exit-before-initialize") {
        eprintln!("authorization=super-secret-provider-token");
        return Err("intentional provider startup exit".into());
    }
    let mode = Mode {
        large_event: args.iter().any(|arg| arg == "--large-event"),
        oversized_event: args.iter().any(|arg| arg == "--oversized-event"),
        linger_after_turn_start: args.iter().any(|arg| arg == "--linger-after-turn-start"),
        runtime_question: args.iter().any(|arg| arg == "--runtime-question"),
        runtime_elicitation: args.iter().any(|arg| arg == "--runtime-elicitation"),
        structured_activity: args.iter().any(|arg| arg == "--structured-activity"),
        include_skill_instructions: args.iter().any(|arg| arg == "--include-skill-instructions"),
        expected_approval_policy: args
            .windows(2)
            .find(|pair| pair[0] == "--expected-approval-policy")
            .map(|pair| pair[1].clone()),
    };
    let mut turn_count = 0_u64;
    let mut active_turn_id: Option<String> = None;
    let mut planning_thread = false;
    let mut pending_tool_turns = BTreeMap::<String, String>::new();
    let mut pending_question_turns = BTreeMap::<String, String>::new();
    let mut pending_elicitation_turns = BTreeMap::<String, String>::new();
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
                if let Some(expected) = mode.expected_approval_policy.as_deref() {
                    if request
                        .pointer("/params/approvalPolicy")
                        .and_then(Value::as_str)
                        != Some(expected)
                    {
                        return Err(
                            format!("{method} omitted expected approvalPolicy={expected}").into(),
                        );
                    }
                }
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
                if request
                    .pointer("/params/permissions")
                    .is_some_and(Value::is_string)
                {
                    send(json!({
                        "id": id,
                        "error": {
                            "code": -32600,
                            "message": "Invalid request: invalid type: string, expected internally tagged enum PermissionProfileSelectionParams"
                        }
                    }))?;
                    continue;
                }
                let config = request.pointer("/params/config").and_then(Value::as_object);
                planning_thread = request
                    .pointer("/params/permissions/id")
                    .and_then(Value::as_str)
                    == Some("paperclip-runner-workspace-read-only");
                if request
                    .pointer("/params/permissions/type")
                    .and_then(Value::as_str)
                    != Some("profile")
                {
                    return Err(format!("{method} omitted a structured permission profile").into());
                }
                if config
                    .and_then(|value| value.get("skills.include_instructions"))
                    .and_then(Value::as_bool)
                    != Some(mode.include_skill_instructions)
                {
                    return Err(format!(
                        "thread config omitted skills.include_instructions={}",
                        mode.include_skill_instructions
                    )
                    .into());
                }
                for key in [
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
                if request
                    .pointer("/params/permissions/type")
                    .and_then(Value::as_str)
                    != Some("profile")
                {
                    return Err("turn/start omitted a structured permission profile".into());
                }
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
                if mode.structured_activity {
                    send(json!({
                        "method": "turn/plan/updated",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "revision": 1,
                            "plan": [
                                {"step": "Inspect the runner path", "status": "inProgress"},
                                {"step": "Implement the status island", "status": "pending"},
                                {"step": "Verify replay and UI behavior", "status": "pending"}
                            ]
                        }
                    }))?;
                    send(json!({
                        "method": "turn/diff/updated",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "revision": 1,
                            "diff": "diff --git a/ui/src/status.tsx b/ui/src/status.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/ui/src/status.tsx\n@@ -0,0 +1,2 @@\n+export const status = 'working';\n+export const steps = 3;\n"
                        }
                    }))?;
                    send(json!({
                        "method": "turn/plan/updated",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "revision": 2,
                            "plan": [
                                {"step": "Inspect the runner path", "status": "completed"},
                                {"step": "Implement the status island", "status": "inProgress"},
                                {"step": "Verify replay and UI behavior", "status": "pending"}
                            ]
                        }
                    }))?;
                }
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
                if mode.runtime_question {
                    let request_id = format!("rpc-question-{turn_count}");
                    pending_question_turns.insert(request_id.clone(), turn_id.clone());
                    send(json!({
                        "id": request_id,
                        "method": "item/tool/requestUserInput",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "itemId": "question-item",
                            "questions": [
                                {
                                    "id": "environment",
                                    "header": "Environment",
                                    "question": "Where should we deploy?",
                                    "options": [
                                        {"label": "Staging", "description": "Deploy to staging first."},
                                        {"label": "Production", "description": "Deploy directly to production."}
                                    ],
                                    "isOther": true
                                },
                                {
                                    "id": "regions",
                                    "header": "Regions",
                                    "question": "Which regions?",
                                    "options": [{"label": "US"}, {"label": "EU"}],
                                    "multiSelect": true
                                },
                                {
                                    "id": "notes",
                                    "header": "Notes",
                                    "question": "Anything else?",
                                    "required": false
                                }
                            ]
                        }
                    }))?;
                    continue;
                }
                if mode.runtime_elicitation {
                    let request_id = format!("rpc-elicitation-{turn_count}");
                    pending_elicitation_turns.insert(request_id.clone(), turn_id.clone());
                    send(json!({
                        "id": request_id,
                        "method": "mcpServer/elicitation/request",
                        "params": {
                            "threadId": "fake-thread",
                            "turnId": turn_id,
                            "itemId": "elicitation-item",
                            "message": "Choose typed deployment settings.",
                            "requestedSchema": {
                                "type": "object",
                                "required": ["environment", "regions", "replicas", "approved"],
                                "properties": {
                                    "environment": {
                                        "type": "string",
                                        "title": "Environment",
                                        "oneOf": [
                                            {"const": "staging", "title": "Staging", "description": "Deploy to staging first."},
                                            {"const": "production", "title": "Production"}
                                        ]
                                    },
                                    "regions": {
                                        "type": "array",
                                        "title": "Regions",
                                        "items": {"enum": ["us", "eu"]}
                                    },
                                    "replicas": {
                                        "type": "integer",
                                        "title": "Replicas",
                                        "minimum": 1,
                                        "maximum": 10
                                    },
                                    "approved": {"type": "boolean", "title": "Approved"}
                                }
                            }
                        }
                    }))?;
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
            if mode.structured_activity {
                send(json!({
                    "method": "turn/plan/updated",
                    "params": {
                        "threadId": "fake-thread",
                        "turnId": turn_id,
                        "revision": 3,
                        "plan": [
                            {"step": "Inspect the runner path", "status": "completed"},
                            {"step": "Implement the status island", "status": "completed"},
                            {"step": "Verify replay and UI behavior", "status": "completed"}
                        ]
                    }
                }))?;
                send(json!({
                    "method": "turn/diff/updated",
                    "params": {
                        "threadId": "fake-thread",
                        "turnId": turn_id,
                        "revision": 2,
                        "diff": "diff --git a/ui/src/status.tsx b/ui/src/status.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/ui/src/status.tsx\n@@ -0,0 +1,3 @@\n+export const status = 'complete';\n+export const steps = 3;\n+export const verified = true;\n"
                    }
                }))?;
            }
            send(json!({
                "method": "paperclip/runResult",
                "params": {
                    "threadId": "fake-thread",
                    "turnId": turn_id,
                    "itemId": "semantic-result",
                    "result": fake_semantic_result("Fake provider completed the operation.")
                }
            }))?;
            send(
                json!({"method": "turn/completed", "params": {"threadId": "fake-thread", "turn": {"id": turn_id, "status": "completed"}}}),
            )?;
        }
        let completed_question = request
            .get("id")
            .and_then(Value::as_str)
            .and_then(|request_id| pending_question_turns.remove(request_id));
        if let Some(turn_id) = completed_question.filter(|_| request.get("result").is_some()) {
            if request.pointer("/result/answers")
                != Some(&json!({
                    "environment": {"answers": ["Staging"]},
                    "regions": {"answers": ["US", "EU"]},
                    "notes": {"answers": ["Ship during the maintenance window."]}
                }))
            {
                return Err(
                    format!("runtime question received wrong response: {}", request).into(),
                );
            }
            send(json!({
                "method": "paperclip/runResult",
                "params": {
                    "threadId": "fake-thread",
                    "turnId": turn_id,
                    "itemId": "semantic-result",
                    "result": fake_semantic_result("Fake provider completed after runtime input.")
                }
            }))?;
            send(
                json!({"method": "turn/completed", "params": {"threadId": "fake-thread", "turn": {"id": turn_id, "status": "completed"}}}),
            )?;
        }
        let completed_elicitation = request
            .get("id")
            .and_then(Value::as_str)
            .and_then(|request_id| pending_elicitation_turns.remove(request_id));
        if let Some(turn_id) = completed_elicitation.filter(|_| request.get("result").is_some()) {
            if request.get("result")
                != Some(&json!({
                    "action": "accept",
                    "content": {
                        "environment": "staging",
                        "regions": ["us", "eu"],
                        "replicas": 3,
                        "approved": true
                    },
                    "_meta": null
                }))
            {
                return Err(
                    format!("runtime elicitation received wrong response: {}", request).into(),
                );
            }
            send(json!({
                "method": "paperclip/runResult",
                "params": {
                    "threadId": "fake-thread",
                    "turnId": turn_id,
                    "itemId": "semantic-result",
                    "result": fake_semantic_result("Fake provider completed after typed elicitation.")
                }
            }))?;
            send(
                json!({"method": "turn/completed", "params": {"threadId": "fake-thread", "turn": {"id": turn_id, "status": "completed"}}}),
            )?;
        }
    }
    Ok(())
}

fn fake_semantic_result(summary: &str) -> Value {
    json!({
        "schema": "paperclip.run_result.v1",
        "reportedWorkDisposition": "done",
        "summary": summary,
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
    })
}

fn load_state(path: &Path) -> StatefulFakeState {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| StatefulFakeState {
            thread_id: "codex-thread-1".to_owned(),
            active_turn_id: None,
        })
}

fn save_state(path: &Path, state: &StatefulFakeState) -> io::Result<()> {
    fs::write(path, serde_json::to_vec_pretty(state)?)
}

fn log_call(path: Option<&Path>, method: &str) -> io::Result<()> {
    let Some(path) = path else { return Ok(()) };
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{method}")
}

fn finish_stateful_turn(
    state_path: &Path,
    state: &mut StatefulFakeState,
    status: &str,
) -> io::Result<()> {
    let turn_id = state
        .active_turn_id
        .clone()
        .unwrap_or_else(|| "provider-turn-1".to_owned());
    send(json!({
        "method": "item/completed",
        "params": {"item": {
            "id": "message-1",
            "type": "agentMessage",
            "status": "completed",
            "text": "Codex completed the fake turn."
        }}
    }))?;
    send(json!({
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": state.thread_id,
            "tokenUsage": {
                "total": {"inputTokens": 12, "outputTokens": 3},
                "last": {"inputTokens": 12, "outputTokens": 3, "requests": 1}
            }
        }
    }))?;
    send(json!({
        "method": "turn/completed",
        "params": {"turn": {"id": turn_id, "status": status}}
    }))?;
    state.active_turn_id = None;
    save_state(state_path, state)
}

fn run_stateful(args: &[String], state_path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let call_log = argument(args, "--call-log").map(PathBuf::from);
    let emit_question = args.iter().any(|value| value == "--emit-question");
    let hold_turn = args.iter().any(|value| value == "--hold-turn");
    let exit_after_turn_start = args.iter().any(|value| value == "--exit-after-turn-start");
    let pre_response_notification = args
        .iter()
        .any(|value| value == "--notification-before-response");
    let mut state = load_state(&state_path);

    for line in io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line?)?;
        if message.get("method").is_none() && message.get("id") == Some(&json!("runtime-request-1"))
        {
            finish_stateful_turn(&state_path, &mut state, "completed")?;
            continue;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        log_call(call_log.as_deref(), method)?;
        let id = message.get("id").cloned();
        match method {
            "initialize" => send(json!({
                "id": id,
                "result": {"user": {"sessionId": "codex-account-session"}}
            }))?,
            "initialized" => {}
            "collaborationMode/list" => send(json!({
                "id": id,
                "result": {"data": [{
                    "name": "Plan",
                    "mode": "plan",
                    "model": "gpt-test",
                    "reasoning_effort": "high"
                }]}
            }))?,
            "thread/start" => {
                state.thread_id = "codex-thread-1".to_owned();
                state.active_turn_id = None;
                save_state(&state_path, &state)?;
                if pre_response_notification {
                    send(json!({
                        "method": "warning",
                        "params": {"message": "buffered before thread response"}
                    }))?;
                }
                send(json!({
                    "id": id,
                    "result": {"thread": {
                        "id": state.thread_id,
                        "sessionId": "codex-account-session"
                    }}
                }))?;
            }
            "thread/resume" => send(json!({
                "id": id,
                "result": {"thread": {
                    "id": state.thread_id,
                    "sessionId": "codex-account-session"
                }}
            }))?,
            "thread/read" => {
                let turns = state
                    .active_turn_id
                    .as_ref()
                    .map(|turn_id| vec![json!({"id": turn_id, "status": "inProgress"})])
                    .unwrap_or_default();
                send(json!({
                    "id": id,
                    "result": {"thread": {"id": state.thread_id, "turns": turns}}
                }))?;
            }
            "turn/start" => {
                state.active_turn_id = Some("provider-turn-1".to_owned());
                save_state(&state_path, &state)?;
                send(json!({
                    "id": id,
                    "result": {"turn": {"id": "provider-turn-1", "status": "inProgress"}}
                }))?;
                send(json!({
                    "method": "turn/started",
                    "params": {"turn": {"id": "provider-turn-1"}}
                }))?;
                if exit_after_turn_start {
                    return Ok(());
                } else if emit_question {
                    send(json!({
                        "id": "runtime-request-1",
                        "method": "item/tool/requestUserInput",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "itemId": "question-item-1",
                            "isBlocking": true,
                            "title": "Deployment input",
                            "questions": [{
                                "id": "environment",
                                "header": "Environment",
                                "question": "Where should we deploy?",
                                "options": [
                                    {"label": "Staging", "description": "Deploy safely."},
                                    {"label": "Production", "description": "Deploy directly."}
                                ]
                            }]
                        }
                    }))?;
                } else if !hold_turn {
                    finish_stateful_turn(&state_path, &mut state, "completed")?;
                }
            }
            "turn/steer" => send(json!({"id": id, "result": {"accepted": true}}))?,
            "turn/interrupt" => {
                send(json!({"id": id, "result": {"accepted": true}}))?;
                finish_stateful_turn(&state_path, &mut state, "interrupted")?;
            }
            _ if id.is_some() => send(json!({
                "id": id,
                "error": {"code": -32601, "message": format!("unsupported fake method {method}")}
            }))?,
            _ => {}
        }
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(state_path) = argument(&args, "--state-file") {
        run_stateful(&args, PathBuf::from(state_path))
    } else {
        run_scenario(&args)
    }
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
