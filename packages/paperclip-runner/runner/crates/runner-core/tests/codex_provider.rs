use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::codex_provider::{
    CodexProvider, CodexProviderConfig, CodexProviderEvent, Provider, ProviderKind,
};
use paperclip_runner_core::provider_bridge::{AuthorizedTool, ToolResult};
use serde_json::json;

#[test]
fn codex_dynamic_tool_round_trips_through_the_rust_provider_boundary() {
    let mut provider = CodexProvider::start(
        &CodexProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: Vec::new(),
            cwd: "/tmp".to_owned(),
            model: None,
            instructions: "Use the authorized Paperclip tools.".to_owned(),
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
            Some(CodexProviderEvent::ToolCall {
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
            Some(CodexProviderEvent::SemanticResult { result, item_id }) => {
                assert_eq!(result["reportedWorkDisposition"], "done");
                assert_eq!(item_id.as_deref(), Some("semantic-result"));
                saw_semantic_result = true;
            }
            Some(CodexProviderEvent::Notification { method, .. }) if method == "turn/completed" => {
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
fn provider_contract_preserves_the_opencode_tag() {
    let mut provider = CodexProvider::start(
        &CodexProviderConfig {
            kind: ProviderKind::Opencode,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: Vec::new(),
            cwd: "/tmp".to_owned(),
            model: Some("openrouter/deepseek/deepseek-v4-flash-0731".to_owned()),
            instructions: "Use the authorized Paperclip tools.".to_owned(),
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
        &CodexProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--large-event".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            instructions: "Use only the authorized Paperclip tools.".to_owned(),
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
            Some(CodexProviderEvent::Notification { method, params })
                if method == "item/completed" =>
            {
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
            Some(CodexProviderEvent::ToolCall { operation_id, .. }) => {
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
        &CodexProviderConfig {
            kind: ProviderKind::Codex,
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
            args: vec!["--oversized-event".to_owned()],
            cwd: "/tmp".to_owned(),
            model: None,
            instructions: "Use only the authorized Paperclip tools.".to_owned(),
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
