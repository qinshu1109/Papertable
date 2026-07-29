//! 模型通道。把 `server/index.mjs` 的四条路由移植成 Tauri 命令。
//!
//! 移植的参照实现是 `server/cozai.mjs`，两处的语义必须一致：
//! - `content` 与 `reasoning_content` 分道，**推理直接丢弃、绝不离开本进程**；
//! - 所有正文 token 仍受前端正文哨兵闸门约束，服务端元数据不能绕过它；
//! - 只有推理没有正文时仍然报「没有返回可显示的文本」。
//!
//! 目标地址由本进程持有，前端**不能**指定——和 Node 版一样，这不是开放代理。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::error::Error as _;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for Error {}
impl From<String> for Error {
    fn from(v: String) -> Self {
        Error(v)
    }
}
impl From<&str> for Error {
    fn from(v: &str) -> Self {
        Error(v.to_string())
    }
}
impl From<std::io::Error> for Error {
    fn from(v: std::io::Error) -> Self {
        Error(v.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(v: serde_json::Error) -> Self {
        Error(v.to_string())
    }
}
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing)]
    pub api_key: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            base_url: "https://cozai.net/v1".into(),
            model: "claude-opus-5".into(),
            api_key: String::new(),
        }
    }
}

/// 发给前端的安全视图：**永远不含密钥本身**，只说有没有。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

impl From<&ProviderConfig> for PublicConfig {
    fn from(c: &ProviderConfig) -> Self {
        Self {
            base_url: c.base_url.clone(),
            model: c.model.clone(),
            has_api_key: !c.api_key.is_empty(),
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub configured: bool,
    pub model: String,
    pub base_url: String,
    pub message: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, alias = "tool_calls")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, alias = "tool_call_id")]
    pub tool_call_id: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default = "empty_json_object")]
    pub arguments: String,
}

fn empty_json_object() -> String {
    "{}".to_string()
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    #[serde(default)]
    pub r#type: Option<String>,
    pub function: ToolFunction,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunction {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Option<Value>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub task: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub tools: Vec<ToolDefinition>,
    #[serde(default, alias = "tool_choice")]
    pub tool_choice: Option<Value>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ProviderUsage>,
    pub gateway_response_shape: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub total_tokens: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStageResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilityResult {
    pub mode: String,
    pub protocol_adapter_version: String,
    pub gateway_response_shape: String,
    pub tool_call_emission: CapabilityStageResult,
    pub tool_result_acceptance: CapabilityStageResult,
    pub streaming_tool_call_delta: CapabilityStageResult,
    pub tested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// 与前端 `streamModel` 消费的 SSE 事件一一对应。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token {
        text: String,
        channel: &'static str,
    },
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
    },
    Done {
        stopped: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<ProviderUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gateway_response_shape: Option<String>,
    },
}

const ALLOWED_TASKS: [&str; 6] = [
    "chat",
    "agent",
    "concept-preview",
    "title",
    "concepts",
    "verdict-draft",
];
const ALLOWED_ROLES: [&str; 4] = ["system", "user", "assistant", "tool"];
const CLIENT_TOOLS: [&str; 2] = ["search_notes", "read_notes"];
const PROBE_TOOL: &str = "papertable_probe";
const PROTOCOL_ADAPTER_VERSION: &str = "openai-native-tools-v1";
const OPENAI_GATEWAY_RESPONSE_SHAPE: &str = "openai-chat-completions-v1";

/// 对来自 WebView 的模型请求做白名单校验。`papertable_probe` 是能力探测的内部
/// 实现细节，绝不能从 `llm_complete` / `llm_stream` 这两条公开命令声明出来。
fn validate_with_probe_permission(request: &ChatRequest, allow_probe_tool: bool) -> Result<()> {
    if !ALLOWED_TASKS.contains(&request.task.as_str()) {
        return Err("不支持的模型任务。".into());
    }
    if request.messages.is_empty() {
        return Err("缺少对话内容。".into());
    }
    let can_probe = allow_probe_tool
        && request.task == "agent"
        && request
            .tools
            .iter()
            .any(|tool| tool.function.name == PROBE_TOOL);
    let allowed_tools: Vec<&str> = if can_probe {
        CLIENT_TOOLS.into_iter().chain([PROBE_TOOL]).collect()
    } else {
        CLIENT_TOOLS.to_vec()
    };
    if request.tools.len() > if can_probe { 3 } else { 2 } {
        return Err("工具定义格式不正确。".into());
    }
    let mut tool_names = std::collections::HashSet::new();
    for tool in &request.tools {
        let name = tool.function.name.as_str();
        if !allowed_tools.contains(&name)
            || !tool_names.insert(name)
            || tool
                .r#type
                .as_deref()
                .is_some_and(|kind| kind != "function")
            || tool
                .function
                .description
                .as_ref()
                .is_some_and(|text| text.chars().count() > 4_000)
            || tool.function.parameters.as_ref().is_some_and(|value| {
                serde_json::to_string(value).map_or(true, |wire| wire.len() > 16_000)
            })
        {
            return Err("工具定义格式不正确。".into());
        }
    }
    if let Some(choice) = &request.tool_choice {
        let valid_string = choice
            .as_str()
            .is_some_and(|value| matches!(value, "auto" | "none" | "required"));
        let chosen = choice
            .get("function")
            .and_then(|value| value.get("name"))
            .or_else(|| choice.get("name"))
            .and_then(Value::as_str);
        if !valid_string && !chosen.is_some_and(|name| tool_names.contains(name)) {
            return Err("工具选择格式不正确。".into());
        }
    }
    if !request.tools.is_empty() && !matches!(request.task.as_str(), "chat" | "agent") {
        return Err("当前模型任务不支持工具调用。".into());
    }
    for message in &request.messages {
        if !ALLOWED_ROLES.contains(&message.role.as_str()) {
            return Err("对话角色不正确。".into());
        }
        let content_too_long = message
            .content
            .as_ref()
            .is_some_and(|content| content.chars().count() > 160_000);
        let calls_are_valid = message.tool_calls.len() <= 8
            && message.tool_calls.iter().all(|call| {
                !call.id.is_empty()
                    && call.id.chars().count() <= 200
                    && allowed_tools.contains(&call.name.as_str())
                    && call.arguments.chars().count() <= 32_000
            });
        if content_too_long || !calls_are_valid {
            return Err("对话内容格式不正确。".into());
        }
        match message.role.as_str() {
            "assistant" if message.content.is_none() && message.tool_calls.is_empty() => {
                return Err("对话内容不能为空。".into())
            }
            "assistant" => {}
            "tool"
                if message.content.as_ref().map_or(true, String::is_empty)
                    || message.tool_call_id.as_deref().map_or(true, str::is_empty)
                    || !message.tool_calls.is_empty() =>
            {
                return Err("对话内容格式不正确。".into())
            }
            "tool" => {}
            _ if message.content.as_ref().map_or(true, String::is_empty)
                || !message.tool_calls.is_empty()
                || message.tool_call_id.is_some() =>
            {
                return Err("对话内容不能为空。".into())
            }
            _ => {}
        }
        if message.role != "tool" && message.tool_call_id.is_some() {
            return Err("对话内容不能为空。".into());
        }
    }
    Ok(())
}

