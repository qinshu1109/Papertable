use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const MCP_URL: &str = "http://127.0.0.1:8002/mcp";
const CUBE_ID: &str = "papertable-verdicts";
const MARKER: &str = "papertable-verdict";
const MAX_LINE_LENGTH: usize = 500;
const MAX_QUERY_LENGTH: usize = 500;
// ponytail: MCP search currently has no cursor/list API and hard-caps top_k at
// 50. Replace this bounded window when MemOS exposes pagination.
const MAX_SEARCH_RESULTS: usize = 50;
const LOCKED_FIELDS: [&str; 6] = [
    "verdict_type",
    "concepts",
    "source_kind",
    "source_id",
    "user_confirmed",
    "idempotency_key",
];
const GOLD_SOURCE_FIELDS: [&str; 2] = ["source_card_id", "source_turn_id"];

// One writer is enough for a personal local host and closes double-click races.
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HTTP_AGENT: OnceLock<ureq::Agent> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictInput {
    project_id: String,
    verdict_type: String,
    source_kind: String,
    source_id: String,
    source_card_id: Option<String>,
    source_turn_id: Option<String>,
    content: String,
    concepts: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Verdict {
    id: String,
    project_id: String,
    verdict_type: String,
    source_kind: String,
    source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_card_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_turn_id: Option<String>,
    content: String,
    concepts: Vec<String>,
    status: &'static str,
    idempotency_key: String,
    supersedes_memory_id: Option<String>,
}

pub(crate) fn safe_error(detail: impl ToString) -> Value {
    let _ = detail;
    json!({
        "available": false,
        "error": {
            "code": "unavailable",
            "message": "判决簿服务当前不可用，请稍后重试。",
        }
    })
}

fn ok(data: Value) -> Value {
    json!({ "available": true, "data": data })
}

fn required(value: &str, name: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{name} 格式不正确。"));
    }
    Ok(value.to_string())
}

fn normalize(
    mut input: VerdictInput,
    supersedes_memory_id: Option<&str>,
) -> Result<(VerdictInput, String), String> {
    input.project_id = required(&input.project_id, "projectId", 200)?;
    if !matches!(input.verdict_type.as_str(), "tombstone" | "gold") {
        return Err("verdictType 格式不正确。".into());
    }
    if !matches!(input.source_kind.as_str(), "edge" | "turn") {
        return Err("sourceKind 格式不正确。".into());
    }
    input.source_id = required(&input.source_id, "sourceId", 200)?;
    input.source_card_id = input
        .source_card_id
        .as_deref()
        .map(|value| required(value, "sourceCardId", 200))
        .transpose()?;
    input.source_turn_id = input
        .source_turn_id
        .as_deref()
        .map(|value| required(value, "sourceTurnId", 200))
        .transpose()?;
    if input.source_card_id.is_some() != input.source_turn_id.is_some() {
        return Err("sourceCardId 和 sourceTurnId 必须同时提供。".into());
    }
    if (input.verdict_type == "gold"
        && (input.source_kind != "turn"
            || input.source_card_id.is_none()
            || input.source_turn_id.is_none()
            || input.source_turn_id.as_deref() != Some(input.source_id.as_str())))
        || (input.verdict_type == "tombstone"
            && (input.source_kind != "edge"
                || input.source_card_id.is_some()
                || input.source_turn_id.is_some()))
    {
        return Err("判决类型与来源不匹配。".into());
    }
    input.content = required(&input.content, "content", MAX_LINE_LENGTH)?;
    if input.content.contains('\r') || input.content.contains('\n') {
        return Err("判决必须是单行。".into());
    }
    input.concepts = input
        .concepts
        .iter()
        .map(|item| required(item, "concept", 80))
        .collect::<Result<Vec<_>, _>>()?;
    input.concepts.sort();
    input.concepts.dedup();
    if input.concepts.is_empty() || input.concepts.len() > 16 {
        return Err("concepts 必须包含 1 到 16 个概念。".into());
    }
    let mut key_parts = vec![
        json!(&input.project_id),
        json!(&input.verdict_type),
        json!(&input.source_kind),
        json!(&input.source_id),
        json!(supersedes_memory_id),
    ];
    if let (Some(card_id), Some(turn_id)) = (&input.source_card_id, &input.source_turn_id) {
        key_parts.push(json!(card_id));
        key_parts.push(json!(turn_id));
    }
    let payload = serde_json::to_string(&key_parts).map_err(|error| error.to_string())?;
    let key = format!("{:x}", Sha256::digest(payload.as_bytes()));
    Ok((input, key))
}

