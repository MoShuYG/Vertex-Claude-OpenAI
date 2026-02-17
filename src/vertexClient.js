// src/vertexClient.js

const { GoogleAuth } = require("google-auth-library");
const { config } = require("./config");

const auth = new GoogleAuth({
  credentials: {
    client_email: config.clientEmail,
    private_key: config.privateKey
  },
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});

// 简单 token 缓存（避免每次都重新获取）
let cachedToken = null;
let cachedTokenExpire = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpire - 60_000) {
    return cachedToken;
  }
  const client = await auth.getClient();
  const { token, res } = await client.getAccessToken();
  if (!token) {
    throw new Error("Failed to obtain access token from GoogleAuth");
  }
  cachedToken = token;
  // 这里就粗略缓存 30 分钟
  cachedTokenExpire = now + 30 * 60_000;
  return token;
}

/**
 * 调用 Claude on Vertex 的 Messages API (rawPredict)
 * @param {Object} options
 * @param {string} options.model - Vertex 模型 ID
 * @param {Array} options.messages - Claude Messages 格式的 messages
 * @param {string} [options.system] - system prompt
 * @param {Array} [options.tools] - Claude tools 声明
 * @param {Object} [options.tool_choice] - Claude tool_choice
 * @param {number} [options.max_tokens]
 * @param {number} [options.temperature]
 * @param {number} [options.top_p]
 * @param {number} [options.top_k]
 * @param {Array<string>} [options.stop_sequences]
 * @param {Object} [options.metadata]
 * @param {Object} [options.thinking] - extended thinking 配置
 * @param {boolean} [options.stream] - 是否流式
 * @returns {Promise<Object|Response>} 非流式返回 JSON 对象；流式直接返回 fetch Response
 */
async function callClaudeMessages(options) {
  const {
    model,
    messages,
    system,
    tools,
    tool_choice,
    max_tokens,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    metadata,
    thinking,
    stream = false
  } = options;

  const token = await getAccessToken();

  const url = `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.location}/publishers/anthropic/models/${model}:rawPredict`;

  const body = {
    anthropic_version: config.anthropicVersion,
    messages,
    stream,
    // Claude Messages API 通用字段 :contentReference[oaicite:9]{index=9}
    ...(system ? { system } : {}),
    ...(typeof max_tokens === "number" ? { max_tokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof top_p === "number" ? { top_p } : {}),
    ...(typeof top_k === "number" ? { top_k } : {}),
    ...(Array.isArray(stop_sequences) && stop_sequences.length
      ? { stop_sequences }
      : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(metadata ? { metadata } : {}),
    ...(thinking ? { thinking } : {})
  };

  if (config.debug) {
    console.log("[vertexClient] Request body (trimmed):", {
      ...body,
      messages: `len=${body.messages?.length ?? 0}`,
      tools: body.tools ? `len=${body.tools.length}` : undefined
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `Vertex API error: ${res.status} ${res.statusText} - ${text}`
    );
    err.status = res.status;
    err.body = text;
    throw err;
  }

  if (stream) {
    // 返回 fetch Response，由上层自己解析 SSE
    return res;
  }

  const json = await res.json();
  if (config.debug) {
    console.log("[vertexClient] Response (trimmed keys):", Object.keys(json));
  }
  return json;
}

module.exports = {
  callClaudeMessages
};