fn validate(request: &ChatRequest) -> Result<()> {
    validate_with_probe_permission(request, false)
}

fn validate_internal_probe(request: &ChatRequest) -> Result<()> {
    validate_with_probe_permission(request, true)
}

pub fn provider_error_code_for_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "unauthorized",
        429 => "rate-limited",
        408 | 504 => "timeout",
        500..=599 => "service-unavailable",
        _ => "invalid-response",
    }
}

pub fn provider_error_message(code: &str) -> &'static str {
    match code {
        "unauthorized" => "模型服务未配置或密钥无效，请在设置页检查。",
        "rate-limited" => "模型服务暂时限流，请稍后重试。",
        "timeout" => "请求超时，请重试。",
        "disconnected" => "连接意外中断，请重试。",
        "empty-response" => "模型服务没有返回可处理的内容，请重试。",
        "invalid-response" => "模型服务返回了无法处理的响应，请重试。",
        "service-unavailable" => "模型服务暂时不可用，请稍后重试。",
        _ => "模型请求未能完成，请重试。",
    }
}

pub fn friendly_provider_error(status: u16, _body: &str) -> String {
    provider_error_message(provider_error_code_for_status(status)).to_string()
}

fn transport_error_code(error: &ureq::Transport) -> &'static str {
    let timed_out = error
        .source()
        .and_then(|source| source.downcast_ref::<std::io::Error>())
        .is_some_and(|source| source.kind() == std::io::ErrorKind::TimedOut);
    if timed_out {
        "timeout"
    } else {
        "disconnected"
    }
}

fn request_error_code(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::Transport(transport) => transport_error_code(transport),
        ureq::Error::Status(status, _) => provider_error_code_for_status(*status),
    }
}

/// 与 Node 版 `normalizeProviderConfig` 同一套规则：必须是 HTTPS，或本机 HTTP。
pub fn normalize(input: &Value, current: &ProviderConfig) -> Result<ProviderConfig> {
    let base_url = input
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("请输入接口地址。".into()))?
        .trim();
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("请输入模型名称。".into()))?
        .trim();
    if model.is_empty() || model.chars().count() > 160 || model.contains(['\r', '\n']) {
        return Err("模型名称格式不正确。".into());
    }
    let api_key = input.get("apiKey").and_then(Value::as_str).unwrap_or("");
    if api_key.chars().count() > 1000 || api_key.contains(['\r', '\n']) {
        return Err("密钥格式不正确。".into());
    }

    let url = url_parts(base_url).ok_or_else(|| Error("接口地址不是有效 URL。".into()))?;
    let loopback = ["127.0.0.1", "localhost", "::1"].contains(&url.host.as_str());
    if !(url.scheme == "https" || (url.scheme == "http" && loopback))
        || url.has_credentials
        || url.has_query_or_hash
    {
        return Err("接口地址必须是 HTTPS，或本机 HTTP 地址。".into());
    }

    Ok(ProviderConfig {
        base_url: base_url.trim_end_matches('/').to_string(),
        model: model.to_string(),
        // 空密钥代表保留原密钥，避免前端读取或回显密钥。
        api_key: if api_key.trim().is_empty() {
            current.api_key.clone()
        } else {
            api_key.trim().to_string()
        },
    })
}

struct UrlParts {
    scheme: String,
    host: String,
    has_credentials: bool,
    has_query_or_hash: bool,
}

/// 只做这里需要的判断，不引入 url crate。
fn url_parts(raw: &str) -> Option<UrlParts> {
    let (scheme, rest) = raw.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    // authority 在 '/'、'?'、'#' 任一处结束。只找 '/' 的话，`https://x.test?a=1`
    // 这种没有路径的地址会把查询串当成主机名的一部分而漏检。
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path_and_more = &rest[authority_end..];
    if authority.is_empty() {
        return None;
    }
    let has_credentials = authority.contains('@');
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port
        .rsplit_once(':')
        .filter(|(h, _)| !h.contains(']'))
        .map(|(h, _)| h)
        .unwrap_or(host_port)
        .trim_matches(['[', ']'])
        .to_string();
    Some(UrlParts {
        scheme: scheme.to_ascii_lowercase(),
        host,
        has_credentials,
        has_query_or_hash: path_and_more.contains('?') || path_and_more.contains('#'),
    })
}