struct McpClient {
    agent: &'static ureq::Agent,
    url: String,
}

impl McpClient {
    fn new() -> Self {
        Self::at(MCP_URL)
    }

    fn at(url: impl Into<String>) -> Self {
        Self {
            agent: HTTP_AGENT.get_or_init(|| {
                ureq::AgentBuilder::new()
                    .timeout_connect(Duration::from_secs(3))
                    .timeout_read(Duration::from_secs(10))
                    .timeout_write(Duration::from_secs(10))
                    .build()
            }),
            url: url.into(),
        }
    }

    fn post(&self, body: Value, session: Option<&str>) -> Result<(Value, Option<String>), String> {
        let mut request = self
            .agent
            .post(&self.url)
            .set("accept", "application/json, text/event-stream")
            .set("content-type", "application/json");
        if let Some(session) = session {
            request = request.set("mcp-session-id", session);
        }
        let response = request
            .send_json(body)
            .map_err(|error| format!("MemOS MCP 请求失败：{error}"))?;
        let session = response.header("mcp-session-id").map(str::to_string);
        let body: Value = response
            .into_json()
            .map_err(|error| format!("MemOS MCP JSON 无效：{error}"))?;
        if let Some(error) = body.get("error") {
            return Err(format!("MemOS MCP 错误：{error}"));
        }
        Ok((body, session))
    }

    fn call(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let (_, session) = self.post(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "papertable-rust", "version": "0.1.0"}
                }
            }),
            None,
        )?;
        let session = session.ok_or_else(|| "MemOS 未返回 MCP session".to_string())?;
        let (body, _) = self.post(
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments}
            }),
            Some(&session),
        )?;
        let result = body
            .pointer("/result")
            .ok_or_else(|| "MemOS MCP 缺少 result".to_string())?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return Err(result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("MemOS 工具调用失败")
                .to_string());
        }
        result
            .get("structuredContent")
            .cloned()
            .ok_or_else(|| "MemOS 工具缺少 structuredContent".to_string())
    }
}

