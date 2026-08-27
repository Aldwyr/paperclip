use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::durable::redact_text;

const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_TURN_DIFF_FILES: usize = 2_000;
const MAX_TURN_DIFF_CHARS_PER_FILE: usize = 256 * 1024;

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

#[derive(Default)]
struct ParsedDiffFile {
    lines: Vec<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    rename_from: Option<String>,
    rename_to: Option<String>,
    additions: u64,
    deletions: u64,
    binary: bool,
    mode_change: bool,
    in_hunk: bool,
}

fn git_diff_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed == "/dev/null" {
        return None;
    }
    let decoded = if trimmed.starts_with('"') && trimmed.ends_with('"') {
        serde_json::from_str::<String>(trimmed).ok()?
    } else {
        trimmed.to_owned()
    };
    let normalized = decoded.replace('\\', "/");
    let relative = normalized
        .strip_prefix("a/")
        .or_else(|| normalized.strip_prefix("b/"))
        .unwrap_or(&normalized);
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(relative.chars().take(4096).collect())
}

fn git_diff_header_token(value: &str) -> Option<(&str, &str)> {
    let value = value.trim_start();
    if value.starts_with('"') {
        let mut escaped = false;
        for (index, character) in value.char_indices().skip(1) {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                return Some((&value[..=index], &value[index + 1..]));
            }
        }
        return None;
    }
    let end = value.find(char::is_whitespace).unwrap_or(value.len());
    (end > 0).then_some((&value[..end], &value[end..]))
}

fn git_diff_header_paths(value: &str) -> (Option<String>, Option<String>) {
    let Some((old, remaining)) = git_diff_header_token(value) else {
        return (None, None);
    };
    let Some((new, _)) = git_diff_header_token(remaining) else {
        return (None, None);
    };
    (git_diff_path(old), git_diff_path(new))
}

fn finish_diff_file(current: ParsedDiffFile, files: &mut Vec<Value>) {
    if files.len() >= MAX_TURN_DIFF_FILES {
        return;
    }
    let path = current
        .rename_to
        .as_ref()
        .or(current.new_path.as_ref())
        .or(current.old_path.as_ref())
        .cloned();
    let Some(path) = path else { return };
    let previous_path = current
        .rename_from
        .clone()
        .or_else(|| current.rename_to.as_ref().and(current.old_path.clone()));
    let operation = if current.rename_to.is_some() && previous_path.is_some() {
        "rename"
    } else if current.old_path.is_none() {
        "create"
    } else if current.new_path.is_none() {
        "delete"
    } else if current.mode_change && current.additions == 0 && current.deletions == 0 {
        "mode_change"
    } else {
        "modify"
    };
    let patch = format!("{}\n", current.lines.join("\n"));
    files.push(json!({
        "path": path,
        "operation": operation,
        "previousPath": previous_path,
        "additions": if current.binary { Value::Null } else { json!(current.additions) },
        "deletions": if current.binary { Value::Null } else { json!(current.deletions) },
        "binary": current.binary,
        "diff": if current.binary { Value::Null } else { json!(patch.chars().take(MAX_TURN_DIFF_CHARS_PER_FILE).collect::<String>()) },
    }));
}

