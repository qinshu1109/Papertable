#[path = "../../../../../src-tauri/src/llm.rs"]
mod llm;

use llm::{ChatRequest, Message, ProviderConfig, ToolDefinition, ToolFunction};
use serde_json::{json, Value};
use std::path::PathBuf;

fn search_tool() -> ToolDefinition {
    ToolDefinition {
        r#type: Some("function".into()),
        function: ToolFunction {
            name: "search_notes".into(),
            description: Some("Search a bound read-only note library.".into()),
            parameters: Some(json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
                "additionalProperties": false
            })),
        },
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::var_os("PAPERTABLE_PROVIDER_CONFIG")
        .map(PathBuf::from)
        .ok_or("set PAPERTABLE_PROVIDER_CONFIG to the owner-only provider.json")?;
    let metadata = std::fs::metadata(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("provider.json is not owner-only (0600)".into());
        }
    }
    let config: ProviderConfig = llm::load_config(&path);
    if config.api_key.is_empty() {
        return Err("provider.json has no API key".into());
    }
    let capability = llm::probe_capability(&config);

    let mut request = ChatRequest {
        task: "agent".into(),
        messages: vec![
            Message {
                role: "system".into(),
                content: Some(
                    "Call search_notes exactly once, then answer with the tool result.".into(),
                ),
                tool_calls: vec![],
                tool_call_id: None,
            },
            Message {
                role: "user".into(),
                content: Some("Find the TASK-001 bridge evidence.".into()),
                tool_calls: vec![],
                tool_call_id: None,
            },
        ],
        temperature: Some(0.0),
        tools: vec![search_tool()],
        tool_choice: Some(json!({
            "type": "function",
            "function": { "name": "search_notes" }
        })),
    };

    let first = llm::complete(&config, &request)?;
    let call = first
        .tool_calls
        .first()
        .ok_or("flagship model did not return a tool call")?
        .clone();
    if call.name != "search_notes" {
        return Err(format!("unexpected tool: {}", call.name).into());
    }

    request.messages.push(Message {
        role: "assistant".into(),
        content: (!first.content.is_empty()).then_some(first.content),
        tool_calls: first.tool_calls,
        tool_call_id: None,
    });
    request.messages.push(Message {
        role: "tool".into(),
        content: Some("{\"hits\":[{\"title\":\"TASK-001\",\"text\":\"rust bridge ok\"}]}".into()),
        tool_calls: vec![],
        tool_call_id: Some(call.id),
    });
    request.tool_choice = Some(Value::String("none".into()));

    let second = llm::complete(&config, &request);
    let final_text_present = second
        .as_ref()
        .is_ok_and(|completion| !completion.content.trim().is_empty());
    let final_tool_names = second
        .as_ref()
        .map(|completion| {
            completion
                .tool_calls
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "providerConfigMode": "owner-only-file",
            "providerFileModeChecked": true,
            "model": config.model,
            "apiKeyExposed": false,
            "capabilityMode": capability.mode,
            "streamingToolCalls": capability.streaming_tool_calls,
            "capabilityToolResultAccepted": capability.tool_result_accepted,
            "firstTurnTool": call.name,
            "customRoundRequestAccepted": second.is_ok(),
            "finalTextPresent": final_text_present,
            "finalToolNames": final_tool_names,
            "customRoundError": second.err().map(|_| "sanitized-provider-error")
        }))?
    );
    if !final_text_present {
        return Err("flagship model returned no final text after the tool result".into());
    }
    Ok(())
}
