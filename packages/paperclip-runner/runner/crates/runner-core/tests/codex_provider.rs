use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::codex_provider::{
    CodexProvider, CodexProviderConfig, CodexProviderEvent,
};
use paperclip_runner_core::provider_bridge::{AuthorizedTool, ToolResult};
use serde_json::json;

#[test]
fn codex_dynamic_tool_round_trips_through_the_rust_provider_boundary() {
    let mut provider = CodexProvider::start(
        &CodexProviderConfig {
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
    loop {
        assert!(
            Instant::now() < deadline,
            "fake Codex did not complete after its tool result"
        );
        if matches!(provider.poll().unwrap(), Some(CodexProviderEvent::Notification { method, .. }) if method == "turn/completed")
        {
            break;
        }
    }
}
