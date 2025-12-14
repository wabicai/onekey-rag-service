# OneKey 文档 AI 对话（前端）——需求与开发规格（对标 Inkeep）

> 版本：v0.1（前端 MVP 规格）  
> 目标站点：`https://developer.onekey.so/`（静态站点，GitHub Pages 托管）  
> 后端服务：OneKey RAG Service（OpenAI 兼容接口）  
> 主要接口：`POST /v1/chat/completions`、`POST /v1/feedback`  

---

## 0. 概述

### 0.1 背景
OneKey 开发者文档覆盖 SDK/API/集成指南/故障排查等内容。为降低开发者检索与学习成本，需要在文档站内提供一个“AI 对话 + 可追溯引用”的体验，对标 Inkeep：能在回答中标注引用编号，并提供可点击的来源链接与片段预览。

### 0.2 目标与边界
**目标（MVP 必达）**
1. 在 `developer.onekey.so` 全站提供统一 AI 对话入口（浮层/弹窗）。
2. 支持多轮对话（把历史 `messages` 传给后端）。
3. 支持流式输出（POST SSE），并在结束前接收 `sources` 事件。
4. 支持 inline citation（如 `[1] [2]`）与 sources 面板联动展示。
5. 支持对单次回答反馈（有帮助/没帮助 + 原因 + 备注）。

**不做（MVP 暂不覆盖）**
- 账号登录、权限控制、团队工作区等（站点公开）
- 多版本文档切换（当前只有一个版本）
- 后台运营管理 UI（数据先上报即可）

### 0.3 关键假设/约束（已确定）
1. **集成方式**：采用“一行 script 注入”对标 Inkeep：文档站仅引入 `widget.js`，由 loader 自动注入右下角按钮 + 居中弹窗（Modal），弹窗内加载 iframe（iframe 承载完整 UI）。
2. **同域策略**：Widget iframe 与 RAG API 同域部署，iframe 内以相对路径调用 `/v1/chat/completions`，避免 CORS 复杂度；文档站只负责加载 `widget.js`。
3. **嵌入安全**：后端通过 CSP `frame-ancestors` 控制允许嵌入的父页面来源（建议仅允许 `https://developer.onekey.so`）。

---

## 1. 体验目标（对标 Inkeep）

### 1.1 必达体验
- **随处可用**：任意页面都能打开对话（无需跳转）。
- **流式响应**：收到首个 token 后立即渲染，减少“等待感”。
- **可追溯引用**：
  - 正文出现 `[n]` 引用编号
  - sources 面板可点击跳转到文档 URL，并显示 snippet
- **多轮可靠**：追问时仍能保持话题与引用的相关性。
- **低打扰**：默认不遮挡阅读；支持 ESC 关闭；移动端可用。

### 1.2 建议指标（便于运营）
- `first_token_latency_ms`：首 token 延迟（流式）
- `answer_latency_ms`：完成延迟（到 `[DONE]`）
- `sources_count`：每次回答 sources 数量
- `feedback_rate`/`thumbs_up_ratio`

---

## 2. 产品功能需求

### 2.1 入口与布局（推荐：右下角按钮 + 居中弹窗）
**入口**
- 右下角悬浮按钮（“Ask AI”/“文档助手”）
- 可配置：是否在移动端展示、最小化样式、悬浮层级（z-index）

**弹窗（Modal）**
- 桌面：居中弹窗，推荐宽 760–920px，高 60–75vh（可配置）
- 移动端：近似全屏（保留少量边距或全屏覆盖）
- 有遮罩（overlay），点击遮罩或按 ESC 可关闭

**会话保留**
- 关闭弹窗不清空会话；提供“一键清空”
- localStorage 持久化（可配置关闭）

### 2.2 对话（Chat Thread）
**消息类型**
- `user`：用户输入
- `assistant`：模型输出（Markdown 渲染）

**输入框（Composer）**
- Enter 发送；Shift+Enter 换行
- 流式生成中：发送按钮置灰（MVP 不提供“停止生成”按钮）
- “重新生成”按钮（对最后一个 user 消息重试，后续可做）

**消息操作**
- 复制回答（可选：含/不含引用）
- 复制代码块（每个 code block 右上角按钮）
- 反馈入口（有帮助/没帮助）

### 2.3 引用与来源（对标 Inkeep 的关键）
前端需要同时支持：
1. **Inline citation**：正文中出现 `[1] [2]`（后端生成）
2. **Sources 面板**：结构化展示 `ref/title/section_path/snippet/url`