fn parse_turn_diff(value: &str) -> Vec<Value> {
    let mut files = Vec::new();
    let mut current: Option<ParsedDiffFile> = None;
    for line in value.lines() {
        if line.starts_with("diff --git ") {
            if let Some(previous) = current.take() {
                finish_diff_file(previous, &mut files);
            }
            let (old_path, new_path) = line
                .strip_prefix("diff --git ")
                .map(git_diff_header_paths)
                .unwrap_or((None, None));
            current = Some(ParsedDiffFile {
                lines: vec![line.to_owned()],
                old_path,
                new_path,
                ..ParsedDiffFile::default()
            });
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        file.lines.push(line.to_owned());
        if let Some(path) = line.strip_prefix("--- ") {
            file.old_path = git_diff_path(path);
        } else if let Some(path) = line.strip_prefix("+++ ") {
            file.new_path = git_diff_path(path);
        } else if let Some(path) = line.strip_prefix("rename from ") {
            file.rename_from = git_diff_path(path);
        } else if let Some(path) = line.strip_prefix("rename to ") {
            file.rename_to = git_diff_path(path);
        } else if line.starts_with("old mode ") || line.starts_with("new mode ") {
            file.mode_change = true;
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
        } else if line.starts_with("@@") {
            file.in_hunk = true;
        } else if file.in_hunk && line.starts_with('+') && !line.starts_with("+++") {
            file.additions += 1;
        } else if file.in_hunk && line.starts_with('-') && !line.starts_with("---") {
            file.deletions += 1;
        }
    }
    if let Some(previous) = current {
        finish_diff_file(previous, &mut files);
    }
    files
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
    if method == "turn/diff/updated" {
        let turn_id = id(text(params.get("turnId")).trim(), "turn");
        let patch = text(params.get("diff"));
        let files = parse_turn_diff(patch);
        if patch.trim().is_empty() || !files.is_empty() {
            let known_stats = files.iter().all(|file| {
                file.get("additions").and_then(Value::as_u64).is_some()
                    && file.get("deletions").and_then(Value::as_u64).is_some()
            });
            let additions = known_stats.then(|| {
                files
                    .iter()
                    .filter_map(|file| file.get("additions").and_then(Value::as_u64))
                    .sum::<u64>()
            });
            let deletions = known_stats.then(|| {
                files
                    .iter()
                    .filter_map(|file| file.get("deletions").and_then(Value::as_u64))
                    .sum::<u64>()
            });
            let file_count = files.len();
            let change_set_id = format!("{turn_id}:workspace");
            push(
                &mut result,
                "workspace.change.updated",
                json!({
                    "schema": "paperclip.workspace.diff.v1",
                    "changeSetId": change_set_id,
                    "revision": params.get("revision").and_then(Value::as_u64).unwrap_or(1),
                    "source": "harness_reported",
                    "complete": false,
                    "files": files,
                    "totals": { "files": file_count, "additions": additions, "deletions": deletions },
                    "patchArtifactRef": Value::Null,
                }),
                &change_set_id,
            );
        }
    } else if method == "turn/plan/updated" {
        let turn_plan_id = id(text(params.get("turnId")).trim(), "turn-plan");
        let steps: Vec<Value> = params
            .get("plan")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .take(256)
                    .enumerate()
                    .filter_map(|(index, value)| {
                        let body = text(value.get("step"))
                            .trim()
                            .chars()
                            .take(4000)
                            .collect::<String>();
                        if body.is_empty() {
                            return None;
                        }
                        Some(json!({
                            "stepId": format!("step-{}", index + 1),
                            "body": body,
                            "status": match text(value.get("status")) {
                                "inProgress" | "in_progress" => "in_progress",
                                "completed" => "completed",
                                "blocked" | "failed" | "error" => "blocked",
                                _ => "pending",
                            }
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let plan_complete = !steps.is_empty()
            && steps
                .iter()
                .all(|step| text(step.get("status")) == "completed");
        push(
            &mut result,
            "plan.updated",
            json!({"schema":"paperclip.plan.updated.v1","planId":turn_plan_id,"revision":params.get("revision").and_then(Value::as_u64).unwrap_or(1),"explanation":params.get("explanation").and_then(Value::as_str),"steps":steps,"complete":plan_complete,"syncStatus":"not_applicable","documentRevision":Value::Null}),
            &turn_plan_id,
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
        if let Some(object) = payload.as_object_mut() {
            if item.get("outputBytes").and_then(Value::as_u64).is_some()
                && item
                    .get("outputTruncated")
                    .and_then(Value::as_bool)
                    .is_some()
                && item.get("outputDigest").and_then(Value::as_str).is_some()
            {
                object.insert(
                    "output".to_owned(),
                    item.get("aggregatedOutput").cloned().unwrap_or(Value::Null),
                );
                object.insert(
                    "outputBytes".to_owned(),
                    item.get("outputBytes").cloned().unwrap_or(json!(0)),
                );
                object.insert(
                    "outputTruncated".to_owned(),
                    item.get("outputTruncated").cloned().unwrap_or(json!(false)),
                );
                object.insert(
                    "outputDigest".to_owned(),
                    item.get("outputDigest").cloned().unwrap_or(Value::Null),
                );
            } else if let Value::Object(output) = bounded_output(text(
                item.get("aggregatedOutput").or_else(|| item.get("output")),
            )) {
                object.extend(output);
            }
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
        let sources: Vec<Value> = if complete {
            item.get("results")
                .and_then(Value::as_array)
                .map(|results| {
                    results
                        .iter()
                        .take(64)
                        .enumerate()
                        .filter_map(|(index, result)| {
                            let source_url = text(result.get("url"));
                            if (!source_url.starts_with("http://")
                                && !source_url.starts_with("https://"))
                                || source_url.len() > 8192
                            {
                                return None;
                            }
                            let fallback_id = format!("{item_id}:source:{}", index + 1);
                            let source_id = id(
                                text(result.get("ref_id").or_else(|| result.get("refId"))),
                                &fallback_id,
                            );
                            let title = redact_text(text(result.get("title")));
                            let title: String = if title.is_empty() {
                                source_url.chars().take(4000).collect()
                            } else {
                                title.chars().take(4000).collect()
                            };
                            let snippet = redact_text(text(result.get("snippet")));
                            Some(json!({
                                "sourceId": source_id,
                                "title": title,
                                "url": source_url,
                                "snippet": if snippet.is_empty() { Value::Null } else { Value::String(snippet.chars().take(4000).collect()) },
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        push(
            &mut result,
            if complete {
                "research.completed"
            } else {
                "research.started"
            },
            json!({"schema":"paperclip.research.v1","researchId":item_id,"action":action_kind,"status":if complete {"completed"} else {"running"},"query":item.get("query").or_else(|| action.get("query")).and_then(Value::as_str),"url":if url.starts_with("http://") || url.starts_with("https://") {Value::String(url.to_owned())} else {Value::Null},"pattern":action.get("pattern").and_then(Value::as_str),"sources":sources}),
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
        assert_eq!(payload["outputTruncated"], true);
        assert_eq!(
            payload["output"].as_str().unwrap().as_bytes().len(),
            MAX_OUTPUT_BYTES
        );
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

    #[test]
    fn maps_bounded_safe_web_search_sources() {
        let events = canonical_provider_events(
            "item/completed",
            &json!({"item":{"id":"web-1","type":"webSearch","results":[
                {"ref_id":"source-1","title":"Protocol notes","url":"https://example.com/prp","snippet":"Canonical event details"},
                {"ref_id":"unsafe","title":"Unsafe","url":"file:///etc/passwd"}
            ]}}),
        );
        assert_eq!(events[0].0, "research.completed");
        assert_eq!(events[0].1["sources"].as_array().unwrap().len(), 1);
        assert_eq!(events[0].1["sources"][0]["sourceId"], "source-1");
        assert_eq!(events[0].1["sources"][0]["url"], "https://example.com/prp");
    }

    #[test]
    fn completed_turn_plan_is_terminal_without_an_item_completion() {
        let events = canonical_provider_events(
            "turn/plan/updated",
            &json!({"turnId":"turn-1","plan":[
                {"step":"Inspect","status":"completed"},
                {"step":"Implement","status":"completed"}
            ]}),
        );
        assert_eq!(events[0].0, "plan.updated");
        assert_eq!(events[0].2, "turn-1");
        assert_eq!(events[0].1["planId"], "turn-1");
        assert_eq!(events[0].1["complete"], true);
        assert_eq!(events[0].1["syncStatus"], "not_applicable");
        assert_eq!(events[0].1["documentRevision"], Value::Null);
    }

    #[test]
    fn proposed_plan_text_is_not_a_turn_checklist() {
        let events = canonical_provider_events(
            "item/completed",
            &json!({"item":{"id":"proposed-plan-1","type":"plan","text":"Ship it"}}),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn empty_turn_plan_is_a_non_terminal_clearing_snapshot() {
        let events =
            canonical_provider_events("turn/plan/updated", &json!({"turnId":"turn-1","plan":[]}));
        assert_eq!(events[0].1["steps"], json!([]));
        assert_eq!(events[0].1["complete"], false);
    }

    #[test]
    fn maps_turn_diff_to_a_stable_workspace_snapshot() {
        let events = canonical_provider_events(
            "turn/diff/updated",
            &json!({
                "turnId":"turn-1",
                "diff":"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added\n"
            }),
        );
        assert_eq!(events[0].0, "workspace.change.updated");
        assert_eq!(events[0].2, "turn-1:workspace");
        assert_eq!(events[0].1["changeSetId"], "turn-1:workspace");
        assert_eq!(
            events[0].1["totals"],
            json!({"files":1,"additions":2,"deletions":1})
        );
        assert_eq!(events[0].1["files"][0]["path"], "src/a.ts");
    }
}
