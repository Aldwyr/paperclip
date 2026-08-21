use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::durable::redact_text;

const MAX_OUTPUT_BYTES: usize = 64 * 1024;

fn text<'a>(value: Option<&'a Value>) -> &'a str {
    value.and_then(Value::as_str).unwrap_or("")
}
fn item(params: &Value) -> &Value {
    params.get("item").unwrap_or(&Value::Null)
}
fn id(value: &str, fallback: &str) -> String {
    let clean: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._:-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(160)
        .collect();
    if clean
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        clean
    } else {
        fallback.to_owned()
    }
}
fn status(value: &str, complete: bool) -> &'static str {
    match value {
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        "interrupted" | "aborted" => "interrupted",
        _ if complete => "completed",
        _ => "running",
    }
}

fn bounded_output(value: &str) -> Value {
    let redacted = redact_text(value);
    let bytes = redacted.as_bytes();
    let start = bytes.len().saturating_sub(MAX_OUTPUT_BYTES);
    let output = String::from_utf8_lossy(&bytes[start..]).into_owned();
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    json!({
        "output": output,
        "outputBytes": bytes.len(),
        "outputTruncated": bytes.len() > MAX_OUTPUT_BYTES,
        "outputDigest": digest,
    })
}

/// Convert native provider notifications into bounded provider-neutral PRP records.
/// Unknown variants remain on the legacy diagnostic stream and are never interpreted from prose.
pub fn canonical_provider_events(method: &str, params: &Value) -> Vec<(String, Value, String)> {
    let item = item(params);
    let kind = text(item.get("type"));
    let item_id = id(text(item.get("id")).trim(), "provider-item");
    let complete = method == "item/completed";
    let mut result = Vec::new();
    let push =
        |result: &mut Vec<(String, Value, String)>, event: &str, payload: Value, item_id: &str| {
            result.push((event.to_owned(), payload, item_id.to_owned()))
        };
    if (method == "item/started" || complete) && kind == "plan" || method == "turn/plan/updated" {
        let steps = params.get("plan").and_then(Value::as_array).map(|values| values.iter().take(256).enumerate().map(|(index, value)| json!({"stepId": format!("step-{}", index + 1), "body": text(value.get("step")).chars().take(4000).collect::<String>(), "status": match text(value.get("status")) { "inProgress" | "in_progress" => "in_progress", "completed" => "completed", "blocked" => "blocked", _ => "pending" }})).collect()).unwrap_or_else(Vec::new);
        push(
            &mut result,
            "plan.updated",
            json!({"schema":"paperclip.plan.updated.v1","planId":item_id,"revision":params.get("revision").and_then(Value::as_u64).unwrap_or(1),"explanation":params.get("explanation").and_then(Value::as_str),"steps":steps,"complete":complete,"syncStatus":if complete {"pending"} else {"streaming"},"documentRevision":Value::Null}),
            &item_id,
        );
    } else if (method == "item/started" || complete)
        && ["commandExecution", "mcpToolCall", "dynamicToolCall"].contains(&kind)
    {
        let transport = match kind {
            "mcpToolCall" => "mcp",
            "dynamicToolCall" => "dynamic",
            _ => "process",
        };
        let mut payload = json!({"schema":"paperclip.tool.execution.v1","executionId":item_id,"transport":transport,"operation":if kind == "commandExecution" {"execute"} else {"unknown"},"name":item.get("tool").or_else(|| item.get("command")).and_then(Value::as_str),"target":Value::Null,"namespace":item.get("server").and_then(Value::as_str),"readOnly":item.get("readOnlyHint").and_then(Value::as_bool),"status":status(text(item.get("status")), complete),"durationMs":item.get("durationMs").and_then(Value::as_u64),"exitCode":item.get("exitCode").and_then(Value::as_i64),"progress":Value::Null});
        if let (Some(object), Value::Object(output)) = (
            payload.as_object_mut(),
            bounded_output(text(
                item.get("aggregatedOutput").or_else(|| item.get("output")),
            )),
        ) {
            object.extend(output);
        }
        push(
            &mut result,
            if complete {
                "tool.execution.completed"
            } else {
                "tool.execution.started"
            },
            payload,
            &item_id,
        );
    } else if (method == "item/started" || complete) && kind == "webSearch" {
        let action = item.get("action").unwrap_or(&Value::Null);
        let action_kind = match text(action.get("type")) {
            "search" => "search",
            "openPage" => "open_page",
            "findInPage" => "find_in_page",
            _ => "other",
        };
        let url = text(action.get("url"));
        push(
            &mut result,
            if complete {
                "research.completed"
            } else {
                "research.started"
            },
            json!({"schema":"paperclip.research.v1","researchId":item_id,"action":action_kind,"status":if complete {"completed"} else {"running"},"query":item.get("query").or_else(|| action.get("query")).and_then(Value::as_str),"url":if url.starts_with("http://") || url.starts_with("https://") {Value::String(url.to_owned())} else {Value::Null},"pattern":action.get("pattern").and_then(Value::as_str),"sources":[]}),
            &item_id,
        );
    } else if (method == "item/started" || complete)
        && ["collabAgentToolCall", "subAgentActivity"].contains(&kind)
    {
        push(
            &mut result,
            if complete {
                "delegation.completed"
            } else {
                "delegation.started"
            },
            json!({"schema":"paperclip.delegation.v1","delegationId":item_id,"action":"spawn","status":if complete {"completed"} else {"running"},"children":[]}),
            &item_id,
        );
    } else if method == "thread/compacted"
        || ((method == "item/started" || complete) && kind == "contextCompaction")
    {
        push(
            &mut result,
            "context.compacted",
            json!({"schema":"paperclip.context.compacted.v1","compactionId":item_id,"reason":"provider","preTokens":Value::Null,"postTokens":Value::Null,"sameSession":true}),
            &item_id,
        );
    } else if method == "model/rerouted" {
        push(
            &mut result,
            "model.route.changed",
            json!({"schema":"paperclip.model.route_changed.v1","routeId":id(text(params.get("turnId")),"model-route"),"provider":"openai","requestedModel":text(params.get("fromModel")),"fromModel":params.get("fromModel").and_then(Value::as_str),"effectiveModel":text(params.get("toModel")),"reason":text(params.get("reason"))}),
            &item_id,
        );
    } else if method == "model/verification" || method == "model/safetyBuffering/updated" {
        let buffering = params
            .get("showBufferingUi")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        push(
            &mut result,
            "model.verification.updated",
            json!({"schema":"paperclip.model.verification.v1","verificationId":id(text(params.get("turnId")),"model-verification"),"status":if buffering {"running"} else {"completed"},"classes":[],"buffering":buffering,"summary":Value::Null}),
            &item_id,
        );
    } else if (method == "item/started" || complete) && kind == "imageView" {
        push(
            &mut result,
            "artifact.viewed",
            json!({"schema":"paperclip.artifact.viewed.v1","artifactId":item_id,"reference":Value::Null,"mediaType":"image/*","title":Value::Null}),
            &item_id,
        );
    } else if (method == "item/started" || complete) && kind == "imageGeneration" {
        push(
            &mut result,
            "artifact.generated",
            json!({"schema":"paperclip.artifact.generated.v1","artifactId":item_id,"status":if complete {"completed"} else {"running"},"reference":Value::Null,"mediaType":"image/*","registered":false,"transparentBackground":item.get("transparentBackground").and_then(Value::as_bool),"failure":Value::Null}),
            &item_id,
        );
    } else if (method == "item/started" || complete)
        && (kind == "enteredReviewMode" || kind == "exitedReviewMode")
    {
        push(
            &mut result,
            "review.mode.changed",
            json!({"schema":"paperclip.review.mode_changed.v1","reviewId":item_id,"state":if kind == "enteredReviewMode" {"entered"} else {"exited"},"scope":Value::Null}),
            &item_id,
        );
    } else if method == "hook/started" || method == "hook/completed" {
        let run = params.get("run").unwrap_or(&Value::Null);
        let hook_id = id(text(run.get("id")), "hook");
        push(
            &mut result,
            if method.ends_with("started") {
                "hook.started"
            } else {
                "hook.completed"
            },
            json!({"schema":"paperclip.hook.v1","hookId":hook_id,"event":text(run.get("eventName")),"scope":text(run.get("scope")),"status":if method.ends_with("started") {"running"} else {"completed"},"blocking":text(run.get("executionMode")) == "blocking","durationMs":run.get("durationMs").and_then(Value::as_u64),"summary":run.get("statusMessage").and_then(Value::as_str)}),
            &hook_id,
        );
    } else if complete && kind == "agentMessage" && item.get("memoryCitation").is_some() {
        let entries = item
            .get("memoryCitation")
            .and_then(|citation| citation.get("entries"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, entry) in entries.iter().take(64).enumerate() {
            let citation_id = format!("{item_id}:citation:{}", index + 1);
            push(
                &mut result,
                "memory.citation.referenced",
                json!({"schema":"paperclip.memory.citation.v1","citationId":citation_id,"messageItemId":item_id,"label":entry.get("label").and_then(Value::as_str).unwrap_or("Memory source"),"available":false,"reference":Value::Null}),
                &citation_id,
            );
        }
    } else if method == "item/autoApprovalReview/started"
        || method == "item/autoApprovalReview/completed"
    {
        let review_id = id(text(params.get("reviewId")), "safety-review");
        push(
            &mut result,
            if method.ends_with("started") {
                "safety.review.started"
            } else {
                "safety.review.completed"
            },
            json!({"schema":"paperclip.safety.review.v1","reviewId":review_id,"targetExecutionId":params.get("targetItemId").and_then(Value::as_str),"status":if method.ends_with("started") {"running"} else {"completed"},"decision":if method.ends_with("started") {"pending"} else {"unknown"},"summary":Value::Null}),
            &review_id,
        );
    } else if method == "item/commandExecution/terminalInteraction" {
        let execution_id = id(text(params.get("itemId")), "execution");
        push(
            &mut result,
            "terminal.input.sent",
            json!({"schema":"paperclip.terminal.input_sent.v1","executionId":execution_id,"origin":"agent","inputClass":"text","byteCount":text(params.get("stdin")).len()}),
            &execution_id,
        );
    } else if (method == "item/started" || complete) && kind == "sleep" {
        push(
            &mut result,
            if complete {
                "wait.completed"
            } else {
                "wait.started"
            },
            json!({"schema":"paperclip.wait.v1","waitId":item_id,"reason":"timer","status":if complete {"completed"} else {"running"},"plannedDurationMs":item.get("durationMs").and_then(Value::as_u64),"elapsedDurationMs":if complete {item.get("durationMs").and_then(Value::as_u64)} else {None}}),
            &item_id,
        );
    } else if [
        "error",
        "warning",
        "guardianWarning",
        "deprecationNotice",
        "configWarning",
        "windows/worldWritableWarning",
    ]
    .contains(&method)
    {
        let notice_id = id(&format!("{method}:notice"), "provider-notice");
        push(
            &mut result,
            "provider.notice.recorded",
            json!({"schema":"paperclip.provider.notice.v1","noticeId":notice_id,"severity":if method == "error" {"error"} else {"warning"},"category":method.replace('/', "_"),"scope":if method.contains("config") || method.contains("windows") {"environment"} else {"turn"},"recoverable":method != "error","userActionable":method == "error" || method == "warning","summary":text(params.get("message"))}),
            &notice_id,
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_input_never_retains_content() {
        let events = canonical_provider_events(
            "item/commandExecution/terminalInteraction",
            &json!({"itemId":"exec-1","stdin":"Bearer top-secret"}),
        );
        assert_eq!(events[0].0, "terminal.input.sent");
        assert_eq!(events[0].1["byteCount"], 17);
        assert!(!events[0].1.to_string().contains("top-secret"));
    }

    #[test]
    fn command_output_is_redacted_bounded_and_digested() {
        let output = format!("Bearer secret {}", "x".repeat(MAX_OUTPUT_BYTES + 10));
        let events = canonical_provider_events(
            "item/completed",
            &json!({"item":{"id":"exec-1","type":"commandExecution","status":"completed","aggregatedOutput":output}}),
        );
        let payload = &events[0].1;
        assert_eq!(payload["output"], "[REDACTED]");
        assert!(!payload.to_string().contains("secret"));
        assert!(payload["outputDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn maps_memory_citations_without_provider_thread_references() {
        let events = canonical_provider_events(
            "item/completed",
            &json!({"item":{"id":"message-1","type":"agentMessage","memoryCitation":{"entries":[{"label":"Decision","threadId":"native-secret"}]}}}),
        );
        assert_eq!(events[0].0, "memory.citation.referenced");
        assert_eq!(events[0].1["available"], false);
        assert!(!events[0].1.to_string().contains("native-secret"));
    }
}