交互建议：
- 点击正文中的 `[n]`：
  - 打开 sources 面板（或聚焦到 sources 区）
  - 高亮第 n 条 source
- Hover `[n]`：显示 snippet 预览（tooltip/popover）
- sources 条目点击：在新标签页打开 `url`

注意：
- 当前后端 sources 只保证 URL 与 snippet，不保证段落级 anchor；“段落高亮/定位”属于后续增强（见 TODO）。

### 2.5 反馈闭环（MVP 必做）
对每条 assistant 回复提供：
- 有帮助 / 没帮助
- 负反馈原因（建议枚举）：
  - `sources_irrelevant` 引用不相关
  - `answer_incorrect` 回答不正确
  - `answer_incomplete` 不完整
  - `cant_find` 没找到
  - `format_bad` 表达不清晰
- 可选备注 comment
- 上报 `sources`（url 列表，便于定位问题文档）

### 2.6 页面上下文增强（可选，后续）
- 前端可把当前页面 URL 写入 `metadata`（如 `{page_url: location.href}`）
- 后端未来可基于 URL 做过滤/加权/召回增强；前端先预留字段

---

## 3. 交互与状态机

### 3.1 核心状态
- `idle`：无请求
- `streaming`：流式接收中
- `done`：完成
- `error`：失败（可重试）
- `aborted`：用户中断（如 clear/关闭弹窗导致的 Abort）

### 3.2 并发策略
- 同一会话同一时间只允许一个进行中的请求
- 用户再次发送时：
  - 方案 A（推荐）：自动 Abort 上一个，再发送新的
  - 方案 B：提示“正在生成，是否停止并发送新问题？”

### 3.3 中断（Stop generating）
（MVP）不提供显式“停止生成”按钮；通过以下方式中断：
- `Clear` 清空会话（内部使用 `AbortController.abort()`）
- 关闭弹窗（内部使用 `AbortController.abort()`）

---

## 4. 接口对接（OpenAI 兼容 + 扩展字段）

### 4.1 基础配置
- `RAG_SERVICE_BASE_URL`：例如 `https://rag-api.onekey.so` 或本地 `http://localhost:8000`

后端配合：
- CORS 允许 `https://developer.onekey.so`（及预发布域名）
- 建议在网关侧增加限流（避免公开站点被刷）

### 4.2 `POST /v1/chat/completions`（非流式）
请求体（最小示例）：
```json
{
  "model": "onekey-docs",
  "messages": [
    { "role": "user", "content": "如何在 React 里集成 OneKey Connect？" }
  ],
  "stream": false
}
```

响应体（关键字段）：
```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1734150000,
  "model": "onekey-docs",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "……[1][2]" }, "finish_reason": "stop" }
  ],
  "sources": [
    { "ref": 1, "url": "https://developer.onekey.so/...", "title": "...", "section_path": "...", "snippet": "..." }
  ]
}
```

前端处理要点：
- 使用 Markdown 渲染 `content`（代码块需提供复制按钮）
- 解析 `content` 中的 `[n]`，与 `sources[].ref` 对齐

### 4.3 `POST /v1/chat/completions`（流式 SSE，POST）
注意：这是 **POST SSE**（不是 EventSource 的 GET SSE）。推荐使用 `@microsoft/fetch-event-source` 或自行解析 `ReadableStream`。

请求体：
```json
{
  "model": "onekey-docs",
  "messages": [
    { "role": "user", "content": "WebUSB 权限需要注意什么？" }
  ],
  "stream": true
}
```

响应：`text/event-stream`，主要包含三类事件：
```text
data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"..."} }]}

data: {"object":"chat.completion.sources","sources":[{"ref":1,"url":"...","snippet":"..."}]}

data: [DONE]
```

前端处理要点：
- 遇到 `chat.completion.chunk`：取 `delta.content` 追加到当前 assistant 消息
- 遇到 `chat.completion.sources`：更新 sources 面板
- 遇到 `[DONE]`：结束 streaming，记录 `message_id`（即响应中的 `id`）

### 4.4 `POST /v1/feedback`
用途：对单条 assistant 回复反馈

建议前端生成：
- `conversation_id`：每个会话一个 UUID（localStorage 持久化）
- `message_id`：使用后端 `chatcmpl_xxx`（非流式/流式都能拿到）

