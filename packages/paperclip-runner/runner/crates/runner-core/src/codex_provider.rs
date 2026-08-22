use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::SupervisedProcess;
use crate::provider_bridge::{AuthorizedTool, ToolResult};

pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

fn default_collaboration_mode() -> String {
    "default".to_owned()
}

fn skillless_thread_config(collaboration_mode: &str) -> Value {
    json!({
        "skills.include_instructions": false,
        "include_apps_instructions": false,
        "include_collaboration_mode_instructions": collaboration_mode == "plan",
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
    ClaudeManaged,
    AwsAgentcore,
    Acpx,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProviderConfig {
    #[serde(default)]
    pub kind: ProviderKind,
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub model: Option<String>,
    pub instructions: String,
    #[serde(default = "default_collaboration_mode")]
    pub collaboration_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeManagedProviderConfig {
    pub model: String,
    pub profile_id: String,
    pub anthropic_agent_id: String,
    pub agent_version: String,
    pub environment_id: String,
    pub beta_version: String,
    pub max_session_list_cost_usd: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AwsAgentCoreProviderConfig {
    pub model: String,
    pub profile_id: String,
    pub region: String,
    pub account_id: String,
    pub harness_arn: String,
    pub harness_version: String,
    pub endpoint_arn: String,
    pub endpoint_qualifier: String,
    pub agent_runtime_arn: String,
    pub memory_arn: String,
    pub memory_id: String,
    pub invocation_role_arn: String,
    pub qualification_revision: String,
    pub event_expiry_days: u16,
    pub max_estimated_session_cost_usd: f64,
    pub max_iterations: u32,
    pub max_output_tokens: u32,
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpxProviderConfig {
    pub agent: String,
    pub model: String,
    pub acpx_version: String,
    pub agent_server_package: String,
    pub agent_server_version: String,
    pub agent_runtime_package: Option<String>,
    pub agent_runtime_version: Option<String>,
    pub command_digest: String,
    pub sidecar_command: PathBuf,
    #[serde(default)]
    pub sidecar_args: Vec<String>,
    pub runtime_directory: String,
    pub normalized_session_id: String,
    pub run_id: String,
    pub cwd: String,
    pub instructions: String,
    pub permission_policy: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderConfig {
    Local(LocalProviderConfig),
    ClaudeManaged(ClaudeManagedProviderConfig),
    AwsAgentcore(AwsAgentCoreProviderConfig),
    Acpx(AcpxProviderConfig),
}

impl ProviderConfig {
    pub fn kind(&self) -> ProviderKind {
        match self {
            Self::Local(config) => config.kind,
            Self::ClaudeManaged(_) => ProviderKind::ClaudeManaged,
            Self::AwsAgentcore(_) => ProviderKind::AwsAgentcore,
            Self::Acpx(_) => ProviderKind::Acpx,
        }
    }

    pub fn local_cwd(&self) -> Option<&str> {
        match self {
            Self::Local(config) => Some(&config.cwd),
            Self::ClaudeManaged(_) => None,
            Self::AwsAgentcore(_) => None,
            Self::Acpx(config) => Some(&config.cwd),
        }
    }
}

impl Serialize for ProviderConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Local(config) => config.serialize(serializer),
            Self::ClaudeManaged(config) => {
                let mut value = serde_json::to_value(config).map_err(serde::ser::Error::custom)?;
                value
                    .as_object_mut()
                    .expect("managed config serializes as an object")
                    .insert(
                        "kind".to_owned(),
                        Value::String("claude_managed".to_owned()),
                    );
                value.serialize(serializer)
            }
            Self::AwsAgentcore(config) => {
                let mut value = serde_json::to_value(config).map_err(serde::ser::Error::custom)?;
                value
                    .as_object_mut()
                    .expect("AgentCore config serializes as an object")
                    .insert("kind".to_owned(), Value::String("aws_agentcore".to_owned()));
                value.serialize(serializer)
            }
            Self::Acpx(config) => {
                let mut value = serde_json::to_value(config).map_err(serde::ser::Error::custom)?;
                value
                    .as_object_mut()
                    .expect("ACPX config serializes as an object")
                    .insert("kind".to_owned(), Value::String("acpx".to_owned()));
                value.serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for ProviderConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        let kind = value.get("kind").and_then(Value::as_str).unwrap_or("codex");
        if kind == "claude_managed" {
            value
                .as_object_mut()
                .expect("provider config must be an object")
                .remove("kind");
            serde_json::from_value(value)
                .map(Self::ClaudeManaged)
                .map_err(serde::de::Error::custom)
        } else if kind == "aws_agentcore" {
            value
                .as_object_mut()
                .expect("provider config must be an object")
                .remove("kind");
            serde_json::from_value(value)
                .map(Self::AwsAgentcore)
                .map_err(serde::de::Error::custom)
        } else if kind == "acpx" {
            value
                .as_object_mut()
                .expect("provider config must be an object")
                .remove("kind");
            serde_json::from_value(value)
                .map(Self::Acpx)
                .map_err(serde::de::Error::custom)
        } else {
            serde_json::from_value(value)
                .map(Self::Local)
                .map_err(serde::de::Error::custom)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "executionKind")]
pub enum ProviderRuntimeIdentity {
    #[serde(rename = "local_process")]
    LocalProcess {
        process_id: u32,
        provider_session_id: String,
    },
    #[serde(rename = "remote_service")]
    RemoteService {
        service: String,
        provider_session_id: String,
        process_id: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProviderSessionIdentity {
    #[serde(rename = "acpx")]
    Acpx {
        normalized_session_id: String,
        acpx_record_id: String,
        backend_session_id: String,
        agent_session_id: String,
        profile_digest: String,
        workspace_digest: String,
        requested_model: String,
        effective_model: String,
    },
}

pub trait Provider {
    fn kind(&self) -> ProviderKind;
    fn runtime_identity(&self) -> ProviderRuntimeIdentity;
    fn session_identity(&self) -> &str;
    fn provider_session_id(&self) -> Option<&str>;
    fn durable_session_identity(&self) -> Option<ProviderSessionIdentity> {
        None
    }
    fn durable_event_cursor(&self) -> Option<&str> {
        None
    }
    fn configure_tools(&mut self, _tools: Vec<AuthorizedTool>) -> Result<(), LocalRunnerError> {
        Ok(())
    }
    fn attach_run(
        &mut self,
        _run_id: &str,
        tools: Vec<AuthorizedTool>,
    ) -> Result<(), LocalRunnerError> {
        self.configure_tools(tools)
    }
    fn resolve_runtime_request(
        &mut self,
        _request_id: &str,
        _turn_id: &str,
        _resolution: &Value,
    ) -> Result<(), LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support runtime request resolution",
        ))
    }
    fn increase_budget(&mut self, _max_list_cost_usd: f64) -> Result<Value, LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support a remote session budget",
        ))
    }
    fn destroy_session(&mut self) -> Result<(), LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support remote session deletion",
        ))
    }
    fn start_turn(
        &mut self,
        message: &str,
        cwd: &str,
        turn_id: &str,
    ) -> Result<Value, LocalRunnerError>;
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError>;
    fn read(&mut self) -> Result<Value, LocalRunnerError>;
    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError>;
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError>;
    fn shutdown(&mut self) -> Result<(), LocalRunnerError>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
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
    RuntimeRequest {
        request_id: String,
        request_kind: String,
        title: String,
        details: Value,
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
    collaboration_mode: String,
    collaboration_mode_payload: Option<Value>,
}

impl CodexProvider {
    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub fn start(
        config: &LocalProviderConfig,
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
            collaboration_mode: config.collaboration_mode.clone(),
            collaboration_mode_payload: None,
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
        if config.collaboration_mode != "default" && config.collaboration_mode != "plan" {
            return Err(LocalRunnerError::invalid(
                "unsupported Codex collaboration mode",
            ));
        }
        let permission_profile = if config.collaboration_mode == "plan" {
            "paperclip-runner-workspace-read-only"
        } else {
            "paperclip-runner-workspace-only"
        };
        let opened = if let Some(thread_id) = resume_thread_id {
            provider.request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": config.cwd,
                    "model": config.model,
                    "approvalPolicy": "never",
                    "permissions": permission_profile,
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": skillless_thread_config(&config.collaboration_mode),
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
                    "permissions": permission_profile,
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": skillless_thread_config(&config.collaboration_mode),
                    "baseInstructions": config.instructions,
                    "dynamicTools": dynamic_tools,
                    "experimentalRawEvents": true,
                    "persistExtendedHistory": true,
                }),
            )?
        };
        if config.collaboration_mode == "plan" {
            let presets = provider
                .request("collaborationMode/list", json!({}))
                .map_err(|error| {
                    LocalRunnerError::invalid(format!(
                        "planning_mode_unsupported: Codex collaborationMode/list failed: {error}"
                    ))
                })?;
            let preset = presets
                .get("data")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| item.get("mode").and_then(Value::as_str) == Some("plan"))
                })
                .ok_or_else(|| LocalRunnerError::invalid(
                    "planning_mode_unsupported: installed Codex app-server did not advertise a native plan preset",
                ))?;
            let model = preset
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| opened.get("model").and_then(Value::as_str))
                .or(config.model.as_deref())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "planning_mode_unsupported: native plan preset did not resolve a model",
                    )
                })?;
            provider.collaboration_mode_payload = Some(json!({
                "mode": "plan",
                "settings": {
                    "model": model,
                    "reasoning_effort": preset.get("reasoning_effort").cloned().unwrap_or(Value::Null),
                    "developer_instructions": Value::Null,
                }
            }));
        }
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
        let permission_profile = if self.collaboration_mode == "plan" {
            "paperclip-runner-workspace-read-only"
        } else {
            "paperclip-runner-workspace-only"
        };
        let mut params = json!({
            "threadId": thread_id,
            "cwd": cwd,
            "permissions": permission_profile,
            "runtimeWorkspaceRoots": [cwd],
            "input": [{"type": "text", "text": message, "text_elements": []}],
        });
        if let Some(collaboration_mode) = self.collaboration_mode_payload.clone() {
            params
                .as_object_mut()
                .expect("turn parameters are an object")
                .insert("collaborationMode".to_owned(), collaboration_mode);
        }
        self.request("turn/start", params)
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

    pub fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        let Some(line) = self.process.receive_stdout_line(Duration::from_millis(1))? else {
            return if self.process.try_wait()?.is_some() {
                Ok(Some(ProviderEvent::Exited))
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
            return Ok(Some(ProviderEvent::ToolCall {
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
                return Ok(Some(ProviderEvent::SemanticResult {
                    result,
                    item_id: params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }));
            }
            return Ok(Some(ProviderEvent::Notification {
                method: method.to_owned(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            }));
        }
        Ok(None)
    }

    pub fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let request_id = self
            .pending_tool_requests
            .get(&result.call_id)
            .cloned()
            .ok_or_else(|| {
                LocalRunnerError::invalid("Codex tool result has no pending JSON-RPC request")
            })?;
        self.process.send(&json!({
            "id": request_id,
            "result": {
                "success": !result.is_error,
                "contentItems": [{"type": "inputText", "text": serde_json::to_string(&result.result).unwrap_or_else(|_| "null".to_owned())}]
            }
        }))?;
        self.pending_tool_requests.remove(&result.call_id);
        Ok(())
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
    fn runtime_identity(&self) -> ProviderRuntimeIdentity {
        ProviderRuntimeIdentity::LocalProcess {
            process_id: CodexProvider::process_id(self),
            provider_session_id: self.thread_id().to_owned(),
        }
    }
    fn session_identity(&self) -> &str {
        self.thread_id()
    }
    fn provider_session_id(&self) -> Option<&str> {
        self.session_id()
    }
    fn start_turn(
        &mut self,
        message: &str,
        cwd: &str,
        _turn_id: &str,
    ) -> Result<Value, LocalRunnerError> {
        CodexProvider::start_turn(self, message, cwd)
    }
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        CodexProvider::interrupt_turn(self, turn_id)
    }
    fn read(&mut self) -> Result<Value, LocalRunnerError> {
        self.read_thread()
    }
    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        CodexProvider::poll(self)
    }
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        CodexProvider::deliver_tool_result(self, result)
    }
    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        CodexProvider::shutdown(self)
    }
}
