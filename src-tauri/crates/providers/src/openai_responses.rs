use async_trait::async_trait;
use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use futures::Stream;

use crate::{ProviderAdapter, ProviderRequestContext, build_http_client, resolve_chat_url};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIResponsesAdapter {
    client: reqwest::Client,
}

impl OpenAIResponsesAdapter {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    fn base_url(ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn chat_url(ctx: &ProviderRequestContext) -> String {
        resolve_chat_url(&Self::base_url(ctx), ctx.api_path.as_deref(), "/responses")
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

// --- Responses API request types ---

#[derive(Serialize)]
struct ResponsesRequest {
    model: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ResponsesTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ResponsesReasoning>,
}

#[derive(Serialize)]
struct ResponsesTool {
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ResponsesReasoning {
    effort: String,
}

// --- Responses API response types ---

#[derive(Deserialize)]
struct ResponsesResponse {
    id: Option<String>,
    model: Option<String>,
    output: Vec<ResponsesOutputItem>,
    usage: Option<ResponsesUsage>,
}

#[derive(Deserialize)]
struct ResponsesOutputItem {
    r#type: String,
    #[serde(default)]
    content: Vec<ResponsesContentPart>,
    // function_call fields
    id: Option<String>,
    call_id: Option<String>,
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct ResponsesContentPart {
    r#type: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct ResponsesUsage {
    input_tokens: u32,
    output_tokens: u32,
    total_tokens: u32,
}

// --- Streaming event types ---

#[derive(Deserialize)]
struct StreamTextDelta {
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamTextDeltaEvent {
    #[serde(default)]
    part: Option<StreamTextDelta>,
    // For top-level delta field (some providers)
    #[serde(default)]
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamFunctionCallArgsDelta {
    item_id: Option<String>,
    #[serde(default)]
    delta: Option<String>,
}

#[derive(Deserialize)]
struct StreamFunctionCallArgsDone {
    item_id: Option<String>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct StreamOutputItemAdded {
    item: Option<StreamOutputItem>,
}

#[derive(Deserialize)]
struct StreamOutputItem {
    id: Option<String>,
    r#type: Option<String>,
    name: Option<String>,
    call_id: Option<String>,
}

#[derive(Deserialize)]
struct StreamCompletedEvent {
    response: Option<ResponsesResponse>,
}

// --- Models types (reuse OpenAI format) ---

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

// --- Embedding types (reuse OpenAI format) ---

#[derive(Serialize)]
struct EmbedReq {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResp {
    data: Vec<EmbedDataItem>,
}

#[derive(Deserialize)]
struct EmbedDataItem {
    embedding: Vec<f32>,
}

// --- Helper functions ---

fn extract_text_content(content: &ChatContent) -> String {
    match content {
        ChatContent::Text(text) => text.clone(),
        ChatContent::Multipart(parts) => {
            parts.iter()
                .filter_map(|part| part.text.as_ref())
                .cloned()
                .collect::<Vec<String>>()
                .join(" ")
        }
    }
}

fn convert_content_to_value(content: &ChatContent) -> serde_json::Value {
    match content {
        ChatContent::Text(text) => serde_json::Value::String(text.clone()),
        ChatContent::Multipart(parts) => {
            serde_json::Value::Array(
                parts
                    .iter()
                    .map(|part| {
                        let mut value = serde_json::Map::new();
                        value.insert("type".to_string(), serde_json::Value::String(part.r#type.clone()));
                        if let Some(text) = &part.text {
                            value.insert("text".to_string(), serde_json::Value::String(text.clone()));
                        }
                        if let Some(image_url) = &part.image_url {
                            value.insert(
                                "image_url".to_string(),
                                serde_json::to_value(image_url).unwrap_or(serde_json::Value::Null),
                            );
                        }
                        serde_json::Value::Object(value)
                    })
                    .collect(),
            )
        }
    }
}

/// Convert internal ChatMessage array → Responses API `input` + `instructions`.
fn build_responses_input(messages: &[ChatMessage]) -> (serde_json::Value, Option<String>) {
    let mut instructions: Option<String> = None;
    let mut input_items: Vec<serde_json::Value> = Vec::new();

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                let text = extract_text_content(&msg.content);
                if !text.is_empty() {
                    match &mut instructions {
                        Some(existing) => {
                            existing.push('\n');
                            existing.push_str(&text);
                        }
                        None => instructions = Some(text),
                    }
                }
            }
            "user" => {
                let mut item = serde_json::Map::new();
                item.insert("role".to_string(), serde_json::Value::String("user".to_string()));
                item.insert("content".to_string(), convert_content_to_value(&msg.content));
                input_items.push(serde_json::Value::Object(item));
            }
            "assistant" => {
                if let Some(ref tool_calls) = msg.tool_calls {
                    // Emit text part if present
                    let text = extract_text_content(&msg.content);
                    if !text.is_empty() {
                        let mut item = serde_json::Map::new();
                        item.insert("role".to_string(), serde_json::Value::String("assistant".to_string()));
                        item.insert("content".to_string(), serde_json::Value::String(text));
                        input_items.push(serde_json::Value::Object(item));
                    }
                    // Emit function_call items for each tool call
                    for tc in tool_calls {
                        let mut item = serde_json::Map::new();
                        item.insert("type".to_string(), serde_json::Value::String("function_call".to_string()));
                        item.insert("id".to_string(), serde_json::Value::String(tc.id.clone()));
                        item.insert("call_id".to_string(), serde_json::Value::String(tc.id.clone()));
                        item.insert("name".to_string(), serde_json::Value::String(tc.function.name.clone()));
                        item.insert("arguments".to_string(), serde_json::Value::String(tc.function.arguments.clone()));
                        input_items.push(serde_json::Value::Object(item));
                    }
                } else {
                    let mut item = serde_json::Map::new();
                    item.insert("role".to_string(), serde_json::Value::String("assistant".to_string()));
                    item.insert("content".to_string(), convert_content_to_value(&msg.content));
                    input_items.push(serde_json::Value::Object(item));
                }
            }
            "tool" => {
                let mut item = serde_json::Map::new();
                item.insert("type".to_string(), serde_json::Value::String("function_call_output".to_string()));
                item.insert("call_id".to_string(), serde_json::Value::String(
                    msg.tool_call_id.clone().unwrap_or_default()
                ));
                item.insert("output".to_string(), serde_json::Value::String(
                    extract_text_content(&msg.content)
                ));
                input_items.push(serde_json::Value::Object(item));
            }
            _ => {
                let mut item = serde_json::Map::new();
                item.insert("role".to_string(), serde_json::Value::String(msg.role.clone()));
                item.insert("content".to_string(), convert_content_to_value(&msg.content));
                input_items.push(serde_json::Value::Object(item));
            }
        }
    }

    (serde_json::Value::Array(input_items), instructions)
}

fn build_request(request: &ChatRequest, stream: bool) -> ResponsesRequest {
    let (input, instructions) = build_responses_input(&request.messages);

    let reasoning = request.thinking_budget.map(|b| {
        let effort = match b {
            0 => "none",
            1..=2048 => "low",
            2049..=6144 => "medium",
            6145..=12288 => "high",
            _ => "xhigh",
        };
        ResponsesReasoning { effort: effort.to_string() }
    });

    let tools = request.tools.as_ref().map(|tools| {
        tools.iter().map(|t| ResponsesTool {
            r#type: "function".to_string(),
            name: Some(t.function.name.clone()),
            description: t.function.description.clone(),
            parameters: t.function.parameters.clone(),
        }).collect()
    });

    ResponsesRequest {
        model: request.model.clone(),
        input,
        instructions,
        max_output_tokens: request.max_tokens.map(|v| v.max(16)),
        temperature: if reasoning.is_some() { None } else { request.temperature },
        top_p: if reasoning.is_some() { None } else { request.top_p },
        stream,
        tools,
        reasoning,
    }
}

/// Extract text + tool_calls from a non-streaming Responses API response.
fn parse_response_output(output: &[ResponsesOutputItem]) -> (String, Option<Vec<ToolCall>>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for item in output {
        match item.r#type.as_str() {
            "message" => {
                for part in &item.content {
                    if part.r#type == "output_text" {
                        if let Some(ref text) = part.text {
                            text_parts.push(text.clone());
                        }
                    }
                }
            }
            "function_call" => {
                tool_calls.push(ToolCall {
                    id: item.call_id.clone().or_else(|| item.id.clone()).unwrap_or_default(),
                    call_type: "function".to_string(),
                    function: ToolCallFunction {
                        name: item.name.clone().unwrap_or_default(),
                        arguments: item.arguments.clone().unwrap_or_default(),
                    },
                });
            }
            _ => {}
        }
    }

    let tool_calls = if tool_calls.is_empty() { None } else { Some(tool_calls) };
    (text_parts.join(""), tool_calls)
}

#[async_trait]
impl ProviderAdapter for OpenAIResponsesAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let url = Self::chat_url(ctx);
        let body = build_request(&request, false);

        let resp = self
            .get_client(ctx)?
            .post(&url)
            .header("Authorization", format!("Bearer {}", ctx.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "OpenAI Responses API error {status}: {text}"
            )));
        }

        let oai: ResponsesResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let (content, tool_calls) = parse_response_output(&oai.output);

        let usage = oai.usage.map(|u| TokenUsage {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.total_tokens,
        }).unwrap_or(TokenUsage { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

        Ok(ChatResponse {
            id: oai.id.unwrap_or_default(),
            model: oai.model.unwrap_or_else(|| request.model.clone()),
            content,
            thinking: None,
            usage,
            tool_calls,
        })
    }

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        let client = self.get_client(ctx).unwrap_or_else(|_| self.client.clone());
        let api_key = ctx.api_key.clone();
        let url = Self::chat_url(ctx);
        let body = build_request(&request, true);

        let (tx, rx) = futures::channel::mpsc::unbounded();

        tokio::spawn(async move {
            let resp = match client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    let s = r.status();
                    let t = r.text().await.unwrap_or_default();
                    let _ = tx.unbounded_send(Err(AQBotError::Provider(format!(
                        "OpenAI Responses API error {s}: {t}"
                    ))));
                    return;
                }
                Err(e) => {
                    let _ = tx.unbounded_send(Err(AQBotError::Provider(format!(
                        "Request failed: {e}"
                    ))));
                    return;
                }
            };

            let mut byte_stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut current_event_type = String::new();
            // Track function calls: item_id → (call_id, name, arguments)
            let mut pending_tool_calls: std::collections::HashMap<String, (String, String, String)> = std::collections::HashMap::new();

            while let Some(chunk) = byte_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end().to_string();
                            buf = buf[pos + 1..].to_string();

                            if line.is_empty() {
                                current_event_type.clear();
                                continue;
                            }

                            if let Some(event_type) = line.strip_prefix("event: ") {
                                current_event_type = event_type.trim().to_string();
                                continue;
                            }

                            let data = if let Some(d) = line.strip_prefix("data: ") {
                                d
                            } else if let Some(d) = line.strip_prefix("data:") {
                                d
                            } else {
                                continue;
                            };

                            if data.trim() == "[DONE]" {
                                let tool_calls = if pending_tool_calls.is_empty() {
                                    None
                                } else {
                                    Some(pending_tool_calls.values().map(|(call_id, name, args)| {
                                        ToolCall {
                                            id: call_id.clone(),
                                            call_type: "function".to_string(),
                                            function: ToolCallFunction {
                                                name: name.clone(),
                                                arguments: args.clone(),
                                            },
                                        }
                                    }).collect())
                                };
                                let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                    content: None,
                                    thinking: None,
                                    done: true,
                                    is_final: None,
                                    usage: None,
                                    tool_calls,
                                }));
                                return;
                            }

                            match current_event_type.as_str() {
                                "response.output_text.delta" => {
                                    if let Ok(evt) = serde_json::from_str::<StreamTextDeltaEvent>(data) {
                                        let delta_text = evt.part
                                            .and_then(|p| p.delta)
                                            .or(evt.delta);
                                        if delta_text.is_some() {
                                            let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                                content: delta_text,
                                                thinking: None,
                                                done: false,
                                                is_final: None,
                                                usage: None,
                                                tool_calls: None,
                                            }));
                                        }
                                    }
                                }
                                "response.output_item.added" => {
                                    if let Ok(evt) = serde_json::from_str::<StreamOutputItemAdded>(data) {
                                        if let Some(item) = evt.item {
                                            if item.r#type.as_deref() == Some("function_call") {
                                                let item_id = item.id.unwrap_or_default();
                                                let call_id = item.call_id.unwrap_or_else(|| item_id.clone());
                                                let name = item.name.unwrap_or_default();
                                                pending_tool_calls.insert(item_id, (call_id, name, String::new()));
                                            }
                                        }
                                    }
                                }
                                "response.function_call_arguments.delta" => {
                                    if let Ok(evt) = serde_json::from_str::<StreamFunctionCallArgsDelta>(data) {
                                        if let Some(item_id) = &evt.item_id {
                                            if let Some(entry) = pending_tool_calls.get_mut(item_id) {
                                                if let Some(ref d) = evt.delta {
                                                    entry.2.push_str(d);
                                                }
                                            }
                                        }
                                    }
                                }
                                "response.function_call_arguments.done" => {
                                    if let Ok(evt) = serde_json::from_str::<StreamFunctionCallArgsDone>(data) {
                                        if let (Some(item_id), Some(args)) = (&evt.item_id, &evt.arguments) {
                                            if let Some(entry) = pending_tool_calls.get_mut(item_id) {
                                                entry.2 = args.clone();
                                            }
                                        }
                                    }
                                }
                                "response.completed" => {
                                    if let Ok(evt) = serde_json::from_str::<StreamCompletedEvent>(data) {
                                        let usage = evt.response.and_then(|r| r.usage).map(|u| TokenUsage {
                                            prompt_tokens: u.input_tokens,
                                            completion_tokens: u.output_tokens,
                                            total_tokens: u.total_tokens,
                                        });
                                        let tool_calls = if pending_tool_calls.is_empty() {
                                            None
                                        } else {
                                            Some(pending_tool_calls.drain().map(|(_, (call_id, name, args))| {
                                                ToolCall {
                                                    id: call_id,
                                                    call_type: "function".to_string(),
                                                    function: ToolCallFunction {
                                                        name,
                                                        arguments: args,
                                                    },
                                                }
                                            }).collect())
                                        };
                                        let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                                            content: None,
                                            thinking: None,
                                            done: true,
                                            is_final: None,
                                            usage,
                                            tool_calls,
                                        }));
                                        return;
                                    }
                                }
                                // Ignore other event types (response.created, response.in_progress, etc.)
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.unbounded_send(Err(AQBotError::Provider(format!(
                            "Stream error: {e}"
                        ))));
                        return;
                    }
                }
            }

            // Stream ended without explicit completion event
            let tool_calls = if pending_tool_calls.is_empty() {
                None
            } else {
                Some(pending_tool_calls.drain().map(|(_, (call_id, name, args))| {
                    ToolCall {
                        id: call_id,
                        call_type: "function".to_string(),
                        function: ToolCallFunction {
                            name,
                            arguments: args,
                        },
                    }
                }).collect())
            };
            let _ = tx.unbounded_send(Ok(ChatStreamChunk {
                content: None,
                thinking: None,
                done: true,
                is_final: None,
                usage: None,
                tool_calls,
            }));
        });

        Box::pin(rx)
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        let url = format!("{}/models", Self::base_url(ctx));

        let resp = self
            .get_client(ctx)?
            .get(&url)
            .header("Authorization", format!("Bearer {}", ctx.api_key))
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!("OpenAI API error {s}: {t}")));
        }

        let models: ModelsResponse = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        Ok(models
            .data
            .into_iter()
            .map(|m| {
                let model_type = ModelType::detect(&m.id);
                let mut caps = match model_type {
                    ModelType::Chat => vec![ModelCapability::TextChat],
                    ModelType::Embedding => vec![],
                    ModelType::Voice => vec![ModelCapability::RealtimeVoice],
                };
                let id_lower = m.id.to_lowercase();
                if id_lower.contains("gpt-4o") || id_lower.contains("gpt-4-turbo")
                    || id_lower.contains("claude") || id_lower.contains("vision")
                {
                    caps.push(ModelCapability::Vision);
                }
                if id_lower.starts_with("o1") || id_lower.starts_with("o3") || id_lower.starts_with("o4") {
                    caps.push(ModelCapability::Reasoning);
                }
                Model {
                    provider_id: ctx.provider_id.clone(),
                    model_id: m.id.clone(),
                    name: m.id,
                    group_name: None,
                    model_type,
                    capabilities: caps,
                    max_tokens: None,
                    enabled: true,
                    param_overrides: None,
                }
            })
            .collect())
    }

    async fn embed(&self, ctx: &ProviderRequestContext, request: EmbedRequest) -> Result<EmbedResponse> {
        let url = format!("{}/embeddings", Self::base_url(ctx));
        let body = EmbedReq {
            model: request.model,
            input: request.input,
        };

        let resp = self
            .get_client(ctx)?
            .post(&url)
            .header("Authorization", format!("Bearer {}", ctx.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Request failed: {e}")))?;

        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!("OpenAI API error {s}: {t}")));
        }

        let result: EmbedResp = resp
            .json()
            .await
            .map_err(|e| AQBotError::Provider(format!("Parse error: {e}")))?;

        let dimensions = result.data.first().map(|d| d.embedding.len()).unwrap_or(0);
        let embeddings: Vec<Vec<f32>> = result.data.into_iter().map(|d| d.embedding).collect();

        Ok(EmbedResponse {
            embeddings,
            dimensions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_messages_become_instructions() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text("You are helpful.".to_string()),
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("Hello".to_string()),
                tool_calls: None,
                tool_call_id: None,
            },
        ];

        let (input, instructions) = build_responses_input(&messages);
        assert_eq!(instructions.as_deref(), Some("You are helpful."));
        let arr = input.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[0]["content"], "Hello");
    }

    #[test]
    fn tool_call_messages_convert_correctly() {
        let messages = vec![
            ChatMessage {
                role: "assistant".to_string(),
                content: ChatContent::Text("".to_string()),
                tool_calls: Some(vec![ToolCall {
                    id: "call_1".to_string(),
                    call_type: "function".to_string(),
                    function: ToolCallFunction {
                        name: "get_weather".to_string(),
                        arguments: r#"{"city":"SF"}"#.to_string(),
                    },
                }]),
                tool_call_id: None,
            },
            ChatMessage {
                role: "tool".to_string(),
                content: ChatContent::Text("Sunny, 72F".to_string()),
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
            },
        ];

        let (input, _) = build_responses_input(&messages);
        let arr = input.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "function_call");
        assert_eq!(arr[0]["name"], "get_weather");
        assert_eq!(arr[1]["type"], "function_call_output");
        assert_eq!(arr[1]["call_id"], "call_1");
        assert_eq!(arr[1]["output"], "Sunny, 72F");
    }

    #[test]
    fn parse_response_extracts_text_and_tool_calls() {
        let output = vec![
            ResponsesOutputItem {
                r#type: "message".to_string(),
                content: vec![ResponsesContentPart {
                    r#type: "output_text".to_string(),
                    text: Some("Hello!".to_string()),
                }],
                id: None,
                call_id: None,
                name: None,
                arguments: None,
            },
            ResponsesOutputItem {
                r#type: "function_call".to_string(),
                content: vec![],
                id: Some("fc_1".to_string()),
                call_id: Some("call_1".to_string()),
                name: Some("search".to_string()),
                arguments: Some(r#"{"q":"test"}"#.to_string()),
            },
        ];

        let (text, tool_calls) = parse_response_output(&output);
        assert_eq!(text, "Hello!");
        let tcs = tool_calls.unwrap();
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].function.name, "search");
    }

    #[test]
    fn build_request_maps_max_tokens_to_max_output_tokens() {
        let request = ChatRequest {
            model: "gpt-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: Some(0.7),
            top_p: None,
            max_tokens: Some(100),
            tools: None,
            thinking_budget: None,
            use_max_completion_tokens: None,
        };
        let built = build_request(&request, false);
        assert_eq!(built.max_output_tokens, Some(100));
        assert_eq!(built.temperature, Some(0.7));
        assert!(!built.stream);
    }

    #[test]
    fn build_request_enforces_min_max_output_tokens() {
        let request = ChatRequest {
            model: "gpt-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: Some(1),
            tools: None,
            thinking_budget: None,
            use_max_completion_tokens: None,
        };
        let built = build_request(&request, false);
        assert_eq!(built.max_output_tokens, Some(16));
    }
}
