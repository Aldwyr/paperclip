use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::{ProcessOutput, SupervisedProcess};
use crate::provider_bridge::{AuthorizedTool, ToolResult};

pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_PROVIDER_TRACE_MAX_BYTES: usize = 64 * 1024 * 1024;

struct ProviderTraceSink {
    sender: Option<mpsc::SyncSender<String>>,
    writer: Option<thread::JoinHandle<()>>,
    writer_error: Arc<Mutex<Option<String>>>,
    provider: String,
    next_frame_id: u64,
    next_debug_sequence: u64,
    captured_bytes: usize,
    max_bytes: usize,
    truncated: bool,
    incomplete_reason: Option<String>,
}

impl ProviderTraceSink {
    fn from_environment(provider: ProviderKind) -> Option<Self> {
        let trace_path = std::env::var_os("PAPERCLIP_PROVIDER_TRACE_PATH")?;
        let max_bytes = std::env::var("PAPERCLIP_PROVIDER_TRACE_MAX_BYTES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROVIDER_TRACE_MAX_BYTES);
        Some(Self::at_path(trace_path.into(), max_bytes, provider))
    }

    fn at_path(trace_path: PathBuf, max_bytes: usize, provider: ProviderKind) -> Self {
        // Debug delivery is deliberately bounded and lossy: a slow trace disk
        // may mark the trace incomplete, but it can never backpressure PRP.
        let (sender, receiver) = mpsc::sync_channel::<String>(1_024);
        let writer_error = Arc::new(Mutex::new(None));
        let thread_error = Arc::clone(&writer_error);
        let writer = thread::spawn(move || {
            let result = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&trace_path)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut permissions = file.metadata()?.permissions();
                    permissions.set_mode(0o600);
                    fs::set_permissions(&trace_path, permissions)?;
                }
                for line in receiver {
                    file.write_all(line.as_bytes())?;
                    file.write_all(b"\n")?;
                }
                file.flush()
            })();
            if let Err(error) = result {
                if let Ok(mut slot) = thread_error.lock() {
                    *slot = Some(format!("trace_sidecar_write_failed:{error}"));
                }
            }
        });
        Self {
            sender: Some(sender),
            writer: Some(writer),
            writer_error,
            provider: match provider {
                ProviderKind::Codex => "codex",
                ProviderKind::Opencode => "opencode",
                ProviderKind::ClaudeManaged => "claude_managed",
                ProviderKind::AwsAgentcore => "aws_agentcore",
                ProviderKind::Acpx => "acpx",
            }
            .to_owned(),
            next_frame_id: 1,
            next_debug_sequence: 1,
            captured_bytes: 0,
            max_bytes,
            truncated: false,
            incomplete_reason: None,
        }
    }

    fn send_record(&mut self, mut value: Value) {
        let Some(sender) = self.sender.as_ref().cloned() else {
            return;
        };
        if let Some(object) = value.as_object_mut() {
            object.insert("debugChannel".to_owned(), json!("rust_native"));
            object.insert("debugSequence".to_owned(), json!(self.next_debug_sequence));
            self.next_debug_sequence += 1;
        }
        match sender.try_send(value.to_string()) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                self.incomplete_reason = Some("trace_sidecar_spool_full".to_owned());
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.incomplete_reason = Some("trace_sidecar_channel_closed".to_owned());
                self.sender = None;
            }
        }
    }

    fn frame(&mut self, direction: &str, raw: &[u8]) -> Option<u64> {
        if self.captured_bytes.saturating_add(raw.len()) > self.max_bytes {
            self.truncated = true;
            return None;
        }
        let frame_id = self.next_frame_id;
        self.next_frame_id += 1;
        self.captured_bytes += raw.len();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string();
        self.send_record(json!({
            "kind": "frame",
            "schema": "paperclip.provider_trace_frame.v1",
            "frameId": frame_id,
            "timestamp": timestamp,
            "direction": direction,
            "transport": "stdio_jsonl",
            "provider": self.provider,
            "byteLength": raw.len(),
            "digest": format!("sha256:{:x}", Sha256::digest(raw)),
            "rawBase64": base64::engine::general_purpose::STANDARD.encode(raw),
        }));
        Some(frame_id)
    }

    fn interpretation(
        &mut self,
        frame_id: u64,
        stage: &str,
        rule_id: &str,
        disposition: &str,
        emitted_event_ids: Vec<String>,
        dropped_fields: Vec<String>,
        reason: &str,
    ) {
        let field_mappings = dropped_fields
            .iter()
            .map(|path| {
                json!({
                    "inputPath": path,
                    "action": "dropped",
                    "reason": reason,
                })
            })
            .collect::<Vec<_>>();
        self.send_record(json!({
            "kind": "interpretation",
            "schema": "paperclip.provider_trace_interpretation.v1",
            "frameId": frame_id,
            "stage": stage,
            "ruleId": rule_id,
            "disposition": disposition,
            "emittedEventIds": emitted_event_ids,
            "droppedFields": dropped_fields,
            "fieldMappings": field_mappings,
            "reason": reason,
        }));
    }

    fn finish(&mut self) {
        if self.sender.is_none() && self.writer.is_none() {
            return;
        }
        let writer_reason = self
            .writer_error
            .lock()
            .ok()
            .and_then(|value| value.clone());
        let reason = self.incomplete_reason.clone().or(writer_reason);
        let status = if reason.is_some() {
            "incomplete"
        } else if self.truncated {
            "truncated"
        } else {
            "complete"
        };
        let acknowledged_debug_sequence = self.next_debug_sequence.saturating_sub(1);
        self.send_record(json!({
            "kind": "trace_status",
            "status": status,
            "acknowledgedDebugSequence": acknowledged_debug_sequence,
            "reason": reason.or_else(|| self.truncated.then(|| "provider_trace_max_bytes_exceeded".to_owned())),
        }));
        self.sender.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

impl Drop for ProviderTraceSink {
    fn drop(&mut self) {
        self.finish();
    }
}

fn default_collaboration_mode() -> String {
    "default".to_owned()
}

fn default_collaboration_mode_instructions() -> bool {
    true
}

fn isolated_thread_config(
    include_collaboration_mode_instructions: bool,
    include_skill_instructions: bool,
) -> Value {
    json!({
        "skills.include_instructions": include_skill_instructions,
        "include_apps_instructions": false,
        "include_collaboration_mode_instructions": include_collaboration_mode_instructions,
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
    #[serde(default = "default_codex_approval_policy")]
    pub approval_policy: String,
    pub instructions: String,
    #[serde(default = "default_collaboration_mode")]
    pub collaboration_mode: String,
    #[serde(default = "default_collaboration_mode_instructions")]
    pub include_collaboration_mode_instructions: bool,
    #[serde(default)]
    pub include_skill_instructions: bool,
    #[serde(default)]
    pub runtime_context: Option<Value>,
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
    pub instructions: String,
    #[serde(default)]
    pub runtime_context: Option<Value>,
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
    pub context_bucket: String,
    pub context_prefix: String,
    pub context_kms_key_arn: String,
    pub qualification_revision: String,
    pub event_expiry_days: u16,
    pub max_estimated_session_cost_usd: f64,
    pub max_iterations: u32,
    pub max_output_tokens: u32,
    pub timeout_seconds: u32,
    pub instructions: String,
    #[serde(default)]
    pub runtime_context: Option<Value>,
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
    #[serde(default = "default_legacy_acpx_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub permission_mode_pinned: bool,
    #[serde(default)]
    pub runtime_context: Option<Value>,
}

fn default_codex_approval_policy() -> String {
    "never".to_owned()
}

fn default_legacy_acpx_permission_mode() -> String {
    "approve-reads".to_owned()
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
    /// PID of a provider-owned child below the primary runtime process, when
    /// the provider has a stable child identity to report. This is metadata,
    /// never an ownership or authorization boundary.
    fn agent_process_id(&self) -> Option<u32> {
        None
    }
    fn session_identity(&self) -> &str;
    fn provider_session_id(&self) -> Option<&str>;
    fn durable_session_identity(&self) -> Option<ProviderSessionIdentity> {
        None
    }
    fn durable_event_cursor(&self) -> Option<&str> {
        None
    }
    fn take_provider_trace_frame_id(&mut self) -> Option<u64> {
        None
    }
    fn record_provider_trace_interpretation(
        &mut self,
        _frame_id: u64,
        _stage: &str,
        _rule_id: &str,
        _disposition: &str,
        _emitted_event_ids: Vec<String>,
        _dropped_fields: Vec<String>,
        _reason: &str,
    ) {
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
    fn steer_turn(&mut self, _turn_id: &str, _message: &str) -> Result<Value, LocalRunnerError> {
        Err(LocalRunnerError::invalid(
            "provider does not support same-turn steering",
        ))
    }
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
        request: Value,
    },
    Exited,
}

pub struct CodexProvider {
    kind: ProviderKind,
    process: SupervisedProcess,
    next_request_id: u64,
    thread_id: String,
    session_id: Option<String>,
    active_provider_turn_id: Option<String>,
    pending_messages: VecDeque<(Value, Option<u64>)>,
    pending_tool_requests: BTreeMap<String, Value>,
    pending_runtime_requests: BTreeMap<String, PendingCodexRuntimeRequest>,
    collaboration_mode: String,
    collaboration_mode_payload: Option<Value>,
    structured_permission_profile: bool,
    trace: Option<ProviderTraceSink>,
    last_trace_frame_id: Option<u64>,
}

#[derive(Clone, Debug)]
struct PendingCodexRuntimeRequest {
    rpc_id: Value,
    method: String,
    provider_params: Value,
    question_set: Value,
}

fn permission_profile_params(profile_id: &str, structured: bool) -> Value {
    if structured {
        json!({"type": "profile", "id": profile_id})
    } else {
        json!(profile_id)
    }
}

fn requires_structured_permission_profile(error: &LocalRunnerError) -> bool {
    let detail = error.to_string();
    detail.contains("invalid type: string") && detail.contains("PermissionProfileSelectionParams")
}

fn latest_active_provider_turn_id(thread_read: &Value) -> Option<String> {
    thread_read
        .pointer("/thread/turns")
        .and_then(Value::as_array)
        .and_then(|turns| {
            turns.iter().rev().find_map(|turn| {
                let status = turn.get("status").and_then(Value::as_str)?;
                if matches!(status, "inProgress" | "in_progress" | "running" | "active") {
                    turn.get("id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                } else {
                    None
                }
            })
        })
}

fn runtime_request_kind(method: &str) -> Option<&'static str> {
    match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => Some("command_approval"),
        "item/fileChange/requestApproval" | "applyPatchApproval" => Some("file_approval"),
        "item/permissions/requestApproval" => Some("permission_approval"),
        "item/tool/requestUserInput" | "tool/requestUserInput" => Some("user_input"),
        "mcpServer/elicitation/request" => Some("elicitation"),
        "paperclip/runtimeRequest" => Some("runtime"),
        _ => None,
    }
}

fn bounded_string(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn codex_question_set(method: &str, params: &Value) -> Option<Value> {
    if matches!(
        method,
        "item/tool/requestUserInput" | "tool/requestUserInput"
    ) {
        let raw_questions = params.get("questions")?.as_array()?;
        if raw_questions.is_empty() {
            return None;
        }
        let questions = raw_questions
            .iter()
            .take(64)
            .enumerate()
            .map(|(question_index, question)| {
                let question_id = question
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(|value| bounded_string(value, 160))
                    .unwrap_or_else(|| format!("question-{}", question_index + 1));
                let options = question
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .take(128)
                            .enumerate()
                            .map(|(option_index, option)| {
                                let option_id = option
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.is_empty())
                                    .map(|value| bounded_string(value, 160))
                                    .unwrap_or_else(|| format!("option-{}", option_index + 1));
                                let label = option
                                    .get("label")
                                    .or_else(|| option.get("value"))
                                    .and_then(Value::as_str)
                                    .or_else(|| option.as_str())
                                    .map(|value| bounded_string(value, 1_000))
                                    .unwrap_or_else(|| format!("Option {}", option_index + 1));
                                let mut normalized = json!({
                                    "id": option_id,
                                    "label": label,
                                });
                                if let Some(description) =
                                    option.get("description").and_then(Value::as_str)
                                {
                                    normalized["description"] =
                                        json!(bounded_string(description, 4_000));
                                }
                                normalized
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let mut normalized = json!({
                    "id": question_id,
                    "prompt": bounded_string(
                        question.get("question")
                            .or_else(|| question.get("prompt"))
                            .and_then(Value::as_str)
                            .unwrap_or("Question"),
                        4_000,
                    ),
                    "required": question.get("required").and_then(Value::as_bool).unwrap_or(false),
                    "answerMode": if options.is_empty() {
                        "text"
                    } else if question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false)
                        || question.get("multiple").and_then(Value::as_bool).unwrap_or(false) {
                        "multi_select"
                    } else {
                        "single_select"
                    },
                });
                if let Some(header) = question.get("header").and_then(Value::as_str) {
                    normalized["header"] = json!(bounded_string(header, 1_000));
                }
                if let Some(description) = question.get("description").and_then(Value::as_str) {
                    normalized["helpText"] = json!(bounded_string(description, 4_000));
                }
                if !options.is_empty() {
                    normalized["options"] = json!(options);
                } else if question.get("minLength").is_some() || question.get("maxLength").is_some()
                {
                    let mut validation = serde_json::Map::new();
                    if let Some(value) = question.get("minLength").and_then(Value::as_u64) {
                        validation.insert("minLength".to_owned(), json!(value));
                    }
                    if let Some(value) = question.get("maxLength").and_then(Value::as_u64) {
                        validation.insert("maxLength".to_owned(), json!(value));
                    }
                    if !validation.is_empty() {
                        normalized["textValidation"] = Value::Object(validation);
                    }
                }
                if question
                    .get("isOther")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || question
                        .get("allowOther")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    normalized["customAnswer"] = json!({
                        "enabled": true,
                        "label": "Other",
                        "placeholder": "Enter another answer",
                    });
                }
                normalized
            })
            .collect::<Vec<_>>();
        return Some(json!({
            "schema": "paperclip.question_set.v1",
            "title": params.get("title").and_then(Value::as_str).unwrap_or("Codex needs your input"),
            "submitLabel": params.get("submitLabel").and_then(Value::as_str).unwrap_or("Submit answers"),
            "questions": questions,
        }));
    }
    if method == "mcpServer/elicitation/request" {
        let requested_schema = params
            .get("requestedSchema")
            .or_else(|| params.get("schema"))?;
        let properties = requested_schema.get("properties")?.as_object()?;
        if properties.is_empty() {
            return None;
        }
        let required = requested_schema
            .get("required")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let questions = properties
            .iter()
            .take(64)
            .map(|(name, property)| {
                let property_type = property.get("type").and_then(Value::as_str).unwrap_or("string");
                let select_schema = if property_type == "array" {
                    property.get("items").unwrap_or(&Value::Null)
                } else {
                    property
                };
                let option_values = select_schema.get("enum").and_then(Value::as_array).cloned()
                    .or_else(|| select_schema.get("oneOf").and_then(Value::as_array).map(|entries| entries.iter().map(|entry| entry.get("const").cloned().unwrap_or(Value::Null)).collect()))
                    .unwrap_or_default();
                let options = if property_type == "boolean" {
                    vec![json!({"id":"true","label":"Yes"}), json!({"id":"false","label":"No"})]
                } else {
                    option_values.iter().enumerate().map(|(index, value)| {
                        let one_of = select_schema.get("oneOf").and_then(Value::as_array).and_then(|items| items.get(index));
                        let mut option = json!({
                            "id": format!("option-{}", index + 1),
                            "label": one_of.and_then(|item| item.get("title")).and_then(Value::as_str)
                                .map(str::to_owned).unwrap_or_else(|| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())),
                        });
                        if let Some(description) = one_of
                            .and_then(|item| item.get("description"))
                            .and_then(Value::as_str)
                        {
                            option["description"] = json!(bounded_string(description, 4_000));
                        }
                        option
                    }).collect::<Vec<_>>()
                };
                let answer_mode = if property_type == "array" && !options.is_empty() {
                    "multi_select"
                } else if !options.is_empty() {
                    "single_select"
                } else {
                    "text"
                };
                let mut question = json!({
                    "id": name,
                    "prompt": property.get("title").and_then(Value::as_str).unwrap_or(name),
                    "required": required.iter().any(|entry| entry.as_str() == Some(name)),
                    "answerMode": answer_mode,
                });
                if let Some(title) = property.get("title").and_then(Value::as_str) {
                    question["header"] = json!(bounded_string(title, 1_000));
                }
                if let Some(description) = property.get("description").and_then(Value::as_str) {
                    question["helpText"] = json!(bounded_string(description, 4_000));
                }
                if !options.is_empty() {
                    question["options"] = json!(options);
                } else {
                    let mut validation = serde_json::Map::new();
                    validation.insert("inputType".to_owned(), json!(match property_type { "number" => "number", "integer" => "integer", _ => "text" }));
                    for key in ["minLength", "maxLength", "minimum", "maximum", "pattern"] {
                        if let Some(value) = property.get(key) {
                            validation.insert(key.to_owned(), value.clone());
                        }
                    }
                    question["textValidation"] = Value::Object(validation);
                }
                question
            })
            .collect::<Vec<_>>();
        let mut normalized = json!({
            "schema": "paperclip.question_set.v1",
            "title": "A tool needs your input",
            "submitLabel": "Submit",
            "questions": questions,
        });
        if let Some(description) = params.get("message").and_then(Value::as_str) {
            normalized["description"] = json!(bounded_string(description, 4_000));
        }
        return Some(normalized);
    }
    None
}

fn has_codex_question_form(method: &str, params: &Value) -> bool {
    match method {
        "item/tool/requestUserInput" | "tool/requestUserInput" => params.get("questions").is_some(),
        "mcpServer/elicitation/request" => {
            params.get("requestedSchema").is_some() || params.get("schema").is_some()
        }
        _ => false,
    }
}

fn validate_codex_question_set(value: &Value) -> Result<(), LocalRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-set schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|_| LocalRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !validator.is_valid(value) {
        return Err(LocalRunnerError::invalid(
            "provider input request failed the Paperclip question-set schema",
        ));
    }
    let mut question_ids = std::collections::BTreeSet::new();
    for question in value
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let question_id = question
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !question_ids.insert(question_id) {
            return Err(LocalRunnerError::invalid(
                "provider input question ids must be unique",
            ));
        }
        let mut option_ids = std::collections::BTreeSet::new();
        for option in question
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let option_id = option.get("id").and_then(Value::as_str).unwrap_or_default();
            if !option_ids.insert(option_id) {
                return Err(LocalRunnerError::invalid(
                    "provider input option ids must be unique within a question",
                ));
            }
        }
        if let Some(pattern) = question
            .pointer("/textValidation/pattern")
            .and_then(Value::as_str)
        {
            jsonschema::validator_for(&json!({"type": "string", "pattern": pattern})).map_err(
                |_| LocalRunnerError::invalid("provider input contained an invalid text pattern"),
            )?;
        }
    }
    Ok(())
}

