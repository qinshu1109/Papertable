//! 模型通道。把 `server/index.mjs` 的四条路由移植成 Tauri 命令。
//!
//! 移植的参照实现是 `server/cozai.mjs`，两处的语义必须一致：
//! - `content` 与 `reasoning_content` 分道，**推理只发长度、绝不发文本**；
//! - 见过推理之后的 content token 标注为 `final`，前端闸门据此可以直通；
//! - 只有推理没有正文时仍然报「没有返回可显示的文本」。
//!
//! 目标地址由本进程持有，前端**不能**指定——和 Node 版一样，这不是开放代理。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
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

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub task: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// 与前端 `streamModel` 消费的 SSE 事件一一对应。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token {
        text: String,
        channel: &'static str,
    },
    /// **只带长度**。推理文本绝不离开本进程。
    Reasoning {
        chars: usize,
    },
    Error {
        message: String,
    },
    Done {
        stopped: bool,
    },
}

const ALLOWED_TASKS: [&str; 4] = ["chat", "concept-preview", "title", "concepts"];
const ALLOWED_ROLES: [&str; 3] = ["system", "user", "assistant"];

fn validate(request: &ChatRequest) -> Result<()> {
    if !ALLOWED_TASKS.contains(&request.task.as_str()) {
        return Err("不支持的模型任务。".into());
    }
    if request.messages.is_empty() {
        return Err("缺少对话内容。".into());
    }
    for message in &request.messages {
        if !ALLOWED_ROLES.contains(&message.role.as_str()) {
            return Err("对话角色不正确。".into());
        }
        if message.content.is_empty() {
            return Err("对话内容不能为空。".into());
        }
    }
    Ok(())
}

pub fn friendly_provider_error(status: u16, body: &str) -> String {
    match status {
        401 => "模型服务未配置或密钥无效，请在设置页填写。".into(),
        429 => "模型服务暂时限流，请稍后重试。".into(),
        s if s >= 500 => "模型服务暂时不可用，请稍后重试。".into(),
        _ => {
            let trimmed: String = body.chars().take(280).collect();
            if trimmed.is_empty() {
                "模型服务返回了无法处理的响应。".into()
            } else {
                trimmed
            }
        }
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
// 与 Node 版 `.env.local` 的安全姿态一致：写在应用数据目录，权限 0600，
// 临时文件 + rename 保证原子。
//
// **钥匙串留到 S5**：macOS 把钥匙串 ACL 绑在代码签名身份上，而稳定签名正是 S5
// 的内容。在那之前用钥匙串意味着每次重新构建都会丢掉已存的密钥。
// ---------------------------------------------------------------------------

pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("provider.json")
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

fn body_for(config: &ProviderConfig, request: &ChatRequest, stream: bool) -> Value {
    json!({
        "model": config.model,
        "stream": stream,
        "messages": request.messages.iter().map(|m| json!({
            "role": m.role, "content": m.content
        })).collect::<Vec<_>>(),
        "temperature": request.temperature.unwrap_or(0.35).clamp(0.0, 1.0),
    })
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
    let response = agent()
        .get(&format!("{}/models", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .timeout(std::time::Duration::from_secs(8))
        .call();
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
        Err(e) => ProviderHealth {
            configured: false,
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            message: format!("无法连接模型服务：{e}"),
        },
    }
}

pub fn generate(config: &ProviderConfig, request: &ChatRequest) -> Result<String> {
    validate(request)?;
    if config.api_key.is_empty() {
        return Err("模型服务未配置或密钥无效，请在设置页填写。".into());
    }
    let response = agent()
        .post(&format!("{}/chat/completions", config.base_url))
        .set("authorization", &format!("Bearer {}", config.api_key))
        .set("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(90))
        .send_json(body_for(config, request, false));
    match response {
        Ok(res) => {
            let value: Value = serde_json::from_str(&res.into_string()?)?;
            let content = extract_message(&value);
            if content.is_empty() {
                Err("模型没有返回内容。".into())
            } else {
                Ok(content)
            }
        }
        Err(ureq::Error::Status(status, res)) => Err(Error(friendly_provider_error(
            status,
            &res.into_string().unwrap_or_default(),
        ))),
        Err(e) => Err(Error(format!("模型连接中断，请重试：{e}"))),
    }
}

/// 流式转发。事件经 Tauri `Channel` 推给前端，替代浏览器里的 SSE 解析循环。
pub fn stream(
    config: &ProviderConfig,
    request: &ChatRequest,
    channel: &Channel<StreamEvent>,
) -> Result<()> {
    if let Err(e) = validate(request) {
        let _ = channel.send(StreamEvent::Error {
            message: e.to_string(),
        });
        let _ = channel.send(StreamEvent::Done { stopped: false });
        return Ok(());
    }
    if config.api_key.is_empty() {
        let _ = channel.send(StreamEvent::Error {
            message: "模型服务未配置或密钥无效，请在设置页填写。".into(),
        });
        let _ = channel.send(StreamEvent::Done { stopped: false });
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
            });
            let _ = channel.send(StreamEvent::Done { stopped: false });
            return Ok(());
        }
        Err(e) => {
            let _ = channel.send(StreamEvent::Error {
                message: format!("模型连接中断，请重试：{e}"),
            });
            let _ = channel.send(StreamEvent::Done { stopped: false });
            return Ok(());
        }
    };

    let mut emitted = false;
    let mut saw_reasoning = false;
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            // 非 JSON 的心跳帧不该打断这条流。
            continue;
        };
        let (content, reasoning) = extract_delta(&payload);
        if !reasoning.is_empty() {
            saw_reasoning = true;
            let _ = channel.send(StreamEvent::Reasoning {
                chars: reasoning.chars().count(),
            });
        }
        if !content.is_empty() {
            // `emitted` 只由 content 驱动：只有推理没有正文时仍要报错。
            emitted = true;
            let _ = channel.send(StreamEvent::Token {
                text: content,
                channel: if saw_reasoning { "final" } else { "unknown" },
            });
        }
    }

    if !emitted {
        let _ = channel.send(StreamEvent::Error {
            message: "模型没有返回可显示的文本，请重试。".into(),
        });
    }
    let _ = channel.send(StreamEvent::Done { stopped: false });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_and_content_are_separated() {
        let payload = json!({"choices":[{"delta":{
            "content":"正文","reasoning_content":"Since the user asked, I will plan."}}]});
        let (content, reasoning) = extract_delta(&payload);
        assert_eq!(content, "正文");
        assert!(reasoning.contains("the user"));
        // 事件只带长度，文本永远不离开本进程。
        let event = StreamEvent::Reasoning {
            chars: reasoning.chars().count(),
        };
        let wire = serde_json::to_string(&event).unwrap();
        assert!(
            !wire.contains("the user"),
            "推理文本泄漏到了发往前端的事件里"
        );
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
    fn config_is_written_owner_only() {
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

    #[test]
    fn unsupported_tasks_and_roles_are_refused() {
        let bad_task = ChatRequest {
            task: "shell".into(),
            messages: vec![Message {
                role: "user".into(),
                content: "x".into(),
            }],
            temperature: None,
        };
        assert!(validate(&bad_task).is_err());

        let bad_role = ChatRequest {
            task: "chat".into(),
            messages: vec![Message {
                role: "root".into(),
                content: "x".into(),
            }],
            temperature: None,
        };
        assert!(validate(&bad_role).is_err());
    }
}
