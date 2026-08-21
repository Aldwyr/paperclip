use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::SupervisedProcess;
use crate::provider_bridge::{AuthorizedTool, ToolResult};

pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

fn skillless_thread_config() -> Value {
    json!({
        "skills.include_instructions": false,
        "include_apps_instructions": false,
        "include_collaboration_mode_instructions": false,
        "features.apps": false,
        "features.plugins": false,
        "features.multi_agent": false,
        "features.memories": false,
        "features.image_generation": false,
    })
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    #[default]
    Codex,
    Opencode,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    #[serde(default)]
    pub kind: ProviderKind,
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub model: Option<String>,
    pub instructions: String,
}

pub trait Provider {
    fn kind(&self) -> ProviderKind;
    fn process_id(&self) -> u32;
    fn session_identity(&self) -> &str;
    fn provider_session_id(&self) -> Option<&str>;
    fn start_turn(&mut self, message: &str, cwd: &str) -> Result<Value, LocalRunnerError>;
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError>;
    fn read(&mut self) -> Result<Value, LocalRunnerError>;
    fn poll(&mut self) -> Result<Option<CodexProviderEvent>, LocalRunnerError>;
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError>;
    fn shutdown(&mut self) -> Result<(), LocalRunnerError>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexProviderEvent {
    ToolCall {
        call_id: String,
        operation_id: String,
        input: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    SemanticResult {
        result: Value,
        item_id: Option<String>,
    },
    Exited,
}

pub struct CodexProvider {
    kind: ProviderKind,
    process: SupervisedProcess,
    next_request_id: u64,
    thread_id: String,
    session_id: Option<String>,
    pending_tool_requests: BTreeMap<String, Value>,
}

impl CodexProvider {
    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub fn start(
        config: &CodexProviderConfig,
        tools: impl Iterator<Item = AuthorizedTool>,
        resume_thread_id: Option<&str>,
    ) -> Result<Self, LocalRunnerError> {
        let mut provider = Self {
            kind: config.kind,
            process: SupervisedProcess::spawn(
                Path::new(&config.command),
                &config.args,
                Duration::from_secs(2),
                CODEX_APP_SERVER_MAX_FRAME_BYTES,
            )?,
            next_request_id: 1,
            thread_id: String::new(),
            session_id: None,
            pending_tool_requests: BTreeMap::new(),
        };
        let initialized = provider.request("initialize", json!({
            "clientInfo": { "name": "paperclip-runnerd", "title": "Paperclip Runner", "version": "1" },
            "capabilities": { "experimentalApi": true, "requestAttestation": false }
        }))?;
        provider.process.send(&json!({"method": "initialized"}))?;
        let dynamic_tools = tools
            .map(|tool| {
                json!({
                    "name": tool.operation_id,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })
            })
            .collect::<Vec<_>>();
        let opened = if let Some(thread_id) = resume_thread_id {
            provider.request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": config.cwd,
                    "model": config.model,
                    "approvalPolicy": "never",
                    "permissions": "paperclip-runner-workspace-only",
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": skillless_thread_config(),
                    "baseInstructions": config.instructions,
                    "dynamicTools": dynamic_tools,
                    "experimentalRawEvents": true,
                    "persistExtendedHistory": true,
                }),
            )?
        } else {
            provider.request(
                "thread/start",
                json!({
                    "cwd": config.cwd,
                    "model": config.model,
                    "approvalPolicy": "never",
                    "permissions": "paperclip-runner-workspace-only",
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": skillless_thread_config(),
                    "baseInstructions": config.instructions,
                    "dynamicTools": dynamic_tools,
                    "experimentalRawEvents": true,
                    "persistExtendedHistory": true,
                }),
            )?
        };
        provider.thread_id = opened
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LocalRunnerError::invalid("Codex thread/start omitted thread.id"))?
            .to_owned();
        provider.session_id = opened
            .pointer("/thread/sessionId")
            .and_then(Value::as_str)
            .or_else(|| {
                initialized
                    .pointer("/user/sessionId")
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        Ok(provider)
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn start_turn(&mut self, message: &str, cwd: &str) -> Result<Value, LocalRunnerError> {
        let thread_id = self.thread_id.clone();
        self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "cwd": cwd,
                "permissions": "paperclip-runner-workspace-only",
                "runtimeWorkspaceRoots": [cwd],
                "input": [{"type": "text", "text": message, "text_elements": []}],
            }),
        )
    }

    pub fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        let thread_id = self.thread_id.clone();
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
    }

    pub fn read_thread(&mut self) -> Result<Value, LocalRunnerError> {
        let thread_id = self.thread_id.clone();
        self.request(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )
    }

    pub fn poll(&mut self) -> Result<Option<CodexProviderEvent>, LocalRunnerError> {
        let Some(line) = self.process.receive_stdout_line(Duration::from_millis(1))? else {
            return if self.process.try_wait()?.is_some() {
                Ok(Some(CodexProviderEvent::Exited))
            } else {
                Ok(None)
            };
        };
        let message: Value = serde_json::from_str(&line).map_err(|error| {
            LocalRunnerError::invalid(format!("Codex emitted invalid JSON-RPC: {error}"))
        })?;
        if message.get("id").is_some()
            && message.get("method").and_then(Value::as_str) == Some("item/tool/call")
        {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let call_id = params
                .get("callId")
                .and_then(Value::as_str)
                .ok_or_else(|| LocalRunnerError::invalid("Codex tool call omitted callId"))?
                .to_owned();
            let operation_id = params
                .get("tool")
                .and_then(Value::as_str)
                .ok_or_else(|| LocalRunnerError::invalid("Codex tool call omitted tool"))?
                .to_owned();
            if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id.as_str()) {
                return Err(LocalRunnerError::invalid(
                    "Codex tool call named another thread",
                ));
            }
            self.pending_tool_requests
                .insert(call_id.clone(), message["id"].clone());
            return Ok(Some(CodexProviderEvent::ToolCall {
                call_id,
                operation_id,
                input: params.get("arguments").cloned().unwrap_or(Value::Null),
            }));
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            if method == "paperclip/runResult" {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let result = params.get("result").cloned().ok_or_else(|| {
                    LocalRunnerError::invalid("OpenCode semantic result omitted result")
                })?;
                return Ok(Some(CodexProviderEvent::SemanticResult {
                    result,
                    item_id: params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }));
            }
            return Ok(Some(CodexProviderEvent::Notification {
                method: method.to_owned(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            }));
        }
        Ok(None)
    }

    pub fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let request_id = self
            .pending_tool_requests
            .remove(&result.call_id)
            .ok_or_else(|| {
                LocalRunnerError::invalid("Codex tool result has no pending JSON-RPC request")
            })?;
        self.process.send(&json!({
            "id": request_id,
            "result": {
                "success": true,
                "contentItems": [{"type": "inputText", "text": serde_json::to_string(&result.result).unwrap_or_else(|_| "null".to_owned())}]
            }
        }))
    }

    /// Stops the provider process group at an explicit runner lifecycle boundary.
    ///
    /// `Drop` remains the last-resort cleanup path, but runner shutdown must not
    /// depend on an implicit destructor firing after the durable transport loop.
    pub fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.process.terminate_group().map(|_| ())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, LocalRunnerError> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.process
            .send(&json!({"id": id, "method": method, "params": params}))?;
        loop {
            let line = self
                .process
                .receive_stdout_line(Duration::from_secs(30))?
                .ok_or_else(|| {
                    LocalRunnerError::invalid(format!("Codex {method} response timed out"))
                })?;
            let message: Value = serde_json::from_str(&line).map_err(|error| {
                LocalRunnerError::invalid(format!("Codex emitted invalid JSON-RPC: {error}"))
            })?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(LocalRunnerError::invalid(format!(
                        "Codex {method} failed: {error}"
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }
}

impl Provider for CodexProvider {
    fn kind(&self) -> ProviderKind {
        self.kind
    }
    fn process_id(&self) -> u32 {
        CodexProvider::process_id(self)
    }
    fn session_identity(&self) -> &str {
        self.thread_id()
    }
    fn provider_session_id(&self) -> Option<&str> {
        self.session_id()
    }
    fn start_turn(&mut self, message: &str, cwd: &str) -> Result<Value, LocalRunnerError> {
        CodexProvider::start_turn(self, message, cwd)
    }
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        CodexProvider::interrupt_turn(self, turn_id)
    }
    fn read(&mut self) -> Result<Value, LocalRunnerError> {
        self.read_thread()
    }
    fn poll(&mut self) -> Result<Option<CodexProviderEvent>, LocalRunnerError> {
        CodexProvider::poll(self)
    }
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        CodexProvider::deliver_tool_result(self, result)
    }
    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        CodexProvider::shutdown(self)
    }
}