fn canonical_runtime_request(
    kind: ProviderKind,
    request_id: &str,
    method: &str,
    params: &Value,
    question_set: &Value,
) -> Value {
    json!({
        "schema": "paperclip.runtime_request.v2",
        "requestKind": "runtime",
        "requestId": request_id,
        "type": "input",
        "status": "pending",
        "prompt": if method == "mcpServer/elicitation/request" { "A tool requests structured user input." } else { "Codex requests user input." },
        "input": question_set,
        "origin": {
            "adapter": if kind == ProviderKind::Opencode { "opencode-app-server-proxy" } else { "codex-app-server" },
            "provider": if kind == ProviderKind::Opencode { "opencode" } else { "codex" },
            "method": method,
        },
        "itemId": params.get("itemId").and_then(Value::as_str).unwrap_or(request_id),
    })
}

fn canonical_codex_answers(question_set: &Value, response: &Value) -> Value {
    let answers = response.get("answers").and_then(Value::as_object);
    let mut native = serde_json::Map::new();
    for question in question_set
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(question_id) = question.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(answer) = answers.and_then(|values| values.get(question_id)) else {
            continue;
        };
        let mut values = Vec::new();
        for selected in answer
            .get("selectedOptionIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(option_id) = selected.as_str() {
                if let Some(label) = question
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))
                    .and_then(|option| option.get("label"))
                    .and_then(Value::as_str)
                {
                    values.push(json!(label));
                }
            }
        }
        if let Some(value) = answer.get("text").and_then(Value::as_str) {
            values.push(json!(value));
        }
        if let Some(value) = answer.get("customText").and_then(Value::as_str) {
            values.push(json!(value));
        }
        native.insert(question_id.to_owned(), json!({"answers": values}));
    }
    Value::Object(native)
}

