use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::codex_provider::{
    CodexProvider, LocalProviderConfig, Provider, ProviderEvent, ProviderKind,
};
use paperclip_runner_core::provider_bridge::{AuthorizedTool, ToolResult};
use serde_json::json;

fn test_tool() -> AuthorizedTool {
    AuthorizedTool {
        operation_id: "get_task_context".to_owned(),
        version: 1,
        description: "Read task context.".to_owned(),
        input_schema: json!({"type": "object"}),
        response_schema: json!({"type": "object"}),
    }
}

#[test]
fn codex_plan_mode_is_qualified_and_selected_on_turn_start() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: Vec::new(),
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Author a plan without editing files.".to_owned(),
            collaboration_mode: "plan".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![test_tool()].into_iter(),
        None,
    )
    .unwrap();
    provider.start_turn("Plan the work.", "/tmp").unwrap();
    provider.shutdown().unwrap();
}

#[test]
fn codex_permission_policy_is_pinned_on_thread_start_and_resume() {
    for policy in ["never", "on-request", "untrusted"] {
        for resume_thread_id in [None, Some("existing-thread")] {
            let mut provider = CodexProvider::start(
                &LocalProviderConfig {
                    kind: ProviderKind::Codex,
                    command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
                    args: vec!["--expected-approval-policy".to_owned(), policy.to_owned()],
                    cwd: "/tmp".to_owned(),
                    model: None,
                    approval_policy: policy.to_owned(),
                    instructions: "Use the configured approval policy.".to_owned(),
                    collaboration_mode: "default".to_owned(),
                    include_collaboration_mode_instructions: true,
                    include_skill_instructions: false,
                    runtime_context: None,
                },
                vec![test_tool()].into_iter(),
                resume_thread_id,
            )
            .unwrap();
            provider.shutdown().unwrap();
        }
    }
}

#[test]
fn codex_dynamic_tool_round_trips_through_the_rust_provider_boundary() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: Vec::new(),
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Use the authorized Paperclip tools.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }]
        .into_iter(),
        None,
    )
    .unwrap();
    provider.start_turn("Inspect the task.", "/tmp").unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(
            Instant::now() < deadline,
            "fake Codex did not issue its tool call"
        );
        match provider.poll().unwrap() {
            Some(ProviderEvent::ToolCall {
                call_id,
                operation_id,
                input,
            }) => {
                assert_eq!(operation_id, "get_task_context");
                assert_eq!(input, json!({}));
                provider
                    .deliver_tool_result(&ToolResult {
                        call_id,
                        operation_id,
                        result: json!({"ok": true, "task": {"id": "task-1"}}),
                        is_error: false,
                    })
                    .unwrap();
                break;
            }
            _ => continue,
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_semantic_result = false;
    loop {
        assert!(
            Instant::now() < deadline,
            "fake Codex did not complete after its tool result"
        );
        match provider.poll().unwrap() {
            Some(ProviderEvent::SemanticResult { result, item_id }) => {
                assert_eq!(result["reportedWorkDisposition"], "done");
                assert_eq!(item_id.as_deref(), Some("semantic-result"));
                saw_semantic_result = true;
            }
            Some(ProviderEvent::Notification { method, .. }) if method == "turn/completed" => {
                assert!(
                    saw_semantic_result,
                    "semantic result must precede terminal completion"
                );
                break;
            }
            _ => {}
        }
    }
}

#[test]
fn deterministic_fixture_emits_replacing_plan_and_diff_snapshots() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--structured-activity".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Emit deterministic structured activity.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![test_tool()].into_iter(),
        None,
    )
    .unwrap();
    provider
        .start_turn("Exercise the fixture.", "/tmp")
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut plan_revisions = Vec::new();
    let mut diff_revisions = Vec::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "fixture did not issue its tool call"
        );
        match provider.poll().unwrap() {
            Some(ProviderEvent::Notification { method, params })
                if method == "turn/plan/updated" =>
            {
                plan_revisions.push(params["revision"].as_u64().unwrap());
                assert_eq!(params["turnId"], "fake-turn");
            }
            Some(ProviderEvent::Notification { method, params })
                if method == "turn/diff/updated" =>
            {
                diff_revisions.push(params["revision"].as_u64().unwrap());
            }
            Some(ProviderEvent::ToolCall {
                call_id,
                operation_id,
                ..
            }) => {
                provider
                    .deliver_tool_result(&ToolResult {
                        call_id,
                        operation_id,
                        result: json!({"ok": true}),
                        is_error: false,
                    })
                    .unwrap();
                break;
            }
            _ => {}
        }
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < deadline, "fixture did not finish its turn");
        match provider.poll().unwrap() {
            Some(ProviderEvent::Notification { method, params })
                if method == "turn/plan/updated" =>
            {
                plan_revisions.push(params["revision"].as_u64().unwrap());
            }
            Some(ProviderEvent::Notification { method, params })
                if method == "turn/diff/updated" =>
            {
                diff_revisions.push(params["revision"].as_u64().unwrap());
            }
            Some(ProviderEvent::Notification { method, .. }) if method == "turn/completed" => break,
            _ => {}
        }
    }

    assert_eq!(plan_revisions, vec![1, 2, 3]);
    assert_eq!(diff_revisions, vec![1, 2]);
}

