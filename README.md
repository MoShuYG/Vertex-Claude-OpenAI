Vertex Claude OpenAI 网关

这是一个将 Claude on Vertex AI 转为 OpenAI Chat Completions 兼容接口 的小网关，方便在 Cherry、OpenRouter 之类只支持 OpenAI 格式的客户端里直接调用 Claude 模型。


功能
POST /v1/chat/completions

支持 system / user / assistant 消息

支持工具 / function calling（非流式）

支持 claude_thinking 直通 Claude Extended Thinking

支持 stream: true 文本流式输出

GET /v1/models 返回允许使用的 Claude 模型列表


环境变量

必需：

VERTEX_PROJECT_ID：GCP 项目 ID

VERTEX_LOCATION：Vertex 区域（推荐 global）

VERTEX_CLIENT_EMAIL：Service Account 的 client_email

VERTEX_PRIVATE_KEY：Service Account 的 private_key（注意换行用 \n 转义）

VERTEX_ALLOWED_MODELS：允许使用的 Claude 模型列表，逗号分隔

例如：

VERTEX_ALLOWED_MODELS=claude-opus-4-6,claude-sonnet-4-5@20250929

本代码纯由AI撰写。
