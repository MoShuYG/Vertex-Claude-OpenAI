// src/server.js

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { config, assertConfig } = require("./config");
const { callClaudeMessages } = require("./vertexClient");
const {
  mapOpenAIRequestToClaude,
  mapClaudeResponseToOpenAI
} = require("./openaiAdapter");

assertConfig();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("tiny"));

// 可选：在 /v1 下面做一个简单的 API Key 保护
app.use("/v1", (req, res, next) => {
  if (!config.proxyApiKey) return next();
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!token || token !== config.proxyApiKey) {
    return res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "invalid_request_error"
      }
    });
  }
  next();
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    provider: "vertex-claude",
    openai_compatible: true
  });
});

// 简单模型列表：直接用配置里的 allowedModels，不从 GCP 动态读取
app.get("/v1/models", (_req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const data = config.allowedModels.map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "vertex-ai.anthropic"
  }));
  res.json({
    object: "list",
    data
  });
});

// 核心：Chat Completions
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body || {};
    const stream = !!body.stream;
    const model = body.model || config.defaultModel;

    if (!config.allowedModels.includes(model)) {
      return res.status(400).json({
        error: {
          message: `Model ${model} is not in allowed list`,
          type: "invalid_request_error"
        }
      });
    }

    const claudeReq = mapOpenAIRequestToClaude(body);

    if (stream) {
      // 当前实现：只对纯文本对话做流式（无 tools 时）
      const hasTools = Array.isArray(claudeReq.tools) && claudeReq.tools.length;
      if (hasTools) {
        // 带 tools 的场景建议先用非流式，避免多一层复杂度
        // 你以后如果想要完全还原工具流式，也可以在这里扩展
        res.setHeader("Content-Type", "application/json");
        return res.status(400).json({
          error: {
            message:
              "Streaming with tools is not supported yet in this gateway. Please call without stream or without tools.",
            type: "invalid_request_error"
          }
        });
      }
      return streamChatCompletion(model, claudeReq, res);
    }

    // 非流式
    const vertexResp = await callClaudeMessages({
      ...claudeReq,
      model,
      stream: false
    });

    const oaiResp = mapClaudeResponseToOpenAI(vertexResp, model);
    res.json(oaiResp);
  } catch (err) {
    console.error("[/v1/chat/completions] error:", err);
    const status = err.status || 500;
    res.status(status).json({
      error: {
        message: err.message || "Internal Server Error",
        type: "internal_error"
      }
    });
  }
});

/**
 * 将 Claude 的 SSE 流转换为 OpenAI chat.completion.chunk 流
 * 只处理 text_delta，忽略 thinking / 工具调用的增量事件
 */
async function streamChatCompletion(model, claudeReq, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // 部分 Node 环境有 flushHeaders
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const id = `chatcmpl-${Date.now()}`;
  let firstChunk = true;
  let closed = false;

  try {
    const upstreamRes = await callClaudeMessages({
      ...claudeReq,
      model,
      stream: true
    });

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of upstreamRes.body) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;

      // SSE 事件以 \n\n 分隔 :contentReference[oaicite:10]{index=10}
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = rawEvent
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        if (!lines.length) continue;

        // Anthropic SSE 一般有 event: xxx + data: {...}，我们只看 data 行 :contentReference[oaicite:11]{index=11}
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice("data:".length).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        // 只处理文本增量
        if (
          event.type === "content_block_delta" &&
          event.delta &&
          event.delta.type === "text_delta"
        ) {
          const deltaText = event.delta.text || "";
          if (!deltaText) continue;

          const chunkPayload = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  ...(firstChunk ? { role: "assistant" } : {}),
                  content: deltaText
                },
                finish_reason: null
              }
            ]
          };
          firstChunk = false;
          res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
        } else if (event.type === "message_stop") {
          // Claude 流结束标志，我们转成一次 stop chunk + [DONE]
          const stopChunk = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop"
              }
            ]
          };
          res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          closed = true;
          res.end();
        }
      }
    }
  } catch (err) {
    console.error("[streamChatCompletion] error:", err);
    if (!closed) {
      const errorChunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "error"
          }
        ]
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    return;
  }

  if (!closed) {
    // 防止上游没有 message_stop 的极端情况 :contentReference[oaicite:12]{index=12}
    const stopChunk = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    };
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

app.listen(config.port, () => {
  console.log(
    `[server] Vertex Claude OpenAI gateway listening on port ${config.port}, default model = ${config.defaultModel}`
  );
});