// ---------------------------------------------------------------------------
// 配置持久化
//
// 桌面版把接口地址、模型名和 API 密钥都保存在应用数据目录的 owner-only（0600）文件。
// 不调用 macOS 钥匙串：Papertable 的本地 ad-hoc 签名在每次重建后都会变更，钥匙串会
// 因此把它当成新的程序并反复索要登录钥匙串密码。0600 文件只允许当前 macOS 用户读取，
// 且密钥仍然绝不进入 SQLite、前端、导出包、日志或 Git。
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    /// 应用数据目录里的 0600 文件。
    File,
    None,
}

pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("provider.json")
}

/// 密钥实际来源。设置页要如实展示，不能让用户以为它还在系统钥匙串里。
pub fn key_source(config: &ProviderConfig) -> KeySource {
    if config.api_key.is_empty() {
        KeySource::None
    } else {
        KeySource::File
    }
}

pub fn load_config(path: &Path) -> ProviderConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| ProviderConfig {
            base_url: value
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or("https://cozai.net/v1")
                .to_string(),
            model: value
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("claude-opus-5")
                .to_string(),
            api_key: value
                .get("apiKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
        .unwrap_or_default()
}

/// 保存配置到仅当前用户可读的文件。永远不接触系统钥匙串。
pub fn save_config(path: &Path, config: &ProviderConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&json!({
        "baseUrl": config.base_url,
        "model": config.model,
        "apiKey": config.api_key,
    }))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body)?;
    set_owner_only(&temp)?;
    std::fs::rename(&temp, path)?;
    set_owner_only(path)?;
    Ok(())
}

fn set_owner_only(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

fn wire_tool_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": { "name": call.name, "arguments": call.arguments },
    })
}

fn wire_message(message: &Message) -> Value {
    match message.role.as_str() {
        "assistant" => {
            let mut object = serde_json::Map::new();
            object.insert("role".into(), Value::String("assistant".into()));
            object.insert(
                "content".into(),
                message
                    .content
                    .as_ref()
                    .map(|content| Value::String(content.clone()))
                    .unwrap_or(Value::Null),
            );
            if !message.tool_calls.is_empty() {
                object.insert(
                    "tool_calls".into(),
                    Value::Array(message.tool_calls.iter().map(wire_tool_call).collect()),
                );
            }
            Value::Object(object)
        }
        "tool" => json!({
            "role": "tool",
            "tool_call_id": message.tool_call_id,
            "content": message.content,
        }),
        _ => json!({ "role": message.role, "content": message.content }),
    }
}

fn wire_tool(tool: &ToolDefinition) -> Value {
    let mut function = serde_json::Map::new();
    function.insert("name".into(), Value::String(tool.function.name.clone()));
    if let Some(description) = &tool.function.description {
        function.insert("description".into(), Value::String(description.clone()));
    }
    if let Some(parameters) = &tool.function.parameters {
        function.insert("parameters".into(), parameters.clone());
    }
    json!({ "type": "function", "function": function })
}

fn wire_tool_choice(choice: &Value) -> Value {
    if choice.is_string() {
        return choice.clone();
    }
    let name = choice
        .get("function")
        .and_then(|function| function.get("name"))
        .or_else(|| choice.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    json!({ "type": "function", "function": { "name": name } })
}

fn body_for(config: &ProviderConfig, request: &ChatRequest, stream: bool) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("model".into(), Value::String(config.model.clone()));
    body.insert("stream".into(), Value::Bool(stream));
    if stream && request.task == "agent" {
        body.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    body.insert(
        "messages".into(),
        Value::Array(request.messages.iter().map(wire_message).collect()),
    );
    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(request.tools.iter().map(wire_tool).collect()),
        );
    }
    if let Some(choice) = &request.tool_choice {
        body.insert("tool_choice".into(), wire_tool_choice(choice));
    }
    body.insert(
        "temperature".into(),
        Value::from(request.temperature.unwrap_or(0.35).clamp(0.0, 1.0)),
    );
    Value::Object(body)
}

/// 分离最终正文与草稿推理。与 `server/cozai.mjs` 的 `extractDelta` 逐字对应。
pub fn extract_delta(payload: &Value) -> (String, String) {
    let delta = payload
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"));
    let pick = |key: &str| {
        delta
            .and_then(|d| d.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let reasoning = [
        pick("reasoning_content"),
        pick("reasoning"),
        pick("thinking"),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or_default();
    (pick("content"), reasoning)
}

pub fn extract_message(payload: &Value) -> String {
    payload
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Structural fingerprint only. It never contains response content.
pub fn gateway_response_shape(payload: &Value) -> &'static str {
    let choice = payload.get("choices").and_then(|choices| choices.get(0));
    if choice.is_some_and(|value| {
        value.get("message").is_some_and(Value::is_object)
            || value.get("delta").is_some_and(Value::is_object)
    }) {
        OPENAI_GATEWAY_RESPONSE_SHAPE
    } else {
        "unknown"
    }
}

pub fn extract_tool_calls(payload: &Value) -> Vec<ToolCall> {
    let Some(calls) = payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return vec![];
    };
    calls
        .iter()
        .filter_map(|call| {
            let id = call.get("id")?.as_str()?.trim();
            let function = call.get("function")?;
            let name = function.get("name")?.as_str()?.trim();
            (!id.is_empty() && !name.is_empty()).then(|| ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
            })
        })
        .collect()
}

/// `(index, id, function name, arguments fragment)` from one OpenAI SSE delta.
/// Type alias keeps the extraction API readable without introducing an extra allocation per chunk.
pub type ToolCallDelta = (usize, Option<String>, Option<String>, Option<String>);

pub fn extract_tool_call_deltas(payload: &Value) -> Vec<ToolCallDelta> {
    let Some(calls) = payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return vec![];
    };
    calls
        .iter()
        .enumerate()
        .filter_map(|(fallback_index, call)| {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(fallback_index);
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let function = call.get("function");
            let name = function
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let arguments = function
                .and_then(|value| value.get("arguments"))
                .and_then(Value::as_str)
                .map(str::to_string);
            (id.is_some() || name.is_some() || arguments.is_some())
                .then_some((index, id, name, arguments))
        })
        .collect()
}