fn elicitation_option_value(schema: &Value, option_id: &str) -> Value {
    if option_id == "true" {
        return json!(true);
    }
    if option_id == "false" {
        return json!(false);
    }
    let index = option_id
        .strip_prefix("option-")
        .and_then(|value| value.parse::<usize>().ok())
        .and_then(|value| value.checked_sub(1));
    if let Some(index) = index {
        if let Some(value) = schema
            .get("enum")
            .and_then(Value::as_array)
            .and_then(|values| values.get(index))
        {
            return value.clone();
        }
        if let Some(value) = schema
            .get("oneOf")
            .and_then(Value::as_array)
            .and_then(|values| values.get(index))
            .and_then(|entry| entry.get("const"))
        {
            return value.clone();
        }
    }
    json!(option_id)
}

fn canonical_elicitation_content(pending: &PendingCodexRuntimeRequest, response: &Value) -> Value {
    let schema = pending
        .provider_params
        .get("requestedSchema")
        .or_else(|| pending.provider_params.get("schema"))
        .unwrap_or(&Value::Null);
    let properties = schema.get("properties").and_then(Value::as_object);
    let answers = response.get("answers").and_then(Value::as_object);
    let mut content = serde_json::Map::new();
    for question in pending
        .question_set
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(question_id) = question.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(answer) = answers.and_then(|values| values.get(question_id)) else {
            continue;
        };
        let property = properties
            .and_then(|values| values.get(question_id))
            .unwrap_or(&Value::Null);
        let mode = question
            .get("answerMode")
            .and_then(Value::as_str)
            .unwrap_or("text");
        let value = if mode == "text" {
            let raw = answer
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match property.get("type").and_then(Value::as_str) {
                Some("integer") => raw.parse::<i64>().map(Value::from).unwrap_or(Value::Null),
                Some("number") => raw
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                _ => json!(raw),
            }
        } else if mode == "multi_select" {
            let item_schema = property.get("items").unwrap_or(&Value::Null);
            Value::Array(
                answer
                    .get("selectedOptionIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|option_id| elicitation_option_value(item_schema, option_id))
                    .collect(),
            )
        } else if let Some(option_id) = answer
            .get("selectedOptionIds")
            .and_then(Value::as_array)
            .and_then(|values| values.first())
            .and_then(Value::as_str)
        {
            elicitation_option_value(property, option_id)
        } else {
            answer.get("customText").cloned().unwrap_or(Value::Null)
        };
        content.insert(question_id.to_owned(), value);
    }
    Value::Object(content)
}

