// src/config.js

const DEFAULT_MODEL_LIST = [
  // 这里用的是官方 Claude on Vertex AI 文档里的模型 ID，可按自己区域可用情况调整 :contentReference[oaicite:4]{index=4}
  "claude-opus-4-6",
  "claude-opus-4-5@20251101",
  "claude-opus-4@20250514",
  "claude-sonnet-4-5@20250929",
  "claude-sonnet-4@20250514",
  "claude-3-7-sonnet@20250219",
  "claude-haiku-4-5@20251001",
  "claude-3-5-haiku@20241022",
  "claude-3-haiku@20240307"
];

function parseList(envValue, fallbackList) {
  if (!envValue) return fallbackList;
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowedModels = parseList(
  process.env.VERTEX_ALLOWED_MODELS,
  DEFAULT_MODEL_LIST
);

const config = {
  projectId: process.env.VERTEX_PROJECT_ID,
  location: process.env.VERTEX_LOCATION || "global", // 推荐 global 端点 :contentReference[oaicite:5]{index=5}
  clientEmail: process.env.VERTEX_CLIENT_EMAIL,
  privateKey: process.env.VERTEX_PRIVATE_KEY
    ? process.env.VERTEX_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  anthropicVersion:
    process.env.VERTEX_ANTHROPIC_VERSION || "vertex-2023-10-16", // 官方要求这个值 :contentReference[oaicite:6]{index=6}
  defaultModel:
    process.env.VERTEX_DEFAULT_MODEL || allowedModels[0] || null,
  allowedModels,
  port: process.env.PORT || 3000,
  debug:
    process.env.DEBUG === "1" ||
    process.env.DEBUG === "true" ||
    process.env.NODE_ENV === "development",
  // 可选：如果你想给网关加一层 API Key 保护
  proxyApiKey: process.env.PROXY_API_KEY || null
};

function assertConfig() {
  const missing = [];
  if (!config.projectId) missing.push("VERTEX_PROJECT_ID");
  if (!config.location) missing.push("VERTEX_LOCATION");
  if (!config.clientEmail) missing.push("VERTEX_CLIENT_EMAIL");
  if (!config.privateKey) missing.push("VERTEX_PRIVATE_KEY");
  if (!config.defaultModel) missing.push("VERTEX_DEFAULT_MODEL 或 VERTEX_ALLOWED_MODELS 列表");

  if (missing.length) {
    // 这里直接抛错，让 Zeabur 日志里能看到具体缺啥
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

module.exports = {
  config,
  assertConfig
};