请求体示例：
```json
{
  "conversation_id": "conv_xxx",
  "message_id": "chatcmpl_xxx",
  "rating": "down",
  "reason": "sources_irrelevant",
  "comment": "引用的页面不是我想要的那篇。",
  "sources": ["https://developer.onekey.so/..."]
}
```

---

## 5. 前端技术实现建议

### 5.1 集成方式（确定：一行 script + iframe）

后端同域提供：
- Loader：`GET /widget/widget.js`
- iframe：`GET /widget/`

文档站只需引入一行（示例）：
```html
<script
  src="https://你的-rag-域名/widget/widget.js"
  data-model="onekey-docs"
  data-title="OneKey 文档助手"
></script>
```

可选配置（两种方式二选一）：
1) `data-*` 属性（推荐，简单直观）：
- `data-model`：默认模型 id（用于请求体 `model` 字段；当前 Widget 不提供下拉选择）
- `data-title`：iframe 标题/头部标题
- `data-button-label`：右下角按钮文案（默认 `Ask AI`）
- `data-width`：弹窗宽度（历史兼容字段，默认 `860px`）
- `data-modal-width`：弹窗宽度（推荐）
- `data-modal-height`：弹窗高度（默认 `72vh`）
- `data-modal-max-height`：弹窗最大高度（默认 `820px`）
- `data-z-index`：层级（默认 `2147483647`）
- `data-api-base`：API Base（可选；为空表示 iframe 内使用同域相对路径）
- `data-widget-base-url`：iframe URL（可选；默认从 `widget.js` 的目录推导）

2) 全局变量（适合集中管理）：
```js
window.OneKeyRAGWidgetConfig = {
  model: "onekey-docs",
  title: "OneKey 文档助手"
}
```

### 5.2 模块划分（建议）
- `api/`：models、chat、feedback
- `streaming/`：SSE over POST（含 abort、重试、解析）
- `store/`：会话状态（messages、sources、selectedModel、streaming 状态）
- `components/`：
  - `ChatLauncher`、`ChatModal`
  - `MessageList`、`MessageItem`
  - `Composer`
  - `SourcesPanel`、`CitationPill`
  - `Feedback`
- `utils/`：UUID、引用解析、Markdown 渲染辅助

### 5.3 Markdown 渲染规范
- 支持：标题、列表、链接、代码块、表格
- 代码块：显示语言、支持一键复制
- 链接：默认新窗口打开，并加 `rel="noopener noreferrer"`

### 5.4 引用解析
从 assistant `content` 中识别 `[n]`：
- 将 `[n]` 渲染为可交互组件（hover 预览 / click 聚焦 sources）
- 若正文没有 `[n]`，仍展示 sources 面板（保证可追溯）

---

## 6. 安全与稳定性

### 6.1 安全注意事项
- 前端不得携带任何上游模型密钥（key 只存在后端）
- 对外公开站建议在网关侧做：
  - 基于 origin 的请求限制
  - rate limit
  - 失败降级（展示“稍后重试/查看文档链接”）

### 6.2 错误处理（前端）
- 网络错误：提示“网络异常/服务不可用”，提供重试
- 429：提示“请求过于频繁”，提示稍后重试
- 5xx：提示“服务繁忙”，提示重试
- streaming 中断：将当前消息标记为 `error/aborted`，允许重试

---

## 7. 测试与验收

### 7.1 MVP 自测清单
- 弹窗打开/关闭、移动端适配、ESC 关闭
- 非流式：能显示答案、能显示 sources
- 流式：逐字显示；收到 sources 事件；最后 `[DONE]`
- inline citation：点击 `[n]` 可定位到 sources
- abort：clear/关闭后不再追加 token
- 反馈：能提交 `/v1/feedback`

### 7.2 性能建议
- widget 异步加载（避免拖慢文档首屏）
- streaming 追加内容时做节流（避免每 token 全量重渲染）

---

## 8. TODO（前端侧对标 Inkeep 的增强）

1. 搜索 + AI 融合：将站内搜索结果与对话融合展示（Inkeep 常见交互）。
2. 引用段落级定位与高亮：需要后端提供 anchor/段落 id；前端支持点击引用定位并高亮。
3. 相关追问推荐（follow-ups）：对话结束后推荐 3–5 个可继续追问的问题。
4. 分享与可复现：生成可分享对话链接（需要后端持久化会话或前端编码到 URL）。
5. 更完善的埋点：打开率、提问转化、无命中率、负反馈聚合、Top queries。
