use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TOOL_SET_SCHEMA: &str = "paperclip.runner.authorized-tools.v1";
pub const TOOL_CALL_SCHEMA: &str = "paperclip.prp.semantic_tool.v1";
pub const TOOL_RESULT_COMMAND: &str = "semantic_tool.result";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedTool {
    pub operation_id: String,
    pub version: u64,
    pub description: String,
    pub input_schema: Value,
    pub response_schema: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedToolSet {
    pub schema: String,
    pub schema_version: u64,
    pub catalog_digest: String,
    pub operations: Vec<AuthorizedTool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCall {
    pub call_id: String,
    pub operation_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub operation_id: String,
    pub result: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolBridge {
    authorized: BTreeMap<String, AuthorizedTool>,
    catalog_digest: Option<String>,
    pending: BTreeMap<String, PendingToolCall>,
    completed: BTreeMap<String, ToolResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBridgeError(String);

impl ProviderBridgeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ProviderBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProviderBridgeError {}

impl ProviderToolBridge {
    pub fn prepare(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        self.prepare_internal(tool_set, false)
    }

    pub fn attach_run(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot attach a new run while provider tool calls are pending",
            ));
        }
        self.prepare_internal(tool_set, true)?;
        self.completed.clear();
        Ok(())
    }

    pub fn attach_existing_run(&mut self) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot attach a new run while provider tool calls are pending",
            ));
        }
        self.completed.clear();
        Ok(())
    }

    fn prepare_internal(
        &mut self,
        tool_set: AuthorizedToolSet,
        allow_catalog_change: bool,
    ) -> Result<(), ProviderBridgeError> {
        if tool_set.schema != TOOL_SET_SCHEMA || tool_set.schema_version != 1 {
            return Err(ProviderBridgeError::invalid(
                "unsupported authorized tool-set contract",
            ));
        }
        if !tool_set.catalog_digest.starts_with("sha256:") {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set requires a sha256 catalog digest",
            ));
        }
        let mut names = BTreeSet::new();
        for tool in &tool_set.operations {
            validate_operation_id(&tool.operation_id)?;
            if tool.version != 1 {
                return Err(ProviderBridgeError::invalid(format!(
                    "unsupported tool version for {}",
                    tool.operation_id
                )));
            }
            if tool.description.is_empty()
                || !tool.input_schema.is_object()
                || !tool.response_schema.is_object()
            {
                return Err(ProviderBridgeError::invalid(format!(
                    "tool {} has an incomplete provider contract",
                    tool.operation_id
                )));
            }
            if !names.insert(tool.operation_id.clone()) {
                return Err(ProviderBridgeError::invalid(
                    "authorized tool names must be unique",
                ));
            }
        }
        if !allow_catalog_change {
            if let Some(existing) = &self.catalog_digest {
                if existing != &tool_set.catalog_digest {
                    return Err(ProviderBridgeError::invalid(
                        "authorized tool set changed across a durable session",
                    ));
                }
            }
        }
        self.catalog_digest = Some(tool_set.catalog_digest);
        self.authorized = tool_set
            .operations
            .into_iter()
            .map(|tool| (tool.operation_id.clone(), tool))
            .collect();
        Ok(())
    }

    pub fn authorized_tools(&self) -> impl Iterator<Item = &AuthorizedTool> {
        self.authorized.values()
    }

    pub fn begin_call(
        &mut self,
        call_id: String,
        operation_id: String,
        input: Value,
    ) -> Result<PendingToolCall, ProviderBridgeError> {
        if call_id.is_empty() || call_id.len() > 160 {
            return Err(ProviderBridgeError::invalid("tool call id is invalid"));
        }
        if !self.authorized.contains_key(&operation_id) {
            return Err(ProviderBridgeError::invalid(format!(
                "provider requested unauthorized tool {operation_id}"
            )));
        }
        let call = PendingToolCall {
            call_id: call_id.clone(),
            operation_id,
            input,
        };
        if let Some(existing) = self.pending.get(&call_id) {
            return if existing == &call {
                Ok(existing.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate provider tool call",
                ))
            };
        }
        if self.completed.contains_key(&call_id) {
            return Err(ProviderBridgeError::invalid(
                "provider reused a completed tool call id",
            ));
        }
        self.pending.insert(call_id, call.clone());
        Ok(call)
    }

    pub fn apply_result(&mut self, result: ToolResult) -> Result<Value, ProviderBridgeError> {
        if let Some(existing) = self.completed.get(&result.call_id) {
            return if existing == &result {
                Ok(existing.result.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate tool result",
                ))
            };
        }
        let pending = self.pending.get(&result.call_id).ok_or_else(|| {
            ProviderBridgeError::invalid("tool result does not match a pending provider call")
        })?;
        if pending.operation_id != result.operation_id {
            return Err(ProviderBridgeError::invalid(
                "tool result operation does not match its call",
            ));
        }
        self.pending.remove(&result.call_id);
        self.completed
            .insert(result.call_id.clone(), result.clone());
        Ok(result.result)
    }

    pub fn pending_calls(&self) -> impl Iterator<Item = &PendingToolCall> {
        self.pending.values()
    }
}

fn validate_operation_id(value: &str) -> Result<(), ProviderBridgeError> {
    let mut chars = value.chars();
    let first = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let rest = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    });
    if first && rest && value.len() <= 160 {
        Ok(())
    } else {
        Err(ProviderBridgeError::invalid("tool operation id is invalid"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tools(digest: &str) -> AuthorizedToolSet {
        AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: digest.to_owned(),
            operations: vec![AuthorizedTool {
                operation_id: "get_task_context".to_owned(),
                version: 1,
                description: "Read the active task context.".to_owned(),
                input_schema: json!({"type": "object"}),
                response_schema: json!({"type": "object"}),
            }],
        }
    }

    #[test]
    fn forwards_only_authorized_calls_and_correlates_results() {
        let mut bridge = ProviderToolBridge::default();
        bridge.prepare(tools("sha256:catalog-a")).unwrap();
        let call = bridge
            .begin_call(
                "call-1".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();
        assert_eq!(call.operation_id, "get_task_context");
        let value = bridge
            .apply_result(ToolResult {
                call_id: "call-1".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": true}),
            })
            .unwrap();
        assert_eq!(value, json!({"ok": true}));
        assert_eq!(bridge.pending_calls().count(), 0);
    }

    #[test]
    fn rejects_unknown_tools_and_conflicting_duplicate_results() {
        let mut bridge = ProviderToolBridge::default();
        bridge.prepare(tools("sha256:catalog-a")).unwrap();
        assert!(bridge
            .begin_call("call-x".to_owned(), "not_authorized".to_owned(), json!({}))
            .is_err());
        bridge
            .begin_call(
                "call-1".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();
        let result = ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": true}),
        };
        bridge.apply_result(result.clone()).unwrap();
        bridge.apply_result(result).unwrap();
        assert!(bridge
            .apply_result(ToolResult {
                call_id: "call-1".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": false})
            })
            .is_err());
    }

    #[test]
    fn durable_session_refuses_catalog_drift() {
        let mut bridge = ProviderToolBridge::default();
        bridge.prepare(tools("sha256:catalog-a")).unwrap();
        assert!(bridge.prepare(tools("sha256:catalog-b")).is_err());
        let encoded = serde_json::to_string(&bridge).unwrap();
        let recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
        assert_eq!(recovered, bridge);
    }
}