pub fn extract_finish_reason(payload: &Value) -> Option<String> {
    payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
        .map(|reason| reason.chars().take(80).collect())
}

pub fn extract_usage(payload: &Value) -> Option<ProviderUsage> {
    let usage = payload.get("usage")?;
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(Value::as_u64);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(Value::as_u64);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            input_tokens
                .zip(output_tokens)
                .map(|(input, output)| input + output)
        })?;
    Some(ProviderUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

/// 诊断:上游 SSE 原始帧转存。
///
/// 存在 `<app_data>/DEBUG_SSE` 这个标记文件时，把每一行 `data:` 原样追加到
/// `<app_data>/sse.log`。用标记文件而不是环境变量，是因为双击启动的应用拿不到
/// 环境变量。
///
/// 原始帧里**不含** API 密钥（密钥在请求头里），但会包含问题与回答文本，
/// 所以只在需要排查时打开，用完删掉标记文件。
pub struct SseTap(Option<PathBuf>);

impl SseTap {
    pub fn open(app_data: Option<&Path>) -> Self {
        let Some(dir) = app_data else {
            return Self(None);
        };
        if dir.join("DEBUG_SSE").exists() {
            Self(Some(dir.join("sse.log")))
        } else {
            Self(None)
        }
    }

    fn write(&self, line: &str) {
        let Some(path) = &self.0 else { return };
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .build()
}

pub fn health(config: &ProviderConfig) -> ProviderHealth {
    if config.api_key.is_empty() {
        return ProviderHealth {
            configured: false,
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            message: "尚未配置模型密钥，请在设置页填写。".into(),
        };
    }
    // **不能用 /models 做健康检查。** CozAI 的 /models 不校验密钥，于是一个无效
    // 密钥也会返回 200，界面显示「可开始真实生成」，而真正提问时才报
    // INVALID_API_KEY。验收时就是这么被误导的：钥匙串里存的是测试残留的 "k"，
    // 连接测试却是绿的。
    //
    // 改成打真实的 chat/completions：一个 1 token 的最小请求，会真正走鉴权。
    let response = agent()
        .post(&format!("{}/chat/completions", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .set("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send_json(json!({
            "model": config.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }));
    match response {
        Ok(_) => ProviderHealth {
            configured: true,
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            message: "模型服务可用。".into(),
        },
        Err(ureq::Error::Status(status, response)) => ProviderHealth {
            configured: false,
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            message: friendly_provider_error(status, &response.into_string().unwrap_or_default()),
        },
        Err(e) => {
            let code = request_error_code(&e);
            ProviderHealth {
                configured: false,
                model: config.model.clone(),
                base_url: config.base_url.clone(),
                message: provider_error_message(code).into(),
            }
        }
    }
}

fn complete_with_probe_permission(
    config: &ProviderConfig,
    request: &ChatRequest,
    allow_probe_tool: bool,
) -> Result<Completion> {
    if allow_probe_tool {
        validate_internal_probe(request)?;
    } else {
        validate(request)?;
    }
    if config.api_key.is_empty() {
        return Err(provider_error_message("unauthorized").into());
    }
    let response = agent()
        .post(&format!("{}/chat/completions", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .set("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(90))
        .send_json(body_for(config, request, false));
    match response {
        Ok(res) => {
            let text = res
                .into_string()
                .map_err(|_| Error(provider_error_message("invalid-response").into()))?;
            let value: Value = serde_json::from_str(&text)
                .map_err(|_| Error(provider_error_message("invalid-response").into()))?;
            let completion = Completion {
                content: extract_message(&value),
                tool_calls: extract_tool_calls(&value),
                usage: extract_usage(&value),
                gateway_response_shape: gateway_response_shape(&value).into(),
            };
            if completion.content.is_empty() && completion.tool_calls.is_empty() {
                Err(provider_error_message("empty-response").into())
            } else {
                Ok(completion)
            }
        }
        Err(ureq::Error::Status(status, res)) => Err(Error(friendly_provider_error(
            status,
            &res.into_string().unwrap_or_default(),
        ))),
        Err(e) => Err(Error(provider_error_message(request_error_code(&e)).into())),
    }
}

/// 公开通道：只有真正的只读笔记工具可进入模型请求。
pub fn complete(config: &ProviderConfig, request: &ChatRequest) -> Result<Completion> {
    complete_with_probe_permission(config, request, false)
}

/// 仅 `provider_probe_capability` 在本模块内部调用，不能暴露到 Tauri command。
fn complete_internal_probe(config: &ProviderConfig, request: &ChatRequest) -> Result<Completion> {
    complete_with_probe_permission(config, request, true)
}

/// 旧的标题、概念等文本功能仍用这个窄接口；Harness 要工具调用时走 `complete()`。
pub fn generate(config: &ProviderConfig, request: &ChatRequest) -> Result<String> {
    let completion = complete(config, request)?;
    if completion.content.is_empty() {
        Err(provider_error_message("empty-response").into())
    } else {
        Ok(completion.content)
    }
}

/// 流式转发。事件经 Tauri `Channel` 推给前端，替代浏览器里的 SSE 解析循环。
pub fn stream(
    config: &ProviderConfig,
    request: &ChatRequest,
    channel: &Channel<StreamEvent>,
    tap: &SseTap,
    cancelled: &AtomicBool,
) -> Result<()> {
    if let Err(_e) = validate(request) {
        let _ = channel.send(StreamEvent::Error {
            message: provider_error_message("invalid-response").into(),
            code: Some("invalid-response"),
        });
        let _ = channel.send(StreamEvent::Done {
            stopped: false,
            finish_reason: None,
            usage: None,
            gateway_response_shape: None,
        });
        return Ok(());
    }
    if config.api_key.is_empty() {
        let _ = channel.send(StreamEvent::Error {
            message: provider_error_message("unauthorized").into(),
            code: Some("unauthorized"),
        });
        let _ = channel.send(StreamEvent::Done {
            stopped: false,
            finish_reason: None,
            usage: None,
            gateway_response_shape: None,
        });
        return Ok(());
    }
    if cancelled.load(Ordering::Relaxed) {
        let _ = channel.send(StreamEvent::Done {
            stopped: true,
            finish_reason: None,
            usage: None,
            gateway_response_shape: None,
        });
        return Ok(());
    }

    let response = agent()
        .post(&format!("{}/chat/completions", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .set("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .send_json(body_for(config, request, true));

    let reader = match response {
        Ok(res) => res.into_reader(),
        Err(ureq::Error::Status(status, res)) => {
            let _ = channel.send(StreamEvent::Error {
                message: friendly_provider_error(status, &res.into_string().unwrap_or_default()),
                code: Some(provider_error_code_for_status(status)),
            });
            let _ = channel.send(StreamEvent::Done {
                stopped: false,
                finish_reason: None,
                usage: None,
                gateway_response_shape: None,
            });
            return Ok(());
        }
        Err(e) => {
            let code = request_error_code(&e);
            let _ = channel.send(StreamEvent::Error {
                message: provider_error_message(code).into(),
                code: Some(code),
            });
            let _ = channel.send(StreamEvent::Done {
                stopped: false,
                finish_reason: None,
                usage: None,
                gateway_response_shape: None,
            });
            return Ok(());
        }
    };

    let mut emitted = false;
    let mut emitted_tool_call = false;
    let mut finish_reason = None;
    let mut usage = None;
    let mut stopped = cancelled.load(Ordering::Relaxed);
    let mut reader = BufReader::new(reader);
    let mut stream_error = false;
    let mut observed_gateway_response_shape = None;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                let code = if error.kind() == std::io::ErrorKind::TimedOut {
                    "timeout"
                } else {
                    "disconnected"
                };
                let _ = channel.send(StreamEvent::Error {
                    message: provider_error_message(code).into(),
                    code: Some(code),
                });
                stream_error = true;
                break;
            }
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        tap.write(data);
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            // 非 JSON 的心跳帧不该打断这条流。
            continue;
        };
        let shape = gateway_response_shape(&payload);
        if shape != "unknown" {
            observed_gateway_response_shape.get_or_insert_with(|| shape.to_string());
        }
        let (content, _reasoning) = extract_delta(&payload);
        if !content.is_empty() {
            // `emitted` 只由 content 驱动：只有推理没有正文时仍要报错。
            emitted = true;
            let _ = channel.send(StreamEvent::Token {
                text: content,
                channel: "unknown",
            });
        }
        for (index, id, name, arguments) in extract_tool_call_deltas(&payload) {
            emitted_tool_call = true;
            let _ = channel.send(StreamEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments,
            });
        }
        if finish_reason.is_none() {
            finish_reason = extract_finish_reason(&payload);
        }
        if usage.is_none() {
            usage = extract_usage(&payload);
        }
    }

    if !emitted && !emitted_tool_call && !stopped && !stream_error {
        let _ = channel.send(StreamEvent::Error {
            message: provider_error_message("empty-response").into(),
            code: Some("empty-response"),
        });
    }
    let _ = channel.send(StreamEvent::Done {
        stopped,
        finish_reason,
        usage,
        gateway_response_shape: observed_gateway_response_shape,
    });
    Ok(())
}

fn probe_tool_definition() -> ToolDefinition {
    ToolDefinition {
        r#type: Some("function".into()),
        function: ToolFunction {
            name: PROBE_TOOL.into(),
            description: Some("Papertable 本机模型能力探测工具。".into()),
            parameters: Some(json!({
                "type": "object",
                "properties": { "probe": { "type": "string" } },
                "required": ["probe"],
                "additionalProperties": false,
            })),
        },
    }
}

fn probe_request() -> ChatRequest {
    ChatRequest {
        task: "agent".into(),
        messages: vec![Message {
            role: "user".into(),
            content: Some("请只调用 papertable_probe，参数 probe 为 ok。".into()),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        temperature: Some(0.0),
        tools: vec![probe_tool_definition()],
        tool_choice: Some(json!({ "type": "function", "function": { "name": PROBE_TOOL } })),
    }
}

fn streaming_probe_has_tool_call(
    config: &ProviderConfig,
    request: &ChatRequest,
) -> Result<(bool, String)> {
    validate_internal_probe(request)?;
    let response = agent()
        .post(&format!("{}/chat/completions", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .set("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(45))
        .send_json(body_for(config, request, true));
    let reader = match response {
        Ok(response) => response.into_reader(),
        Err(ureq::Error::Status(status, response)) => {
            return Err(friendly_provider_error(
                status,
                &response.into_string().unwrap_or_default(),
            )
            .into())
        }
        Err(error) => return Err(format!("模型连接中断，请重试：{error}").into()),
    };
    let mut observed_shape = "unknown".to_string();
    for line in BufReader::new(reader).lines() {
        let line = line?;
        let Some(raw) = line.strip_prefix("data:") else {
            continue;
        };
        let raw = raw.trim();
        if raw.is_empty() || raw == "[DONE]" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let shape = gateway_response_shape(&payload);
        if shape != "unknown" {
            observed_shape = shape.to_string();
        }
        if !extract_tool_call_deltas(&payload).is_empty() {
            return Ok((true, observed_shape));
        }
    }
    Ok((false, observed_shape))
}

/// 探测只验证 OpenAI-compatible 的工具协议，绝不把原始回复、密钥或模型推理持久化。
/// 结果由前端按 baseUrl+model+协议适配层版本缓存；任一变化都会失效。
pub fn probe_capability(config: &ProviderConfig) -> ProviderCapabilityResult {
    let stage = |status: &str, detail: Option<&str>| CapabilityStageResult {
        status: status.into(),
        detail: detail.map(|value| value.chars().take(240).collect()),
    };
    let tested_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".into());
    if config.api_key.is_empty() {
        return ProviderCapabilityResult {
            mode: "unavailable".into(),
            protocol_adapter_version: PROTOCOL_ADAPTER_VERSION.into(),
            gateway_response_shape: "unknown".into(),
            tool_call_emission: stage("failed", Some("未配置模型密钥。")),
            tool_result_acceptance: stage("not-run", Some("工具调用发出阶段未通过。")),
            streaming_tool_call_delta: stage("not-run", Some("未配置模型密钥。")),
            tested_at,
            unavailable_reason: Some("未配置模型密钥，Agent 模式不可用。".into()),
        };
    }
    let tool_call_emission;
    let mut tool_result_acceptance = stage("not-run", Some("工具调用发出阶段未通过。"));
    let mut gateway_shape = "unknown".to_string();
    let mut gateway_shape_valid = true;
    match complete_internal_probe(config, &probe_request()) {
        Ok(initial) => {
            gateway_shape = initial.gateway_response_shape.clone();
            gateway_shape_valid = initial.gateway_response_shape == OPENAI_GATEWAY_RESPONSE_SHAPE;
            if initial.tool_calls.is_empty() {
                tool_call_emission = stage("failed", Some("没有返回强制工具调用。"));
            } else {
                tool_call_emission = stage("passed", None);
            }
            if let Some(call) = initial.tool_calls.first() {
                let mut request = probe_request();
                request.messages.push(Message {
                    role: "assistant".into(),
                    content: if initial.content.is_empty() {
                        None
                    } else {
                        Some(initial.content.clone())
                    },
                    tool_calls: initial.tool_calls.clone(),
                    tool_call_id: None,
                });
                request.messages.push(Message {
                    role: "tool".into(),
                    content: Some("{\"ok\":true}".into()),
                    tool_calls: vec![],
                    tool_call_id: Some(call.id.clone()),
                });
                request.tool_choice = Some(Value::String("none".into()));
                match complete_internal_probe(config, &request) {
                    Ok(completion) => {
                        tool_result_acceptance = stage("passed", None);
                        if completion.gateway_response_shape != "unknown" {
                            if completion.gateway_response_shape != OPENAI_GATEWAY_RESPONSE_SHAPE {
                                gateway_shape_valid = false;
                            }
                            gateway_shape = completion.gateway_response_shape;
                        }
                    }
                    Err(cause) => {
                        let detail = cause.to_string();
                        tool_result_acceptance = stage("failed", Some(&detail));
                    }
                }
            }
        }
        Err(cause) => {
            let detail = cause.to_string();
            tool_call_emission = stage("failed", Some(&detail));
        }
    }
    let streaming_tool_call_delta = match streaming_probe_has_tool_call(config, &probe_request()) {
        Ok((true, shape)) => {
            if shape == OPENAI_GATEWAY_RESPONSE_SHAPE {
                gateway_shape = shape;
            } else {
                gateway_shape_valid = false;
            }
            stage("passed", None)
        }
        Ok((false, shape)) => {
            if shape != "unknown" {
                if shape != OPENAI_GATEWAY_RESPONSE_SHAPE {
                    gateway_shape_valid = false;
                }
                gateway_shape = shape;
            } else {
                gateway_shape_valid = false;
            }
            stage("failed", Some("没有返回流式工具调用增量。"))
        }
        Err(cause) => {
            let detail = cause.to_string();
            stage("failed", Some(&detail))
        }
    };
    let admitted = tool_call_emission.status == "passed"
        && tool_result_acceptance.status == "passed"
        && streaming_tool_call_delta.status == "passed"
        && gateway_shape_valid
        && gateway_shape == OPENAI_GATEWAY_RESPONSE_SHAPE;
    ProviderCapabilityResult {
        mode: if admitted {
            "native-tools".into()
        } else {
            "unavailable".into()
        },
        protocol_adapter_version: PROTOCOL_ADAPTER_VERSION.into(),
        gateway_response_shape: gateway_shape,
        tool_call_emission,
        tool_result_acceptance,
        streaming_tool_call_delta,
        tested_at,
        unavailable_reason: if admitted {
            None
        } else {
            Some("三段原生工具握手未全部通过，Agent 模式不可用。".into())
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_is_dropped_before_any_frontend_event() {
        let payload = json!({"choices":[{"delta":{
            "content":"正文","reasoning_content":"Since the user asked, I will plan."}}]});
        let (content, reasoning) = extract_delta(&payload);
        assert_eq!(content, "正文");
        assert!(reasoning.contains("the user"));
        let event = StreamEvent::Token {
            text: content,
            channel: "unknown",
        };
        let wire = serde_json::to_string(&event).unwrap();
        assert!(!wire.contains("the user"), "推理不得进入发往前端的事件");
    }

    #[test]
    fn extract_message_keeps_content_only() {
        let payload = json!({"choices":[{"message":{
            "reasoning_content":"草稿","content":"正文"}}]});
        assert_eq!(extract_message(&payload), "正文");
    }

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        let current = ProviderConfig::default();
        let ok = normalize(
            &json!({"baseUrl":"https://cozai.net/v1/","model":"m","apiKey":"k"}),
            &current,
        )
        .unwrap();
        assert_eq!(ok.base_url, "https://cozai.net/v1");
        assert_eq!(ok.api_key, "k");

        assert!(normalize(
            &json!({"baseUrl":"http://127.0.0.1:1234","model":"m"}),
            &current
        )
        .is_ok());
        assert!(normalize(&json!({"baseUrl":"http://evil.test","model":"m"}), &current).is_err());
        assert!(normalize(
            &json!({"baseUrl":"https://u:p@x.test","model":"m"}),
            &current
        )
        .is_err());
        assert!(normalize(
            &json!({"baseUrl":"https://x.test?a=1","model":"m"}),
            &current
        )
        .is_err());
        assert!(normalize(&json!({"baseUrl":"not a url","model":"m"}), &current).is_err());
    }

    #[test]
    fn an_empty_key_preserves_the_existing_one() {
        let current = ProviderConfig {
            api_key: "已有密钥".into(),
            ..Default::default()
        };
        let next = normalize(
            &json!({"baseUrl":"https://cozai.net/v1","model":"m","apiKey":""}),
            &current,
        )
        .unwrap();
        assert_eq!(next.api_key, "已有密钥", "空密钥必须保留原密钥");
    }

    #[test]
    fn the_public_view_never_carries_the_key() {
        let config = ProviderConfig {
            api_key: "secret".into(),
            ..Default::default()
        };
        let wire = serde_json::to_string(&PublicConfig::from(&config)).unwrap();
        assert!(!wire.contains("secret"));
        assert!(wire.contains("\"hasApiKey\":true"));
    }

    #[test]
    fn the_config_file_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        let config = ProviderConfig {
            api_key: "k".into(),
            ..Default::default()
        };
        save_config(&path, &config).unwrap();
        assert_eq!(load_config(&path).api_key, "k");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "组和其他用户不得有任何权限");
        }
    }

    /// 密钥来源必须如实上报，避免用户以为它还在系统钥匙串里。
    #[test]
    fn the_key_source_is_reported_honestly() {
        let empty = ProviderConfig::default();
        assert_eq!(key_source(&empty), KeySource::None);
        let with_key = ProviderConfig {
            api_key: "k".into(),
            ..Default::default()
        };
        assert_eq!(key_source(&with_key), KeySource::File);
    }

    #[test]
    fn unsupported_tasks_and_roles_are_refused() {
        let bad_task = ChatRequest {
            task: "shell".into(),
            messages: vec![Message {
                role: "user".into(),
                content: Some("x".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: None,
            tools: vec![],
            tool_choice: None,
        };
        assert!(validate(&bad_task).is_err());

        let bad_role = ChatRequest {
            task: "chat".into(),
            messages: vec![Message {
                role: "root".into(),
                content: Some("x".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: None,
            tools: vec![],
            tool_choice: None,
        };
        assert!(validate(&bad_role).is_err());
    }

    #[test]
    fn verdict_draft_is_allowed_without_tools() {
        let request = ChatRequest {
            task: "verdict-draft".into(),
            messages: vec![Message {
                role: "user".into(),
                content: Some("被裁掉的完整问答".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: Some(0.0),
            tools: vec![],
            tool_choice: None,
        };
        validate(&request).unwrap();

        let mut with_tool = request;
        with_tool.tools.push(ToolDefinition {
            r#type: Some("function".into()),
            function: ToolFunction {
                name: "search_notes".into(),
                description: None,
                parameters: Some(json!({"type":"object"})),
            },
        });
        assert!(validate(&with_tool).is_err());
    }

    #[test]
    fn tool_role_and_assistant_tool_calls_are_normalized_for_openai() {
        let request = ChatRequest {
            task: "agent".into(),
            messages: vec![
                Message {
                    role: "user".into(),
                    content: Some("查资料".into()),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                Message {
                    role: "assistant".into(),
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "search_notes".into(),
                        arguments: "{\"query\":\"量子\"}".into(),
                    }],
                    tool_call_id: None,
                },
                Message {
                    role: "tool".into(),
                    content: Some("[{\"chunkId\":\"c\"}]".into()),
                    tool_calls: vec![],
                    tool_call_id: Some("call-1".into()),
                },
            ],
            temperature: Some(0.2),
            tools: vec![ToolDefinition {
                r#type: Some("function".into()),
                function: ToolFunction {
                    name: "search_notes".into(),
                    description: None,
                    parameters: Some(json!({"type":"object"})),
                },
            }],
            tool_choice: Some(Value::String("auto".into())),
        };
        validate(&request).unwrap();
        let body = body_for(&ProviderConfig::default(), &request, false);
        assert_eq!(body["messages"][1]["content"], Value::Null);
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["name"],
            "search_notes"
        );
        assert_eq!(body["messages"][2]["tool_call_id"], "call-1");
        assert_eq!(body["tools"][0]["type"], "function");
    }

    #[test]
    fn streaming_tool_deltas_are_kept_as_protocol_not_text() {
        let payload = json!({"choices":[{"delta":{
            "reasoning_content":"hidden",
            "tool_calls":[{"index":0,"id":"call-1","function":{
              "name":"search_notes","arguments":"{\"query\":\"唯一事实\"}"}}]
        },"finish_reason":"tool_calls"}]});
        let (text, reasoning) = extract_delta(&payload);
        assert!(text.is_empty());
        assert_eq!(reasoning, "hidden");
        let calls = extract_tool_call_deltas(&payload);
        assert_eq!(calls[0].0, 0);
        assert_eq!(calls[0].2.as_deref(), Some("search_notes"));
        assert_eq!(
            extract_finish_reason(&payload).as_deref(),
            Some("tool_calls")
        );
        assert_eq!(
            gateway_response_shape(&payload),
            OPENAI_GATEWAY_RESPONSE_SHAPE
        );
        assert_eq!(gateway_response_shape(&json!({"output": []})), "unknown");
    }

    #[test]
    fn provider_usage_is_normalized_without_inventing_missing_counts() {
        assert_eq!(
            extract_usage(&json!({"usage":{
                "prompt_tokens":7,"completion_tokens":3,"total_tokens":10
            }})),
            Some(ProviderUsage {
                input_tokens: Some(7),
                output_tokens: Some(3),
                total_tokens: 10,
            })
        );
        assert_eq!(extract_usage(&json!({"choices":[]})), None);
        let event = StreamEvent::Done {
            stopped: false,
            finish_reason: Some("stop".into()),
            usage: Some(ProviderUsage {
                input_tokens: Some(4),
                output_tokens: Some(2),
                total_tokens: 6,
            }),
            gateway_response_shape: Some(OPENAI_GATEWAY_RESPONSE_SHAPE.into()),
        };
        let wire = serde_json::to_value(event).unwrap();
        assert_eq!(wire["usage"]["totalTokens"], 6);
    }

    #[test]
    fn streaming_requests_ask_for_real_usage_transport() {
        let request = ChatRequest {
            task: "agent".into(),
            messages: vec![Message {
                role: "user".into(),
                content: Some("x".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: None,
            tools: vec![],
            tool_choice: None,
        };
        assert_eq!(
            body_for(&ProviderConfig::default(), &request, true)["stream_options"]["include_usage"],
            true
        );
        assert!(body_for(&ProviderConfig::default(), &request, false)
            .get("stream_options")
            .is_none());
    }

    #[test]
    fn final_synthesis_can_explicitly_disable_tools_without_definitions() {
        let request = ChatRequest {
            task: "agent".into(),
            messages: vec![Message {
                role: "user".into(),
                content: Some("只输出最终正文。".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: None,
            tools: vec![],
            tool_choice: Some(Value::String("none".into())),
        };
        validate(&request).unwrap();
        let body = body_for(&ProviderConfig::default(), &request, true);
        assert_eq!(body["tool_choice"], "none");
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn a_client_cannot_declare_the_probe_tool() {
        let mut request = ChatRequest {
            task: "chat".into(),
            messages: vec![Message {
                role: "user".into(),
                content: Some("x".into()),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            temperature: None,
            tools: vec![probe_tool_definition()],
            tool_choice: None,
        };
        assert!(validate(&request).is_err());
        request.task = "agent".into();
        assert!(validate(&request).is_err());
        assert!(validate_internal_probe(&request).is_ok());
    }

    #[test]
    fn missing_key_capability_probe_fails_closed_for_agent_admission() {
        let result = probe_capability(&ProviderConfig::default());
        assert_eq!(result.mode, "unavailable");
        assert_eq!(result.tool_call_emission.status, "failed");
        assert_eq!(result.tool_result_acceptance.status, "not-run");
        assert_eq!(result.streaming_tool_call_delta.status, "not-run");
        assert_eq!(result.protocol_adapter_version, PROTOCOL_ADAPTER_VERSION);
        assert_eq!(result.gateway_response_shape, "unknown");
        assert!(result
            .unavailable_reason
            .unwrap_or_default()
            .contains("Agent"));
    }

    #[test]
    fn provider_error_contract_is_stable_and_never_uses_upstream_body() {
        assert_eq!(provider_error_code_for_status(401), "unauthorized");
        assert_eq!(provider_error_code_for_status(429), "rate-limited");
        assert_eq!(provider_error_code_for_status(504), "timeout");
        assert_eq!(provider_error_code_for_status(500), "service-unavailable");
        let message = friendly_provider_error(418, "http://127.0.0.1 EOF stack");
        assert!(!message.contains("127.0.0.1"));
        assert!(!message.contains("EOF"));
        assert_eq!(provider_error_message("timeout"), "请求超时，请重试。");
        assert_eq!(
            provider_error_message("empty-response"),
            "模型服务没有返回可处理的内容，请重试。"
        );
    }
}