fn memory_view(record: &Value) -> Option<Verdict> {
    let view = record.get("memory_view")?;
    let attributes = view.get("attributes")?;
    let info = record.pointer("/metadata/info")?;
    let tags = record.pointer("/metadata/tags")?.as_array()?;
    let key = attributes.get("idempotency_key")?.as_str()?;
    let source_card_id = attributes
        .get("source_card_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let source_turn_id = attributes
        .get("source_turn_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let verdict_type = attributes.get("verdict_type")?.as_str()?;
    let source_kind = attributes.get("source_kind")?.as_str()?;
    let source_id = attributes.get("source_id")?.as_str()?;
    if view.get("semantic_type")?.as_str()? != "decision"
        || view.get("client_id")?.as_str()? != "papertable"
        || view.get("subject_type")?.as_str()? != "other"
        || view.get("status")?.as_str()? != "activated"
        || !attributes.get("user_confirmed")?.as_bool()?
        || !LOCKED_FIELDS.iter().all(|field| {
            view.get("locked_fields")
                .and_then(Value::as_array)
                .is_some_and(|fields| fields.iter().any(|value| value.as_str() == Some(field)))
        })
        || source_card_id.is_some() != source_turn_id.is_some()
        || (verdict_type == "gold"
            && (source_kind != "turn"
                || source_card_id.is_none()
                || source_turn_id.is_none()
                || source_turn_id.as_deref() != Some(source_id)))
        || (verdict_type == "tombstone"
            && (source_kind != "edge" || source_card_id.is_some() || source_turn_id.is_some()))
        || (source_card_id.is_some()
            && !GOLD_SOURCE_FIELDS.iter().all(|field| {
                view.get("locked_fields")
                    .and_then(Value::as_array)
                    .is_some_and(|fields| fields.iter().any(|value| value.as_str() == Some(field)))
            }))
        || info.get("hot_policy")?.as_str()? != "exclude"
        || !tags.iter().any(|tag| tag.as_str() == Some("brain:ignore"))
    {
        return None;
    }
    if !matches!(verdict_type, "tombstone" | "gold") {
        return None;
    }
    let legacy_prefix = format!("{MARKER}:{key} ");
    let concepts = attributes.get("concepts")?.as_array()?;
    let concept_text = concepts
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let prefix = format!("{legacy_prefix}{concept_text} | ");
    let raw = record.get("memory")?.as_str()?;
    let content = raw
        .strip_prefix(&prefix)
        .or_else(|| raw.strip_prefix(&legacy_prefix))?;
    if content.is_empty()
        || content.contains('\r')
        || content.contains('\n')
        || content.chars().count() > MAX_LINE_LENGTH
    {
        return None;
    }
    Some(Verdict {
        id: record.get("memory_id")?.as_str()?.to_string(),
        project_id: view.get("subject_id")?.as_str()?.to_string(),
        verdict_type: verdict_type.to_string(),
        source_kind: source_kind.to_string(),
        source_id: source_id.to_string(),
        source_card_id,
        source_turn_id,
        content: content.to_string(),
        concepts: concepts
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        status: "confirmed",
        idempotency_key: key.to_string(),
        supersedes_memory_id: info
            .get("supersedes_memory_id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn ensure_cube(client: &McpClient) -> Result<Value, String> {
    let listed = client.call("list_cubes", json!({}))?;
    if listed["cubes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|cube| cube["cube_id"] == CUBE_ID)
    {
        return Ok(json!({"cubeId": CUBE_ID, "created": false}));
    }
    match client.call(
        "create_cube",
        json!({
            "cube_id": CUBE_ID,
            "name": "Papertable 判决簿",
            "description": "仅保存 Papertable 用户确认的项目判决；按项目隔离，排除 Brain 与热记忆，只允许 supersede。",
            "max_memories": 2000
        }),
    ) {
        Ok(_) => Ok(json!({"cubeId": CUBE_ID, "created": true})),
        Err(error) => {
            let retried = client.call("list_cubes", json!({}))?;
            if retried["cubes"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|cube| cube["cube_id"] == CUBE_ID)
            {
                Ok(json!({"cubeId": CUBE_ID, "created": false}))
            } else {
                Err(error)
            }
        }
    }
}

fn search_raw(client: &McpClient, project_id: &str, query: &str) -> Result<Vec<Verdict>, String> {
    let result = client.call(
        "search_memories",
        json!({
            "query": query,
            "cube_ids": [CUBE_ID],
            "top_k": MAX_SEARCH_RESULTS,
            "rerank": "off",
            "search_mode": "fts",
            "semantic_types": ["decision"],
            "subject_types": ["other"],
            "subject_ids": [project_id],
            "statuses": ["activated"]
        }),
    )?;
    Ok(result["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(memory_view)
        .filter(|verdict| verdict.project_id == project_id)
        .collect())
}

fn find_by_key(client: &McpClient, project_id: &str, key: &str) -> Result<Option<Verdict>, String> {
    Ok(search_raw(client, project_id, key)?
        .into_iter()
        .find(|verdict| verdict.idempotency_key == key))
}

fn add(
    client: &McpClient,
    input: VerdictInput,
    key: String,
    supersedes_memory_id: Option<&str>,
) -> Result<Value, String> {
    if let Some(existing) = find_by_key(client, &input.project_id, &key)? {
        return Ok(json!({"verdict": existing, "created": false}));
    }
    let mut attributes = json!({
        "verdict_type": input.verdict_type,
        "concepts": input.concepts,
        "source_kind": input.source_kind,
        "source_id": input.source_id,
        "user_confirmed": true,
        "idempotency_key": key,
    });
    let mut locked_fields = LOCKED_FIELDS.to_vec();
    if let (Some(card_id), Some(turn_id)) = (&input.source_card_id, &input.source_turn_id) {
        attributes["source_card_id"] = json!(card_id);
        attributes["source_turn_id"] = json!(turn_id);
        locked_fields.extend(GOLD_SOURCE_FIELDS);
    }
    let added = client.call(
        "add_memory",
        json!({
            "cube_id": CUBE_ID,
            "content": format!("{MARKER}:{key} {} | {}", input.concepts.join(" "), input.content),
            "tags": ["brain:ignore", "papertable-verdict"],
            "source": format!("papertable:{}:{}", input.source_kind, input.source_id),
            "hot_policy": "exclude",
            "semantic_type": "decision",
            "subject_type": "other",
            "subject_id": input.project_id,
            "asserted_by": "user",
            "client_id": "papertable",
            "attributes": attributes,
            "locked_fields": locked_fields,
            "supersedes_memory_id": supersedes_memory_id,
        }),
    )?;
    let record = client.call(
        "get_memory",
        json!({"cube_id": CUBE_ID, "memory_id": added["memory_id"]}),
    )?;
    let verdict = memory_view(&record).ok_or_else(|| "MemOS 写入后校验失败".to_string())?;
    Ok(json!({"verdict": verdict, "created": true}))
}

pub fn health() -> Value {
    let client = McpClient::new();
    match client.call("health", json!({})) {
        Ok(result) if result["status"] == "ok" => ok(json!({"available": true, "cubeId": CUBE_ID})),
        Ok(_) => safe_error("MemOS 状态异常"),
        Err(error) => safe_error(error),
    }
}

pub fn ensure() -> Value {
    match ensure_cube(&McpClient::new()) {
        Ok(result) => ok(result),
        Err(error) => safe_error(error),
    }
}

pub fn list(project_id: String, concept: Option<String>) -> Value {
    let result = (|| {
        let project_id = required(&project_id, "projectId", 200)?;
        let needle = match concept {
            Some(value) if !value.trim().is_empty() => {
                Some(required(&value, "concept", MAX_QUERY_LENGTH)?.to_lowercase())
            }
            _ => None,
        };
        let all = search_raw(&McpClient::new(), &project_id, MARKER)?;
        let superseded: std::collections::HashSet<&str> = all
            .iter()
            .filter_map(|item| item.supersedes_memory_id.as_deref())
            .collect();
        let matches = |item: &&Verdict| match needle.as_ref() {
            None => true,
            Some(needle) => {
                item.content.to_lowercase().contains(needle)
                    || item.concepts.iter().any(|concept| {
                        let concept = concept.to_lowercase();
                        concept.contains(needle) || needle.contains(&concept)
                    })
            }
        };
        let history: Vec<&Verdict> = all.iter().filter(matches).collect();
        let verdicts: Vec<&Verdict> = all
            .iter()
            .filter(|item| !superseded.contains(item.id.as_str()))
            .filter(matches)
            .collect();
        Ok::<_, String>(json!({"verdicts": verdicts, "history": history}))
    })();
    match result {
        Ok(result) => ok(result),
        Err(error) => safe_error(error),
    }
}

pub fn confirm(input: VerdictInput) -> Value {
    let result = (|| {
        let (input, key) = normalize(input, None)?;
        let _guard = WRITE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "判决簿写锁不可用".to_string())?;
        let client = McpClient::new();
        ensure_cube(&client)?;
        add(&client, input, key, None)
    })();
    match result {
        Ok(result) => ok(result),
        Err(error) => safe_error(error),
    }
}

pub fn supersede(memory_id: String, input: VerdictInput) -> Value {
    let result = (|| {
        let memory_id = required(&memory_id, "memoryId", 200)?;
        let (input, key) = normalize(input, Some(&memory_id))?;
        let _guard = WRITE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "判决簿写锁不可用".to_string())?;
        let client = McpClient::new();
        let record = client.call(
            "get_memory",
            json!({"cube_id": CUBE_ID, "memory_id": memory_id}),
        )?;
        let original =
            memory_view(&record).ok_or_else(|| "原判决不存在或格式不正确。".to_string())?;
        if original.project_id != input.project_id
            || original.verdict_type != input.verdict_type
            || original.source_kind != input.source_kind
            || original.source_id != input.source_id
            || original.source_card_id != input.source_card_id
            || original.source_turn_id != input.source_turn_id
        {
            return Err("修订必须保持项目、判决类型和来源。".into());
        }
        add(&client, input, key, Some(&memory_id))
    })();
    match result {
        Ok(result) => ok(result),
        Err(error) => safe_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{serve_keep_alive, TestResponse};

    fn input() -> VerdictInput {
        VerdictInput {
            project_id: "project-a".into(),
            verdict_type: "tombstone".into(),
            source_kind: "edge".into(),
            source_id: "edge-1".into(),
            source_card_id: None,
            source_turn_id: None,
            content: "用户否决了自动写笔记，因为内容会被活埋。".into(),
            concepts: vec!["自动写笔记".into()],
        }
    }

    #[test]
    fn validation_enforces_confirmed_single_line_contract() {
        let (_, first) = normalize(input(), None).unwrap();
        let (_, retry) = normalize(input(), None).unwrap();
        assert_eq!(first, retry);
        let mut invalid = input();
        invalid.content = "a\nb".into();
        assert!(normalize(invalid, None).is_err());
        let unavailable = safe_error("secret upstream body");
        assert_eq!(unavailable["available"], false);
        assert!(unavailable.pointer("/error/detail").is_none());
        let mut invalid = input();
        invalid.verdict_type = "proposed".into();
        assert!(normalize(invalid, None).is_err());
        let mut invalid_gold = input();
        invalid_gold.verdict_type = "gold".into();
        assert!(normalize(invalid_gold, None).is_err());
        let mut invalid_tombstone = input();
        invalid_tombstone.source_kind = "turn".into();
        invalid_tombstone.source_card_id = Some("card-1".into());
        invalid_tombstone.source_turn_id = Some("turn-1".into());
        assert!(normalize(invalid_tombstone, None).is_err());
        let mut gold = input();
        gold.verdict_type = "gold".into();
        gold.source_kind = "turn".into();
        gold.source_id = "turn-1".into();
        gold.source_card_id = Some("card-1".into());
        gold.source_turn_id = Some("turn-1".into());
        let (gold, _) = normalize(gold, None).unwrap();
        assert_eq!(gold.source_card_id.as_deref(), Some("card-1"));
        assert_eq!(gold.source_turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn safe_dto_requires_locked_confirmed_papertable_decision() {
        let (_, key) = normalize(input(), None).unwrap();
        let record = json!({
            "memory_id": "m1",
            "memory": format!("{MARKER}:{key} verdict"),
            "metadata": {
                "tags": ["brain:ignore", "papertable-verdict"],
                "info": {"hot_policy": "exclude"}
            },
            "memory_view": {
                "semantic_type": "decision",
                "subject_type": "other",
                "subject_id": "project-a",
                "client_id": "papertable",
                "status": "activated",
                "attributes": {
                    "verdict_type": "tombstone",
                    "concepts": ["自动写笔记"],
                    "source_kind": "edge",
                    "source_id": "edge-1",
                    "user_confirmed": true,
                    "idempotency_key": key
                },
                "locked_fields": LOCKED_FIELDS
            }
        });
        assert_eq!(memory_view(&record).unwrap().status, "confirmed");
        let mut unlocked = record;
        unlocked["memory_view"]["locked_fields"] = json!([]);
        assert!(memory_view(&unlocked).is_none());
    }

    #[test]
    fn pooled_transport_keeps_each_mcp_call_on_a_fresh_session() {
        let mut initialize_a = TestResponse::json(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        initialize_a.headers.push(("mcp-session-id", "session-a"));
        let tool_a = TestResponse::json(
            r#"{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"call":"a"}}}"#,
        );
        let mut initialize_b = TestResponse::json(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
        initialize_b.headers.push(("mcp-session-id", "session-b"));
        let tool_b = TestResponse::json(
            r#"{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"call":"b"}}}"#,
        );
        let (url, server) = serve_keep_alive(vec![initialize_a, tool_a, initialize_b, tool_b]);

        let first = McpClient::at(&url).call("health", json!({})).unwrap();
        let second = McpClient::at(&url).call("health", json!({})).unwrap();
        assert_eq!(first["call"], "a");
        assert_eq!(second["call"], "b");

        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        let methods: Vec<_> = requests
            .iter()
            .map(|request| {
                serde_json::from_str::<Value>(&request.body).unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            methods,
            ["initialize", "tools/call", "initialize", "tools/call"]
        );
        assert!(!requests[0].headers.contains_key("mcp-session-id"));
        assert_eq!(
            requests[1]
                .headers
                .get("mcp-session-id")
                .map(String::as_str),
            Some("session-a")
        );
        assert!(!requests[2].headers.contains_key("mcp-session-id"));
        assert_eq!(
            requests[3]
                .headers
                .get("mcp-session-id")
                .map(String::as_str),
            Some("session-b")
        );
        assert!(std::ptr::eq(McpClient::new().agent, McpClient::new().agent));
    }

    #[test]
    #[ignore = "requires the user's loopback MemOS service"]
    fn live_mcp_contract_covers_health_idempotency_supersede_and_isolation() {
        assert_eq!(health()["available"], true);
        assert_eq!(ensure()["available"], true);
        let mut first_input = input();
        first_input.project_id = "task014-rust-live".into();
        first_input.source_id = "edge-rust-live-1".into();
        first_input.concepts = vec!["TASK-014 Rust".into()];
        let first = confirm(first_input.clone());
        let retry = confirm(first_input.clone());
        assert_eq!(
            first.pointer("/data/verdict/id"),
            retry.pointer("/data/verdict/id")
        );
        assert_eq!(retry.pointer("/data/created"), Some(&json!(false)));
        let id = first
            .pointer("/data/verdict/id")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        first_input.content = "用户确认 Rust 通道仅保存经确认的一行判决。".into();
        let replacement = supersede(id.clone(), first_input);
        assert_eq!(
            replacement.pointer("/data/verdict/supersedesMemoryId"),
            Some(&json!(id))
        );
        let listed = list("task014-rust-live".into(), None);
        assert_eq!(
            listed
                .pointer("/data/verdicts")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            listed
                .pointer("/data/history")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            2
        );
        let concept_matched = list(
            "task014-rust-live".into(),
            Some("当前问题 TASK-014 Rust 卡片标题".into()),
        );
        assert_eq!(
            concept_matched
                .pointer("/data/verdicts")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            1
        );
        let isolated = list("task014-rust-other".into(), None);
        assert_eq!(
            isolated
                .pointer("/data/history")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            0
        );
    }
}
