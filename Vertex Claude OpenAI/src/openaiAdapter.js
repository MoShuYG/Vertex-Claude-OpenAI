// src/openaiAdapter.js

/**
 * 将 OpenAI Chat Completions 请求体转换为 Claude Messages 请求参数
 * 只处理常见字段：messages / tools / tool_choice / stop / temperature / top_p / top_k / max_tokens / metadata
 * 另外扩展：
 *   - claude_thinking: 直通 Claude extended thinking
 *   - claude_metadata: 合并进 metadata
 */
function mapOpenAIRequestToClaude(body) {
  const {
    messages: oaiMessages = [],
    tools: oaiTools,
    tool_choice,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop,
    metadata,
    claude_thinking,
    claude_metadata
  } = body;

  const systemPieces = [];
  const claudeMessages = [];

  for (const msg of oaiMessages) {
    const role = msg.role;

    // system -> 合并成一个 top-level system 字符串
    if (role === "system") {
      const text = extractTextFromContent(msg.content);
      if (text) systemPieces.push(text);
      continue;
    }

    // OpenAI 的 tool result 消息：role = "tool"
    if (role === "tool") {
      const toolUseId = msg.tool_call_id || msg.name || "tool_use";
      const text = extractTextFromContent(msg.content) || "";
      claudeMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: text
          }
        ]
      });
      continue;
    }

    // user / assistant
    const contentBlocks = [];

    // assistant 工具调用 -> Claude 的 tool_use block
    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || tc.type !== "function" || !tc.function) continue;
        let inputObj;
        const args = tc.function.arguments;
        if (typeof args === "string") {
          try {
            inputObj = JSON.parse(args);
          } catch {
            inputObj = args;
          }
        } else if (args && typeof args === "object") {
          inputObj = args;
        } else {
          inputObj = {};
        }
        contentBlocks.push({
          type: "tool_use",
          id: tc.id || tc.function.name,
          name: tc.function.name,
          input: inputObj
        });
      }
    }

    // 文本内容
    const text = extractTextFromContent(msg.content);
    if (text && text.trim().length > 0) {
      contentBlocks.push({ type: "text", text });
    }

    claudeMessages.push({
      role: role === "assistant" ? "assistant" : "user",
      content:
        contentBlocks.length > 0
          ? contentBlocks
          : [{ type: "text", text: "" }]
    });
  }

  const system = systemPieces.length ? systemPieces.join("\n\n") : undefined;

  const claudeTools = convertTools(oaiTools);
  const claudeToolChoice = convertToolChoice(tool_choice);
  const stop_sequences = !stop
    ? undefined
    : Array.isArray(stop)
    ? stop
    : [stop];

  const mergedMetadata = {
    ...(metadata || {}),
    ...(claude_metadata || {})
  };

  return {
    system,
    messages: claudeMessages,
    tools: claudeTools,
    tool_choice: claudeToolChoice,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    metadata: Object.keys(mergedMetadata).length ? mergedMetadata : undefined,
    thinking: claude_thinking
  };
}

/**
 * 提取 OpenAI message.content 中的纯文本
 * - content 可以是 string
 * - 或 [{type: 'text', text: '...'}, {type:'image_url', ...}]
 * 这里只提取 text，忽略图片（如果要 vision，建议直接用 Claude 原生 schema 传）
 */
function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (part.type === "text" && part.text) return part.text;
        // 其他类型暂时忽略
        return "";
      })
      .join("");
  }

  // OpenAI 里也可能出现 {type:'text', text:'...'} 这样的 content
  if (typeof content === "object" && content.type === "text") {
    return content.text || "";
  }

  return "";
}

/**
 * OpenAI tools -> Claude tools
 */
function convertTools(oaiTools) {
  if (!Array.isArray(oaiTools) || oaiTools.length === 0) return undefined;
  const result = [];
  for (const t of oaiTools) {
    if (!t || t.type !== "function" || !t.function) continue;
    result.push({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    });
  }
  return result.length ? result : undefined;
}

/**
 * OpenAI tool_choice -> Claude tool_choice
 *
 * OpenAI:
 *  - "auto" | "none" | { type:"function", function:{name} }
 * Claude:
 *  - {type:"auto"} | {type:"tool", name:"..."} | "any" 等
 */
function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "none") return undefined; // 等价于不启用 tools
    return undefined;
  }
  if (
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function &&
    toolChoice.function.name
  ) {
    return {
      type: "tool",
      name: toolChoice.function.name
    };
  }
  return undefined;
}

/**
 * 将 Claude 的 message 响应转换为 OpenAI chat.completions 响应
 * @param {Object} message Claude message 对象 (Vertex rawPredict 返回的 data)
 * @param {string} model 模型 ID
 */
function mapClaudeResponseToOpenAI(message, model) {
  const contentBlocks = Array.isArray(message.content)
    ? message.content
    : [];

  const textParts = [];
  const toolCalls = [];

  for (const block of contentBlocks) {
    if (!block || !block.type) continue;
    if (block.type === "text") {
      if (block.text) textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      });
    }
    // thinking / other block 类型这里直接忽略不往外透
  }

  const combinedText = textParts.join("");

  const assistantMessage = {
    role: "assistant",
    content: combinedText
  };
  if (toolCalls.length) {
    assistantMessage.tool_calls = toolCalls;
  }

  const now = Math.floor(Date.now() / 1000);

  const usage = message.usage || {};
  const promptTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const completionTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  const totalTokens =
    typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : null;

  return {
    id: message.id || `chatcmpl-${now}`,
    object: "chat.completion",
    created: now,
    model,
    choices: [
      {
        index: 0,
        message: assistantMessage,
        finish_reason: mapStopReason(message.stop_reason)
      }
    ],
    usage:
      promptTokens != null || completionTokens != null
        ? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens
          }
        : undefined
  };
}

function mapStopReason(stopReason) {
  if (!stopReason) return null;
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

module.exports = {
  mapOpenAIRequestToClaude,
  mapClaudeResponseToOpenAI
};