fn codex_runtime_response(pending: &PendingCodexRuntimeRequest, resolution: &Value) -> Value {
    let action = resolution
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("cancel");
    match pending.method.as_str() {
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            if action == "submit" {
                if let Some(response) = resolution.get("response") {
                    json!({"answers": canonical_codex_answers(&pending.question_set, response)})
                } else {
                    json!({"answers": resolution.get("answers").cloned().unwrap_or_else(|| json!({}))})
                }
            } else {
                json!({"answers": {}})
            }
        }
        "mcpServer/elicitation/request" => {
            if action == "submit" {
                json!({
                    "action": "accept",
                    "content": resolution.get("content").cloned().unwrap_or_else(|| {
                        resolution.get("response").map(|response| canonical_elicitation_content(pending, response)).unwrap_or_else(|| json!({}))
                    }),
                    "_meta": Value::Null,
                })
            } else {
                json!({"action": action, "content": Value::Null, "_meta": Value::Null})
            }
        }
        "paperclip/runtimeRequest" => json!({"resolution": resolution}),
        "item/permissions/requestApproval" => json!({
            "permissions": {},
            "scope": if action == "accept_for_session" { "session" } else { "turn" },
        }),
        _ => json!({
            "decision": match action {
                "accept_for_session" => "acceptForSession",
                "accept" => "accept",
                "decline" => "decline",
                _ => "cancel",
            }
        }),
    }
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
        if !matches!(
            config.approval_policy.as_str(),
            "never" | "on-request" | "untrusted"
        ) {
            return Err(LocalRunnerError::invalid(
                "unsupported Codex approval policy",
            ));
        }
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
            active_provider_turn_id: None,
            pending_messages: VecDeque::new(),
            pending_tool_requests: BTreeMap::new(),
            pending_runtime_requests: BTreeMap::new(),
            collaboration_mode: config.collaboration_mode.clone(),
            collaboration_mode_payload: None,
            structured_permission_profile: false,
            trace: ProviderTraceSink::from_environment(config.kind),
            last_trace_frame_id: None,
        };
        let initialized = provider.request("initialize", json!({
            "clientInfo": { "name": "paperclip-runnerd", "title": "Paperclip Runner", "version": "1" },
            "capabilities": { "experimentalApi": true, "requestAttestation": false }
        }))?;
        provider.send_frame(&json!({"method": "initialized"}))?;
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
        let (open_method, mut open_params) = if let Some(thread_id) = resume_thread_id {
            (
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": config.cwd,
                    "model": config.model,
                    "approvalPolicy": config.approval_policy,
                    "permissions": permission_profile_params(permission_profile, false),
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": isolated_thread_config(
                        config.include_collaboration_mode_instructions,
                        config.include_skill_instructions,
                    ),
                    "baseInstructions": config.instructions,
                    "dynamicTools": dynamic_tools,
                    "experimentalRawEvents": true,
                    "persistExtendedHistory": true,
                }),
            )
        } else {
            (
                "thread/start",
                json!({
                    "cwd": config.cwd,
                    "model": config.model,
                    "approvalPolicy": config.approval_policy,
                    "permissions": permission_profile_params(permission_profile, false),
                    "runtimeWorkspaceRoots": [config.cwd],
                    "config": isolated_thread_config(
                        config.include_collaboration_mode_instructions,
                        config.include_skill_instructions,
                    ),
                    "baseInstructions": config.instructions,
                    "dynamicTools": dynamic_tools,
                    "experimentalRawEvents": true,
                    "persistExtendedHistory": true,
                }),
            )
        };
        let opened = match provider.request(open_method, open_params.clone()) {
            Ok(opened) => opened,
            Err(error) if requires_structured_permission_profile(&error) => {
                open_params["permissions"] = permission_profile_params(permission_profile, true);
                provider.structured_permission_profile = true;
                provider.request(open_method, open_params)?
            }
            Err(error) => return Err(error),
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
        if resume_thread_id.is_some() {
            let recovered = provider.read_thread()?;
            provider.active_provider_turn_id = latest_active_provider_turn_id(&recovered);
        }
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
            "permissions": permission_profile_params(permission_profile, self.structured_permission_profile),
            "runtimeWorkspaceRoots": [cwd],
            "input": [{"type": "text", "text": message, "text_elements": []}],
        });
        if let Some(collaboration_mode) = self.collaboration_mode_payload.clone() {
            params
                .as_object_mut()
                .expect("turn parameters are an object")
                .insert("collaborationMode".to_owned(), collaboration_mode);
        }
        let response = self.request("turn/start", params)?;
        self.active_provider_turn_id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if self.active_provider_turn_id.is_none() {
            return Err(LocalRunnerError::invalid(
                "Codex turn/start omitted turn.id",
            ));
        }
        Ok(response)
    }

    pub fn interrupt_turn(&mut self, _turn_id: &str) -> Result<Value, LocalRunnerError> {
        let thread_id = self.thread_id.clone();
        let provider_turn_id = self
            .active_provider_turn_id
            .clone()
            .ok_or_else(|| LocalRunnerError::invalid("Codex has no active provider turn"))?;
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": provider_turn_id }),
        )
    }

    pub fn steer_turn(&mut self, _turn_id: &str, message: &str) -> Result<Value, LocalRunnerError> {
        let thread_id = self.thread_id.clone();
        let provider_turn_id = self
            .active_provider_turn_id
            .clone()
            .ok_or_else(|| LocalRunnerError::invalid("Codex has no active provider turn"))?;
        self.request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": provider_turn_id,
                "input": [{"type": "text", "text": message, "text_elements": []}],
            }),
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
        let (message, frame_id) = if let Some(message) = self.pending_messages.pop_front() {
            message
        } else {
            let Some(line) = self.receive_stdout_line(Duration::from_millis(1))? else {
                return if self.process.try_wait()?.is_some() {
                    Ok(Some(ProviderEvent::Exited))
                } else {
                    Ok(None)
                };
            };
            let frame_id = self.trace_inbound(&line);
            let message = serde_json::from_str(&line).map_err(|error| {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.invalid",
                        "rejected",
                        Vec::new(),
                        Vec::new(),
                        "Provider frame was not valid JSON-RPC",
                    );
                }
                LocalRunnerError::invalid(format!("Codex emitted invalid JSON-RPC: {error}"))
            })?;
            (message, frame_id)
        };
        self.last_trace_frame_id = frame_id;
        if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), frame_id) {
            let method = message.get("method").and_then(Value::as_str);
            let disposition = if method.is_some() {
                "mapped"
            } else {
                "ignored"
            };
            trace.interpretation(
                frame_id,
                "rust_jsonrpc_parse",
                method
                    .map(|value| {
                        if value == "item/tool/call" {
                            "codex.tool_call"
                        } else if runtime_request_kind(value).is_some() {
                            "provider.runtime_request"
                        } else {
                            "codex.notification"
                        }
                    })
                    .unwrap_or("codex.unroutable"),
                disposition,
                Vec::new(),
                Vec::new(),
                if method.is_some() {
                    "JSON-RPC frame parsed and routed to provider normalization"
                } else {
                    "JSON-RPC frame had no routable method"
                },
            );
        }
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
        if let (Some(rpc_id), Some(method)) = (
            message.get("id").cloned(),
            message.get("method").and_then(Value::as_str),
        ) {
            if let Some(request_kind) = runtime_request_kind(method) {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if method != "paperclip/runtimeRequest"
                    && params.get("threadId").and_then(Value::as_str)
                        != Some(self.thread_id.as_str())
                {
                    return Err(LocalRunnerError::invalid(
                        "provider runtime request named another thread",
                    ));
                }
                let request_id = params
                    .pointer("/request/requestId")
                    .or_else(|| params.get("requestId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        rpc_id
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| rpc_id.to_string())
                    });
                if self.pending_runtime_requests.contains_key(&request_id) {
                    return Err(LocalRunnerError::invalid(
                        "provider reused a pending runtime request id",
                    ));
                }
                let native_question_set = codex_question_set(method, &params);
                if native_question_set.is_none() && has_codex_question_form(method, &params) {
                    return Err(LocalRunnerError::invalid(
                        "provider input request contained an unsupported question form",
                    ));
                }
                let question_set = native_question_set
                    .or_else(|| params.pointer("/request/input").cloned())
                    .unwrap_or(Value::Null);
                if !question_set.is_null() {
                    validate_codex_question_set(&question_set)?;
                }
                let request = params.get("request").cloned().unwrap_or_else(|| {
                    if !question_set.is_null() {
                        canonical_runtime_request(self.kind, &request_id, method, &params, &question_set)
                    } else {
                        json!({
                            "schema": "paperclip.runtime_request.v1",
                            "requestKind": "runtime",
                            "requestId": request_id,
                            "type": "permission",
                            "status": "pending",
                            "prompt": params.get("reason").or_else(|| params.get("message")).and_then(Value::as_str)
                                .unwrap_or("The provider requests runtime approval."),
                            "origin": {
                                "adapter": if self.kind == ProviderKind::Opencode { "opencode-app-server-proxy" } else { "codex-app-server" },
                                "provider": if self.kind == ProviderKind::Opencode { "opencode" } else { "codex" },
                                "method": method,
                                "kind": request_kind,
                            }
                        })
                    }
                });
                self.pending_runtime_requests.insert(
                    request_id,
                    PendingCodexRuntimeRequest {
                        rpc_id,
                        method: method.to_owned(),
                        provider_params: params,
                        question_set,
                    },
                );
                return Ok(Some(ProviderEvent::RuntimeRequest { request }));
            }
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
        self.send_frame(&json!({
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
        let result = self.process.terminate_group().map(|_| ());
        if let Some(trace) = self.trace.as_mut() {
            trace.finish();
        }
        result
    }

    fn send_frame(&mut self, value: &Value) -> Result<(), LocalRunnerError> {
        if let Some(trace) = self.trace.as_mut() {
            let raw = serde_json::to_vec(value).unwrap_or_default();
            if let Some(frame_id) = trace.frame("client_to_provider", &raw) {
                trace.interpretation(
                    frame_id,
                    "rust_native_transport",
                    "codex.jsonrpc.outbound",
                    "operator_only",
                    Vec::new(),
                    Vec::new(),
                    "Outbound provider command does not enter the canonical PRP outbox",
                );
            }
        }
        self.process.send(value)
    }

    fn trace_inbound(&mut self, line: &str) -> Option<u64> {
        self.trace
            .as_mut()
            .and_then(|trace| trace.frame("provider_to_client", line.as_bytes()))
    }

    fn receive_stdout_line(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<String>, LocalRunnerError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.process.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(line)) => {
                    if let Some(trace) = self.trace.as_mut() {
                        if let Some(frame_id) = trace.frame("provider_stderr", line.as_bytes()) {
                            trace.interpretation(
                                frame_id,
                                "rust_native_transport",
                                "provider.stderr",
                                "operator_only",
                                Vec::new(),
                                Vec::new(),
                                "Provider stderr is retained only in the restricted trace sidecar",
                            );
                        }
                    }
                }
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(message))
                }
                Ok(ProcessOutput::StdoutClosed) => return Ok(None),
                Ok(ProcessOutput::StderrClosed) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(LocalRunnerError::invalid("process output channel closed"))
                }
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, LocalRunnerError> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send_frame(&json!({"id": id, "method": method, "params": params}))?;
        loop {
            let line = self
                .receive_stdout_line(Duration::from_secs(30))?
                .ok_or_else(|| {
                    LocalRunnerError::invalid(format!("Codex {method} response timed out"))
                })?;
            let frame_id = self.trace_inbound(&line);
            let message: Value = serde_json::from_str(&line).map_err(|error| {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.invalid",
                        "rejected",
                        Vec::new(),
                        Vec::new(),
                        "Provider frame was not valid JSON-RPC",
                    );
                }
                LocalRunnerError::invalid(format!("Codex emitted invalid JSON-RPC: {error}"))
            })?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.response",
                        "operator_only",
                        Vec::new(),
                        Vec::new(),
                        "Matched synchronous app-server response",
                    );
                }
                if let Some(error) = message.get("error") {
                    return Err(LocalRunnerError::invalid(format!(
                        "Codex {method} failed: {error}"
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            self.pending_messages.push_back((message, frame_id));
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
    fn take_provider_trace_frame_id(&mut self) -> Option<u64> {
        self.last_trace_frame_id.take()
    }
    fn record_provider_trace_interpretation(
        &mut self,
        frame_id: u64,
        stage: &str,
        rule_id: &str,
        disposition: &str,
        emitted_event_ids: Vec<String>,
        dropped_fields: Vec<String>,
        reason: &str,
    ) {
        if let Some(trace) = self.trace.as_mut() {
            trace.interpretation(
                frame_id,
                stage,
                rule_id,
                disposition,
                emitted_event_ids,
                dropped_fields,
                reason,
            );
        }
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
    fn steer_turn(&mut self, turn_id: &str, message: &str) -> Result<Value, LocalRunnerError> {
        CodexProvider::steer_turn(self, turn_id, message)
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
    fn resolve_runtime_request(
        &mut self,
        request_id: &str,
        _turn_id: &str,
        resolution: &Value,
    ) -> Result<(), LocalRunnerError> {
        let pending = self
            .pending_runtime_requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| {
                LocalRunnerError::invalid("runtime request has no pending JSON-RPC request")
            })?;
        let result = codex_runtime_response(&pending, resolution);
        self.send_frame(&json!({"id": pending.rpc_id, "result": result}))?;
        self.pending_runtime_requests.remove(request_id);
        Ok(())
    }
    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        CodexProvider::shutdown(self)
    }
}

#[cfg(test)]
mod provider_trace_tests {
    use super::*;

    #[test]
    fn normalizes_and_answers_the_dot_185_three_question_frame() {
        let question_set = codex_question_set(
            "item/tool/requestUserInput",
            &json!({
                "title": "Implementation choices",
                "questions": [
                    {"id":"scope","header":"Scope","question":"Which scope?","options":[{"label":"Focused"},{"label":"Broad"}]},
                    {"id":"compatibility","header":"Compatibility","question":"Keep v1?","options":[{"label":"Yes"},{"label":"No"}]},
                    {"id":"notes","header":"Notes","question":"Anything else?"}
                ]
            }),
        )
        .unwrap();
        assert_eq!(question_set["questions"].as_array().unwrap().len(), 3);
        assert_eq!(question_set["questions"][0]["required"], false);
        assert_eq!(
            question_set["questions"][0]["options"][0]["label"],
            "Focused"
        );

        let response = json!({
            "schema": "paperclip.question_response.v1",
            "answers": {
                "scope": {"selectedOptionIds":["option-1"]},
                "compatibility": {"selectedOptionIds":["option-1"]},
                "notes": {"text":"Preserve the shared UI."}
            }
        });
        assert_eq!(
            canonical_codex_answers(&question_set, &response),
            json!({
                "scope": {"answers":["Focused"]},
                "compatibility": {"answers":["Yes"]},
                "notes": {"answers":["Preserve the shared UI."]}
            })
        );
    }

    #[test]
    fn mcp_form_normalization_omits_absent_optional_values() {
        let question_set = codex_question_set(
            "mcpServer/elicitation/request",
            &json!({
                "requestedSchema": {
                    "type": "object",
                    "properties": {"notes": {"type": "string"}}
                }
            }),
        )
        .unwrap();
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../protocol/schemas/question-set.schema.json"
        ))
        .unwrap();
        assert!(jsonschema::validator_for(&schema)
            .unwrap()
            .is_valid(&question_set));
        assert!(question_set["questions"][0].get("header").is_none());
        assert!(question_set.get("description").is_none());
    }

    #[test]
    fn recovers_the_latest_active_codex_turn_from_thread_read() {
        assert_eq!(
            latest_active_provider_turn_id(&json!({
                "thread": {
                    "turns": [
                        {"id": "turn-complete", "status": "completed"},
                        {"id": "turn-active", "status": "inProgress"}
                    ]
                }
            })),
            Some("turn-active".to_owned())
        );
        assert_eq!(
            latest_active_provider_turn_id(&json!({
                "thread": {"turns": [{"id": "turn-complete", "status": "completed"}]}
            })),
            None
        );
    }

    #[test]
    fn collaboration_instructions_default_on_and_allow_explicit_opt_out() {
        let default_config: LocalProviderConfig = serde_json::from_value(json!({
            "kind": "codex",
            "command": "codex",
            "args": [],
            "cwd": "/workspace",
            "model": null,
            "instructions": "Run the task.",
            "collaborationMode": "default"
        }))
        .unwrap();
        assert_eq!(default_config.approval_policy, "never");
        assert!(default_config.include_collaboration_mode_instructions);
        assert_eq!(
            isolated_thread_config(
                default_config.include_collaboration_mode_instructions,
                default_config.include_skill_instructions,
            )["include_collaboration_mode_instructions"],
            json!(true)
        );

        let opt_out_config: LocalProviderConfig = serde_json::from_value(json!({
            "kind": "codex",
            "command": "codex",
            "args": [],
            "cwd": "/workspace",
            "model": null,
            "instructions": "Run the eval fixture.",
            "collaborationMode": "default",
            "includeCollaborationModeInstructions": false
        }))
        .unwrap();
        assert!(!opt_out_config.include_collaboration_mode_instructions);
        assert_eq!(
            isolated_thread_config(
                opt_out_config.include_collaboration_mode_instructions,
                opt_out_config.include_skill_instructions,
            )["include_collaboration_mode_instructions"],
            json!(false)
        );
    }

    #[test]
    fn provider_trace_preserves_exact_bytes_order_digest_and_interpretation() {
        let trace_path = std::env::temp_dir().join(format!(
            "paperclip-provider-trace-{}.ndjson",
            uuid::Uuid::new_v4()
        ));
        let first = br#"{"id":1,"method":"thread/start"}"#;
        let second = br#"{"method":"item/completed","params":{"item":{"type":"agentMessage"}}}"#;
        let mut trace = ProviderTraceSink::at_path(
            trace_path.clone(),
            DEFAULT_PROVIDER_TRACE_MAX_BYTES,
            ProviderKind::Codex,
        );

        let first_id = trace.frame("client_to_provider", first).unwrap();
        let second_id = trace.frame("provider_to_client", second).unwrap();
        trace.interpretation(
            second_id,
            "rust_jsonrpc_parse",
            "codex.notification",
            "mapped",
            vec!["event_runner_000001".to_owned()],
            Vec::new(),
            "mapped for test",
        );
        trace.finish();

        let entries = fs::read_to_string(&trace_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let frames = entries
            .iter()
            .filter(|entry| entry["kind"] == "frame")
            .collect::<Vec<_>>();
        assert_eq!((first_id, second_id), (1, 2));
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(frames[0]["rawBase64"].as_str().unwrap())
                .unwrap(),
            first
        );
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(frames[1]["rawBase64"].as_str().unwrap())
                .unwrap(),
            second
        );
        assert_eq!(
            frames[1]["digest"],
            format!("sha256:{:x}", Sha256::digest(second))
        );
        assert_eq!(entries[0]["debugSequence"], 1);
        assert_eq!(entries[1]["debugSequence"], 2);
        assert_eq!(entries[2]["debugSequence"], 3);
        assert_eq!(entries[2]["emittedEventIds"][0], "event_runner_000001");
        assert_eq!(entries.last().unwrap()["status"], "complete");
        assert_eq!(
            entries.last().unwrap()["acknowledgedDebugSequence"],
            entries.len() - 1
        );

        let _ = fs::remove_file(trace_path);
    }

    #[test]
    fn provider_trace_truncation_does_not_accept_bytes_past_the_cap() {
        let trace_path = std::env::temp_dir().join(format!(
            "paperclip-provider-trace-{}.ndjson",
            uuid::Uuid::new_v4()
        ));
        let mut trace = ProviderTraceSink::at_path(trace_path.clone(), 4, ProviderKind::Codex);
        assert!(trace.frame("provider_to_client", b"12345").is_none());
        trace.finish();

        let content = fs::read_to_string(&trace_path).unwrap();
        assert!(!content.contains("rawBase64"));
        assert!(content.contains("\"status\":\"truncated\""));
        assert!(content.contains("provider_trace_max_bytes_exceeded"));

        let _ = fs::remove_file(trace_path);
    }
}
