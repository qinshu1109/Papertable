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
// 密钥进系统钥匙串，其余（接口地址、模型名）留在应用数据目录的 0600 文件里。
//
// 这一步之所以放在 ad-hoc 签名之后：macOS 把钥匙串 ACL 绑在**代码签名身份**上，
// 没有稳定身份时，每次重新构建都是一个「新」应用，会丢掉已存的密钥。
//
// 钥匙串取不到时回落到文件（未签名的开发构建、或用户拒绝了授权）。回落是显式的，
// 不是静默的——`key_source()` 会把实际来源报给设置页，免得用户以为密钥进了钥匙串
// 而其实躺在文件里。
// ---------------------------------------------------------------------------

#[cfg(not(test))]
const KEYRING_SERVICE: &str = "com.papertable.app";
#[cfg(not(test))]
const KEYRING_USER: &str = "provider-api-key";

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    Keychain,
    /// 钥匙串不可用时的回落：应用数据目录里的 0600 文件。
    File,
    None,
}

/// **单元测试完全不碰钥匙串。**
///
/// 两个理由，都是踩过的：
/// 1. 用真实服务名时，`cargo test` 把假密钥 `"k"` 写进了用户真实的钥匙串，覆盖掉
///    真密钥——应用随后拿着 `"k"` 请求，报 INVALID_API_KEY。测试破坏了环境。
/// 2. 换成独立服务名之后，未签名的测试二进制创建新条目会弹系统授权框，在
///    非交互环境里直接把 `cargo test` 挂死。
///
/// 单元测试因此只走文件回落分支——那本来也是它该验的部分。钥匙串路径由签名后的
/// 应用在首次保存时走通，见 docs/DESKTOP.md。
#[cfg(test)]
fn read_keychain() -> Option<String> {
    None
}
#[cfg(test)]
fn write_keychain(_key: &str) -> bool {
    false
}

#[cfg(not(test))]
fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

#[cfg(not(test))]
fn read_keychain() -> Option<String> {
    let value = keyring_entry()?.get_password().ok()?;
    (!value.is_empty()).then_some(value)
}

/// 写钥匙串；不可用时返回 false，由调用方回落到文件。
#[cfg(not(test))]
fn write_keychain(key: &str) -> bool {
    let Some(entry) = keyring_entry() else {
        return false;
    };
    if key.is_empty() {
        // 清空密钥时把条目一并删掉，别在钥匙串里留一条空记录。
        let _ = entry.delete_credential();
        return true;
    }
    entry.set_password(key).is_ok()
}

pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("provider.json")
}

/// 密钥实际来自哪里。设置页要如实展示，不能让用户以为它在钥匙串里。
pub fn key_source(config: &ProviderConfig, from_keychain: bool) -> KeySource {
    if config.api_key.is_empty() {
        KeySource::None
    } else if from_keychain {
        KeySource::Keychain
    } else {
        KeySource::File
    }
}

/// 读配置：密钥优先取钥匙串，取不到再看文件里的回落值。
pub fn load_config_with_source(path: &Path) -> (ProviderConfig, bool) {
    let mut config = load_config(path);
    if let Some(key) = read_keychain() {
        config.api_key = key;
        return (config, true);
    }
    (config, false)
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

/// 保存配置。密钥优先进钥匙串；进去了就**不再写进文件**，避免磁盘上留一份副本。
pub fn save_config(path: &Path, config: &ProviderConfig) -> Result<bool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let in_keychain = write_keychain(&config.api_key);
    let body = serde_json::to_string_pretty(&json!({
        "baseUrl": config.base_url,
        "model": config.model,
        // 钥匙串写成功后文件里不再留密钥；失败才回落。
        "apiKey": if in_keychain { "" } else { config.api_key.as_str() },
    }))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body)?;
    set_owner_only(&temp)?;
    std::fs::rename(&temp, path)?;
    set_owner_only(path)?;
    Ok(in_keychain)
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
    tap: &SseTap,
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
        tap.write(data);
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
    fn the_config_file_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        let config = ProviderConfig {
            api_key: "k".into(),
            ..Default::default()
        };
        let in_keychain = save_config(&path, &config).unwrap();
        // 钥匙串写成功时文件里不该再留密钥；失败才回落到文件。
        assert_eq!(
            load_config(&path).api_key,
            if in_keychain { "" } else { "k" }
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "组和其他用户不得有任何权限");
        }
    }

    /// 密钥来源必须如实上报。回落到文件却显示「已进钥匙串」，会让用户以为磁盘上
    /// 没有明文密钥。
    #[test]
    fn the_key_source_is_reported_honestly() {
        let empty = ProviderConfig::default();
        assert_eq!(key_source(&empty, true), KeySource::None);
        assert_eq!(key_source(&empty, false), KeySource::None);
        let with_key = ProviderConfig {
            api_key: "k".into(),
            ..Default::default()
        };
        assert_eq!(key_source(&with_key, true), KeySource::Keychain);
        assert_eq!(key_source(&with_key, false), KeySource::File);
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