#[test]
fn dot_185_runtime_question_round_trips_through_the_rust_provider_boundary() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--runtime-question".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Ask for deployment input.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![test_tool()].into_iter(),
        None,
    )
    .unwrap();
    provider
        .start_turn("Ask the deployment questions.", "/tmp")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(
            Instant::now() < deadline,
            "fake Codex did not request runtime input"
        );
        if let Some(ProviderEvent::RuntimeRequest { request }) = provider.poll().unwrap() {
            assert_eq!(request["schema"], "paperclip.runtime_request.v2");
            assert_eq!(request["requestKind"], "runtime");
            assert_eq!(request["type"], "input");
            assert_eq!(request["input"]["questions"].as_array().unwrap().len(), 3);
            Provider::resolve_runtime_request(
                &mut provider,
                "rpc-question-1",
                "paperclip-turn",
                &json!({
                    "action": "submit",
                    "response": {
                        "schema": "paperclip.question_response.v1",
                        "answers": {
                            "environment": {"selectedOptionIds": ["option-1"]},
                            "regions": {"selectedOptionIds": ["option-1", "option-2"]},
                            "notes": {"text": "Ship during the maintenance window."}
                        }
                    }
                }),
            )
            .unwrap();
            break;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(
            Instant::now() < deadline,
            "fake Codex did not finish after input"
        );
        if let Some(ProviderEvent::Notification { method, .. }) = provider.poll().unwrap() {
            if method == "turn/completed" {
                break;
            }
        }
    }
    provider.shutdown().unwrap();
}

#[test]
fn provider_contract_preserves_the_opencode_tag() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Opencode,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: Vec::new(),
            cwd: "/tmp".to_owned(),
            model: Some("openrouter/deepseek/deepseek-v4-flash-0731".to_owned()),
            approval_policy: "never".to_owned(),
            instructions: "Use the authorized Paperclip tools.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: false,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }]
        .into_iter(),
        None,
    )
    .unwrap();
    assert_eq!(Provider::kind(&provider), ProviderKind::Opencode);
    Provider::shutdown(&mut provider).unwrap();
}

#[test]
fn image_like_prompt_stays_skillless_and_accepts_a_valid_one_point_two_megabyte_event() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--large-event".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Use only the authorized Paperclip tools.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }]
        .into_iter(),
        None,
    )
    .unwrap();
    provider
        .start_turn("Create an ASCII frog.", "/tmp")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut saw_large_event = false;
    let mut saw_authorized_tool = false;
    loop {
        assert!(
            Instant::now() < deadline,
            "large provider event was not received"
        );
        match provider.poll().unwrap() {
            Some(ProviderEvent::Notification { method, params }) if method == "item/completed" => {
                assert!(
                    params
                        .pointer("/item/imageUrl")
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .len()
                        > 1_100_000
                );
                saw_large_event = true;
            }
            Some(ProviderEvent::ToolCall { operation_id, .. }) => {
                assert_eq!(operation_id, "get_task_context");
                saw_authorized_tool = true;
            }
            _ => {}
        }
        if saw_large_event && saw_authorized_tool {
            break;
        }
    }
    provider.shutdown().unwrap();
}

#[test]
fn codex_provider_rejects_an_event_above_the_four_megabyte_hard_limit() {
    let mut provider = CodexProvider::start(
        &LocalProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--oversized-event".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            approval_policy: "never".to_owned(),
            instructions: "Use only the authorized Paperclip tools.".to_owned(),
            collaboration_mode: "default".to_owned(),
            include_collaboration_mode_instructions: true,
            include_skill_instructions: false,
            runtime_context: None,
        },
        vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }]
        .into_iter(),
        None,
    )
    .unwrap();
    provider
        .start_turn("Create an ASCII frog.", "/tmp")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(
            Instant::now() < deadline,
            "oversized provider event did not fail"
        );
        match provider.poll() {
            Err(error) => {
                assert!(error
                    .to_string()
                    .contains("stdout frame exceeded 4194304 bytes"));
                break;
            }
            _ => {}
        }
    }
}
