# Project Hana 架构文档

> Hanako — a personal AI agent with memory and soul
>
> 版本 v0.66.1，最后更新 2026-03-24

## 总览

Hana 是一个多平台个人 AI Agent，基于 PI SDK（`@mariozechner/pi-coding-agent`）构建，通过 OpenAI 兼容协议接入任意模型 provider。核心能力：多轮对话、长期记忆、工具调用、多 agent 管理、多平台桥接（Telegram / 飞书 / 微信 / QQ）。

### 运行模式

| 模式 | 启动命令 | 说明 |
|------|---------|------|
| **Electron 桌面** | `npm start` | spawn 独立 Node 进程跑 Server，主进程跑 Electron UI |
| **Vite HMR 开发** | `npm run start:vite` | 需先 `npm run dev:renderer`，前端走 Vite dev server |
| **CLI** | `npm run cli` | 纯终端交互，无 GUI |
| **Server** | `npm run server` | 纯 HTTP + WebSocket API，无 UI |

所有模式都经过 `scripts/launch.js`，它设置 `HANA_HOME=~/.hanako-dev`（开发环境）并启动对应进程。

### 数据目录

- `~/.hanako/` — 生产环境用户数据
- `~/.hanako-dev/` — 开发环境用户数据
- 结构：`agents/`、`user/`、`channels/`、`sessions/`、`memory/` 等

---

## 分层架构

```
┌─────────────────────────────────────────────────┐
│              Frontend (desktop/src/)             │
│   React 19 + Zustand 5 + TypeScript + CSS Modules│
├─────────────────────────────────────────────────┤
│              Server (server/)                    │
│         Fastify HTTP + WebSocket API             │
├─────────────────────────────────────────────────┤
│              Hub (hub/)                          │
│     消息调度中枢 + EventBus + DM Router           │
├─────────────────────────────────────────────────┤
│              Engine (core/)                      │
│  核心引擎 + Managers + Provider/Model 抽象层       │
├─────────────────────────────────────────────────┤
│              Lib (lib/)                          │
│     功能模块：记忆、工具、桥接、沙盒、Providers 等   │
├─────────────────────────────────────────────────┤
│              Shared (shared/)                    │
│  跨层共享：错误体系、安全 IO、配置 Schema、重试      │
└─────────────────────────────────────────────────┘
```

---

## core/ — 核心引擎

`HanaEngine` 是系统的中央 Facade，持有所有 Manager，对外暴露统一 API。

| 文件 | 职责 |
|------|------|
| `engine.js` | **HanaEngine** 类，thin facade，委托各 Manager 工作 |
| `agent-manager.js` | Agent CRUD、初始化、切换焦点 agent |
| `agent.js` | Agent 实例，封装单个 agent 的配置、身份、系统提示词 |
| `session-coordinator.js` | Session 生命周期管理：创建、切换、列表、持久化、`steer`（插话）、`executeIsolated`（隔离执行，支持 builtin/custom 工具白名单、AbortSignal 传播） |
| `config-coordinator.js` | 配置读写（通过 `shared/config-scope.js` 按 scope 分流 global/agent）、模型设置、搜索、utility 聚合 |
| `channel-manager.js` | 频道 CRUD、成员管理 |
| `bridge-session-manager.js` | 外部平台 bridge session 管理 + 启动孤儿清理（reconcile） |
| `model-manager.js` | 模型注册/发现，读 `models.json` |
| `preferences-manager.js` | 全局偏好持久化（沙盒、语言、时区、更新通道等） |
| `skill-manager.js` | 技能注册/同步，管理 `skills2set/` 中的技能包 |
| `llm-client.js` | 直接 HTTP POST LLM 客户端（非流式），AbortSignal 统一超时链，供 utility 调用使用 |
| `llm-utils.js` | 轻量 LLM 调用纯函数（标题摘要、技能翻译、活动总结等），底层走 `llm-client.js` |
| `events.js` | 事件类型定义 + `MoodParser`（解析 MOOD 区块的流式解析器） |
| `first-run.js` | 首次运行播种：从 `lib/` 复制默认 agent、身份模板等 |
| `sync-favorites.js` | 收藏同步 |

### Provider/Model 抽象层

| 文件 | 职责 |
|------|------|
| `provider-registry.js` | Provider 声明式注册表，合并插件声明与 `providers.yaml` 用户配置，生成 `ProviderEntry` |
| `auth-store.js` | 统一凭证存储，索引 `providerId`，从 `providers.yaml` / `auth.json` / per-agent `config.yaml` 按优先级加载 |
| `execution-router.js` | Per-agent 角色路由，按 role（chat/utility/embed）解析完整执行参数（modelId、providerId、API 细节） |

三层职责分离：ProviderRegistry（声明）→ AuthStore（凭证）→ ExecutionRouter（路由）。

v0.61.0 重构后，`ModelManager._availableModels` 成为模型的唯一数据源（single source of truth），旧的 `ModelCatalog` 已移除。所有模型查询、切换、UI 展示都从 `_availableModels` 取数据。

### Manager 设计原则

- Manager 不持有 engine 引用，通过构造器注入依赖
- Route 文件零 `engine._` 穿透（通过 engine 公开 API 访问）

---

## hub/ — 消息调度中枢

Hub 和 Engine 跑在同一个 Node 进程，`hub.send()` 内部直接调 engine 方法。

| 文件 | 职责 |
|------|------|
| `index.js` | **Hub** 类，组装 EventBus + ChannelRouter + GuestHandler + Scheduler + AgentMessenger + DmRouter |
| `event-bus.js` | **EventBus**，统一事件总线，`subscribe(callback, filter?)` + `emit(event, sessionPath)` |
| `channel-router.js` | 频道 triage + 消息路由调度 |
| `guest-handler.js` | Guest 留言机（未认证用户的消息处理） |
| `scheduler.js` | Heartbeat + Cron 定时任务调度 |
| `agent-executor.js` | Agent 任务执行器 |
| `agent-messenger.js` | Agent 间消息传递 |
| `dm-router.js` | Agent 间异步私信路由（v0.50+） |

### EventBus 注入链

Engine 通过 `engine.setEventBus(bus)` 接收 Hub 注入的 EventBus，内部用 `_emitEvent(event, sessionPath)` 广播。

---

## server/ — HTTP + WebSocket API

基于 Fastify，可独立运行或由 Electron spawn 启动。写入 `~/.hanako-dev/server-info.json` 通知端口号，Electron 通过轮询该文件检测 server 就绪。Browser control 走 WebSocket `/internal/browser` 端点。

| 文件 | 职责 |
|------|------|
| `index.js` | 服务入口，初始化 Engine + Hub + Fastify，注册所有 route |
| `cli.js` | CLI 模式入口（WebSocket 客户端） |
| `i18n.js` | 国际化加载 |
| `ws-protocol.js` | WebSocket 协议处理 |
| `session-stream-store.js` | Session 流式传输状态存储 |

### Routes（`server/routes/`）

| Route 文件 | API 功能 |
|-----------|---------|
| `chat.js` | 聊天核心：发消息、流式响应（WebSocket） |
| `sessions.js` | Session CRUD、列表、切换 |
| `agents.js` | Agent 管理 |
| `models.js` | 模型列表、切换 |
| `providers.js` | Provider 管理 |
| `config.js` | 全局配置读写（含 `update_channel` 偏好） |
| `preferences.js` | 偏好设置 |
| `skills.js` | 技能管理 |
| `channels.js` | 频道管理 |
| `bridge.js` | Bridge 平台管理（Telegram/飞书/微信/QQ） |
| `desk.js` | 书桌文件管理 |
| `diary.js` | 日记功能 |
| `upload.js` | 文件上传 |
| `fs.js` | 文件系统操作 |
| `avatar.js` | 头像管理 |
| `auth.js` | 认证 |
| `dm.js` | Agent 间私信（v0.50+） |
| `confirm.js` | 确认流（v0.50+） |

### Middleware（`server/middleware/`，v0.64+）

| 文件 | 职责 |
|------|------|
| `error-handler.js` | Fastify 全局错误处理中间件，捕获未处理异常，包装为 AppError，上报 ErrorBus，返回结构化 JSON 响应 |

---

## lib/ — 功能模块库

### lib/providers/ — Provider 插件（30 个）

声明式 provider 插件，每个文件导出一个 provider 定义（能力、协议、认证方式、默认模型列表），由 `core/provider-registry.js` 统一加载。

| 分类 | Provider |
|------|---------|
| **国际** | `openai.js`、`anthropic.js`、`gemini.js`、`mistral.js`、`xai.js`、`perplexity.js`、`groq.js`、`fireworks.js`、`together.js`、`openrouter.js` |
| **国内** | `deepseek.js`、`dashscope.js`、`zhipu.js`、`moonshot.js`、`baichuan.js`、`minimax.js`、`minimax-oauth.js`、`stepfun.js`、`siliconflow.js`、`hunyuan.js`、`infini.js`、`volcengine.js`、`mimo.js` |
| **Coding Plan** | `dashscope-coding.js`、`kimi-coding.js`、`volcengine-coding.js`、`openai-codex-oauth.js` |
| **云平台** | `baidu-cloud.js`、`modelscope.js` |
| **本地** | `ollama.js` |

### lib/llm/ — LLM 客户端

| 文件 | 职责 |
|------|------|
| `provider-client.js` | 统一 provider 客户端抽象：base URL 正规化、本地端点检测、跨协议消息结构翻译 |

v0.60.0 消灭了 `callProviderText`，所有 LLM 调用统一走 Pi SDK 流式 API（聊天）或 `core/llm-client.js` 直接 HTTP POST（utility 场景如标题摘要、记忆编译等）。

### lib/memory/ — 记忆系统

Hana 的核心差异化能力。多层记忆架构。

| 文件 | 职责 |
|------|------|
| `memory-ticker.js` | 记忆定时器，驱动日常记忆编译流程 |
| `compile.js` | 记忆编译：日 → 周 → 长期，`_doDaily()` 5 步断点续跑 |
| `deep-memory.js` | 深层记忆处理 |
| `session-summary.js` | Session 摘要生成 |
| `memory-search.js` | 记忆检索 |
| `fact-store.js` | 事实存储（结构化记忆，SQLite） |
| `config-loader.js` | 记忆配置加载 |

### lib/bridge/ — 多平台桥接

通过 adapter 注册表模式接入外部平台。

| 文件 | 职责 |
|------|------|
| `bridge-manager.js` | Bridge 管理器，`ADAPTER_REGISTRY` 注册表 |
| `telegram-adapter.js` | Telegram Bot 适配器 |
| `feishu-adapter.js` | 飞书适配器 |
| `wechat-adapter.js` | 微信适配器 |
| `wechat-login.js` | 微信登录流程 |
| `qq-adapter.js` | QQ 适配器 |
| `media-utils.js` | 媒体文件处理（下载、base64 编码、MIME 检测） |
| `session-key.js` | Session key 工具 |

REST 层用 `SESSION_PREFIX_MAP` + `KNOWN_PLATFORMS` 数据驱动，新增平台不需要改 route。

### lib/tools/ — Agent 工具集（17 个）

Agent 可调用的工具，注册到 PI SDK。

| 文件 | 职责 |
|------|------|
| `web-search.js` | 网络搜索（DuckDuckGo） |
| `web-fetch.js` | 网页抓取 |
| `browser-tool.js` | 浏览器操作（Playwright） |
| `artifact-tool.js` | Artifact 创建/编辑 |
| `channel-tool.js` | 频道操作 |
| `cron-tool.js` | 定时任务 |
| `message-agent-tool.js` | Agent 间消息 |
| `notify-tool.js` | 通知推送 |
| `delegate-tool.js` | Sub-agent 委派（隔离子任务，只返回结论，不占主上下文） |
| `output-file-tool.js` | 文件输出 |
| `pinned-memory.js` | 固定记忆 |
| `todo.js` | 待办事项 |
| `experience.js` | 经验记录 |
| `install-skill.js` | 技能安装 |
| `update-settings-tool.js` | 设置修改（两阶段：search 查找 → apply 修改）（v0.48+） |
| `ask-agent-tool.js` | 跨 agent 同步查询（借用目标 agent 人格，无记忆/工具，单轮）（v0.50+） |
| `dm-tool.js` | Agent 间异步私信（存 `dm/` 目录，支持聊天历史）（v0.50+） |

### lib/sandbox/ — 沙盒 / 权限管理

双层隔离架构，参考 Claude Code 的沙盒方案。

| 文件 | 职责 |
|------|------|
| `index.js` | 沙盒入口，`createSandboxedTools()` |
| `path-guard.js` | PathGuard，4 级访问控制 |
| `tool-wrapper.js` | Tool Wrapper，路径校验 + bash preflight |
| `seatbelt.js` | macOS Seatbelt（sandbox-exec） |
| `bwrap.js` | Linux Bubblewrap |
| `platform.js` | 平台检测 |
| `policy.js` | 安全策略定义 |
| `exec-helper.js` | 执行辅助 |
| `script.js` | 脚本执行 |

两种模式：`standard`（双层隔离）/ `full-access`（不包装）。

### lib/desk/ — 书桌面板

| 文件 | 职责 |
|------|------|
| `desk-manager.js` | 书桌管理器，文件/文件夹操作 |
| `activity-store.js` | 活动记录存储 |
| `cron-store.js` | Cron 任务持久化 |
| `cron-scheduler.js` | Cron 定时调度 |
| `heartbeat.js` | 心跳检测 |
| `permissions.js` | 书桌权限 |

### lib/diary/ — 日记

| 文件 | 职责 |
|------|------|
| `diary-writer.js` | 日记撰写器 |

### lib/channels/ — 频道

| 文件 | 职责 |
|------|------|
| `channel-store.js` | 频道数据存储 |
| `channel-ticker.js` | 频道定时器 |

### lib/browser/ — 浏览器

| 文件 | 职责 |
|------|------|
| `browser-manager.js` | Playwright 浏览器实例管理 |

### lib/yuan/ — Agent 身份模板

预置 Agent 人格/身份定义（Markdown 格式）。

| 文件 | 身份 |
|------|------|
| `hanako.md` | Hanako（主角，默认 agent） |
| `butter.md` | Butter |
| `kong.md` | Kong |
| `ming.md` | Ming |
| `en/` | 英文版身份模板 |

### lib/identity-templates/ & lib/ishiki-templates/

- `identity-templates/` — 身份模板（首次运行播种用）
- `ishiki-templates/` — 意识模板（agent 内部系统提示词模板）
- `public-ishiki-templates/` — 公开意识模板

### lib/oauth/

| 文件 | 职责 |
|------|------|
| `minimax-portal.js` | MiniMax OAuth 门户 |

### lib/compat/ — 兼容性

| 文件 | 职责 |
|------|------|
| `index.js` | 兼容性检查入口，插件式架构 |
| `checks/` | 各项兼容性检测（目录结构、config.yaml、facts.db schema 迁移） |

### lib/ 根目录独立模块

| 文件 | 职责 |
|------|------|
| `debug-log.js` | 持久化调试日志（`~/.hanako/logs/`，7 天自动清理） |
| `pii-guard.js` | PII 检测与脱敏（API key、密码、身份证号等，写入 FactStore 前调用） |
| `experience-extractor.js` | 从 session 摘要中提取操作经验，写入 `experience/` |
| `time-utils.js` | 统一逻辑日边界（凌晨 4 点切日），所有子系统共用 |
| `known-models.json` | 模型元数据注册表（context window、max output），支持前缀匹配 |

---

## shared/ — 跨层共享模块

v0.63+ 新增的共享层，被 core/、server/、desktop/ 三层共同引用。

### 错误处理体系（四层防御架构，v0.64+）

| 文件 | 职责 |
|------|------|
| `errors.js` | `AppError` 类 + `ERROR_DEFS` 错误码注册表（severity / category / retryable / i18nKey） |
| `error-bus.js` | `ErrorBus` 事件总线，breadcrumb 追踪（最近 50 条）、指纹去重（5s 窗口）、severity 路由（toast / statusbar / boundary / silent） |
| `safe-fs.js` | 安全文件操作：`safeReadFile`、`safeReadJSON`、`safeReadYAML`、`safeCopyDir`（原子复制 + 回滚） |
| `safe-parse.js` | 安全解析：`safeParseJSON`、`safeParseResponse`（HTTP 响应解析 + 错误上报） |
| `retry.js` | `withRetry(fn, opts)` 重试工具，decorrelated jitter，支持 AbortSignal |

四层防御：
1. **AppError + ERROR_DEFS**：结构化错误分类（severity / category / retryable）
2. **ErrorBus**：集中收集 + 去重 + 路由分发
3. **safe-fs / safe-parse + RegionalErrorBoundary**：预防性保护
4. **StatusBar + 增强 Toast**：用户反馈（重连状态、持久通知、操作按钮）

### 配置 Scope 管理（v0.63+）

| 文件 | 职责 |
|------|------|
| `config-schema.js` | 配置字段声明式注册表（Single Source of Truth），每个字段标注 scope（global / agent）、getter、setter |
| `config-scope.js` | `splitByScope(partial)` 按 schema 分流配置补丁为 global + agent 两部分；`injectGlobalFields(config, engine)` 为 UI 展示注入全局字段 |
| `migrate-config-scope.js` | 一次性迁移脚本，把历史 per-agent config 中的全局字段上提到 preferences.json |

---

## desktop/ — Electron 桌面应用

### 主进程

| 文件 | 职责 |
|------|------|
| `main.cjs` | Electron 主进程：窗口管理、IPC（v0.65+ `wrapIpcHandler` 统一错误捕获）、spawn Server 独立进程（v0.66+ 自带 Node runtime）、WS browser bridge、系统托盘、文件拖拽 |
| `preload.cjs` | 上下文隔离桥：暴露 IPC 通道给渲染进程 |
| `auto-updater.cjs` | 跨平台自动更新：Windows 走 electron-updater（检测/下载/安装），macOS 走 GitHub API（检测/外链下载）。统一产出 `AutoUpdateState`，支持 beta 通道开关 |

### 前端架构（`desktop/src/`）

前端使用 **React 19 + Zustand 5 + TypeScript + CSS Modules**，通过 Vite 构建。

v0.56.0 完成了全面的前端架构精炼：类型安全（零 `as any`）、状态管理（17 slice，职责单一）、组件拆分（最大组件 < 400 行）、CSS Modules（scoped 样式文件）。后续演进：v0.62 Artifact 标签页状态 + 选中文本引用卡片，v0.63 配置 scope schema 驱动重构，v0.64-v0.65 四层错误处理体系（RegionalErrorBoundary、StatusBar、增强 Toast、ErrorBus bridge）。

#### 页面入口

| 文件 | 页面 |
|------|------|
| `index.html` + `main.tsx` | 主聊天界面 |
| `settings.html` + `settings-main.tsx` | 设置页面 |
| `onboarding.html` + `onboarding.js` | 首次使用引导 |
| `editor-window.html` + `editor-window-entry.ts` | 编辑器窗口（CodeMirror，刻意不用 React） |
| `browser-viewer.html` | 浏览器查看器 |
| `skill-viewer.html` | 技能查看器 |
| `splash.html` | 启动画面 |

#### React 组件（`desktop/src/react/`）

**核心组件（`components/`）：**

| 组件 | 功能 |
|------|------|
| `App.tsx` | 主应用壳，路由 + 布局 |
| `InputArea.tsx` | 消息输入区（支持文件附加） |
| `SessionList.tsx` | 会话列表侧边栏 |
| `WelcomeScreen.tsx` | 欢迎/空状态页 |
| `DeskSection.tsx` | 书桌面板入口 |
| `ChannelsPanel.tsx` | 频道面板 |
| `ActivityPanel.tsx` | 活动面板 |
| `AutomationPanel.tsx` | 自动化面板 |
| `BridgePanel.tsx` | Bridge 平台面板 |
| `BrowserCard.tsx` | 浏览器卡片 |
| `ArtifactEditor.tsx` | Artifact 编辑器 |
| `PreviewPanel.tsx` | 预览面板 |
| `ErrorBoundary.tsx` | 全局错误边界（区分 network / render 错误） |
| `RegionalErrorBoundary.tsx` | 区域错误边界（sidebar / chat / input / desk 独立隔离，v0.64+） |
| `StatusBar.tsx` | WebSocket 连接状态栏（重连计数 / 手动重连按钮，v0.64+） |
| `SidebarLayout.tsx` | 侧边栏布局 |
| `ContextMenu.tsx` | 右键菜单 |
| `FloatPreviewCard.tsx` | 浮动预览卡片 |
| `ToastContainer.tsx` | Toast 通知（v0.64+ 增强：持久通知、操作按钮、去重） |
| `WindowControls.tsx` | 窗口控制（Windows/Linux 自绘标题栏） |
| `SkillViewerOverlay.tsx` | 技能查看器覆盖层 |

**子组件目录（v0.56.0 拆分）：**

| 目录 | 子组件数 | 内容 |
|------|---------|------|
| `components/input/` | 11 | AttachedFilesBar、ContextRing、DocContextButton、ModelSelector、PlanModeButton、SendButton、SlashCommandMenu、ThinkingLevelButton、TodoDisplay、slash-commands |
| `components/desk/` | 10 | DeskCwdSkills、DeskDropZone、DeskEditor、DeskEmptyOverlay、DeskFileItem、DeskFileList、DeskSkillsSection、DeskToolbar、desk-types |
| `components/chat/` | 11 | ChatArea、AssistantMessage、UserMessage、MarkdownContent、MoodBlock、ThinkingBlock、ToolGroupBlock、CompactionNotice、SettingsConfirmCard、XingCard |
| `components/channels/` | 5 | ChannelList、ChannelHeader、ChannelTabBar、ChannelCreateOverlay |

#### 状态管理（Zustand — 17 slices）

| Slice | 管理的状态 |
|-------|----------|
| `session-slice.ts` | 当前 session、消息列表 |
| `streaming-slice.ts` | 流式响应状态 |
| `agent-slice.ts` | Agent 信息 |
| `model-slice.ts` | 模型选择 |
| `channel-slice.ts` | 频道状态 |
| `desk-slice.ts` | 书桌文件状态 |
| `input-slice.ts` | 输入框状态（v0.62+ 含 `quotedSelection` 引用片段） |
| `connection-slice.ts` | WebSocket 连接状态（v0.64+ 增加 `wsState`、`wsReconnectAttempt`） |
| `ui-slice.ts` | UI 状态（侧边栏、面板等） |
| `chat-slice.ts` | 聊天区 UI 状态（+ `chat-types.ts`） |
| `toast-slice.ts` | Toast 通知队列 |
| `artifact-slice.ts` | Artifact 标签页状态（v0.62+ `openTabs` / `activeTabId` 替代旧 `currentArtifactId`） |
| `browser-slice.ts` | 浏览器查看器状态 |
| `context-slice.ts` | 上下文（文档/CWD）状态 |
| `automation-slice.ts` | 自动化/Cron 状态 |
| `activity-slice.ts` | 活动日志状态 |
| `bridge-slice.ts` | Bridge 通信状态（替代旧 `window.__hanaBridge*` 全局变量） |

v0.56.0 将旧的 `misc-slice` 拆分为 artifact / browser / context / automation / activity 五个独立 slice，并新增 bridge-slice、chat-slice、toast-slice。

**Action 文件（业务逻辑提取）：**

| 文件 | 职责 |
|------|------|
| `session-actions.ts` | Session 生命周期、消息加载、列表管理 |
| `agent-actions.ts` | Agent CRUD、身份同步、头像 |
| `artifact-actions.ts` | Artifact 预览/关闭 |
| `desk-actions.ts` | 文件操作、工作区状态 |
| `channel-actions.ts` | 频道管理 |

**设置页（`desktop/src/react/settings/`）：**

| Tab | 设置项 |
|-----|-------|
| `MeTab.tsx` | 用户信息 |
| `AgentTab.tsx` | Agent 管理（创建/删除/配置） |
| `ProvidersTab.tsx` | Provider + 模型管理 |
| `InterfaceTab.tsx` | 界面偏好 |
| `SkillsTab.tsx` | 技能管理 |
| `BridgeTab.tsx` | Bridge 平台连接 |
| `WorkTab.tsx` | 工作设置 |
| `AboutTab.tsx` | 关于 + 更新检查 + beta 通道开关 |

设置页子组件（v0.56.0 拆分）：

| 目录 | 子组件 |
|------|--------|
| `tabs/providers/` | ProviderList、ProviderDetail、ProviderModelList、ModelEditPanel、ApiKeyCredentials、OAuthCredentials、FavoritedModels、OtherModelsSection |
| `tabs/agent/` | AgentCardStack、AgentMemory、AgentExperience、AgentPins、YuanSelector |
| `overlays/` | AgentCreateOverlay、AgentDeleteOverlay、MemoryViewer、CompiledMemoryViewer、ClearMemoryConfirm、CropOverlay、BridgeTutorial |

#### CSS Modules（9 个 scoped 样式文件）

| Module | 覆盖 |
|--------|------|
| `Settings.module.css` | 设置页全部 tab |
| `Chat.module.css` | 消息气泡、工具调用、MOOD、Cron |
| `FloatingPanels.module.css` | 活动/自动化/Bridge 面板 |
| `InputArea.module.css` | 输入区域 |
| `Channels.module.css` | 频道系统 |
| `Desk.module.css` | 书桌面板 |
| `Preview.module.css` | Artifact 预览 |
| `Welcome.module.css` | 欢迎页 |
| `SessionList.module.css` | 会话列表 |

全局 `styles.css` 降至 2975 行，仅保留：设计 Token、reset、App 骨架布局、Markdown 渲染、滚动条、响应式。

#### 通信层

| 文件 | 职责 |
|------|------|
| `react/bridge.ts` | 前端 → Server 通信桥（HTTP fetch + WebSocket） |
| `react/types.ts` | 类型定义，含 `PlatformApi` 契约、`AutoUpdateState` |

#### 服务层（`services/`）

| 文件 | 职责 |
|------|------|
| `websocket.ts` | WebSocket 生命周期管理（v0.64+ 指数退避重连 + 次数上限 + wsState 同步 store） |
| `ws-message-handler.ts` | WebSocket 消息处理（v0.64+ 自动错误上报） |
| `stream-resume.ts` | 流式传输断线恢复 |

#### 错误处理桥接（`errors/`，v0.64+）

| 文件 | 职责 |
|------|------|
| `types.ts` | 前端错误类型声明（ErrorSeverity / ErrorCategory / ErrorRoute / ErrorEntry） |
| `error-bus-bridge.ts` | `initErrorBusBridge()` 订阅 ErrorBus，按路由分发到 toast / statusbar / boundary |

#### 主题（`desktop/src/themes/`）

5 套 CSS 主题，通过 CSS 自定义属性切换：
`warm-paper.css`（默认）、`contemplation.css`、`grass-aroma.css`、`high-contrast.css`、`midnight.css`

#### 工具层

| 文件 | 职责 |
|------|------|
| `lib/theme.js` | 主题切换 |
| `lib/i18n.js` | 前端国际化 |
| `lib/react-init.js` | React 初始化 |
| `modules/platform.js` | 平台适配层（Electron / Web fallback） |
| `modules/icons.js` | SVG 图标库 |
| `modules/utils.js` | 通用工具函数 |
| `react/utils/markdown.ts` | Markdown 渲染 |
| `react/utils/format.ts` | 格式化工具 |
| `react/utils/icons.ts` | 图标工具 |
| `react/utils/message-parser.ts` | 消息解析（mood/xing/attachment/工具详情） |
| `react/utils/agent-helpers.ts` | Agent 辅助函数 |
| `react/utils/file-preview.ts` | 文件预览 |
| `react/utils/history-builder.ts` | 历史构建 |
| `react/utils/ui-helpers.ts` | UI 辅助函数 |

#### Hooks

| Hook | 功能 |
|------|------|
| `use-hana-fetch.ts` | 封装 fetch，自动带 auth |
| `use-i18n.ts` | 国际化 hook |
| `use-platform.ts` | 平台检测 |
| `use-theme.ts` | 主题管理 |
| `use-sidebar-resize.ts` | 侧边栏拖拽调整 |
| `use-stream-buffer.ts` | 流式响应缓冲（性能优化） |

---

## skills2set/ — 技能包

预置技能集，agent 可按需加载。

| 技能包 | 功能 |
|-------|------|
| `canvas-design/` | 画布设计 |
| `quiet-musing/` | 沉思/随想 |
| `skill-creator/` | 技能创建器（元技能） |

---

## scripts/ — 构建脚本

| 文件 | 职责 |
|------|------|
| `launch.js` | 统一启动器，设置环境变量，按模式启动 |
| `fix-modules.cjs` | electron-builder afterPack 钩子，修复 native module |
| `download-git-portable.js` | Windows 构建时下载便携版 Git |

---

## 关键数据流

### 用户发消息（Electron 桌面模式）

```
用户输入 → InputArea.tsx
  → bridge.ts (WebSocket)
  → server/routes/chat.js
  → Hub.send()
  → Engine.prompt()
  → PI SDK → ModelManager._availableModels 解析模型 → LLM API
  → 流式响应 → EventBus
  → WebSocket → bridge.ts
  → streaming-slice → React 渲染
```

### 外部平台消息（Bridge）

```
Telegram/飞书/... → adapter
  → BridgeManager → Hub.send(text, {sessionKey, role})
  → BridgeSessionManager.executeExternalMessage()
  → 查找/创建持久 session（JSONL）
  → PI SDK → LLM API
  → 捕获文本 → adapter → 平台
```

### Hub 消息路由表

`Hub.send(text, opts)` 根据上下文自动路由：

| 条件 | 路由目标 |
|------|---------|
| `opts.from` + `opts.to` | AgentMessenger（agent 间私聊） |
| 无 sessionKey，非 ephemeral | Engine.prompt()（桌面用户对话） |
| sessionKey + role=guest | GuestHandler（Bridge 访客） |
| sessionKey + role=owner | BridgeSessionManager（Bridge 主人） |
| ephemeral=true | Engine.executeIsolated()（Cron/Heartbeat/Channel） |

### Agent 间通信（v0.50+）

| 方式 | 工具 | 特征 |
|------|------|------|
| **同步查询** | `ask_agent` | 借用目标 agent 人格（yuan + ishiki），无记忆/工具，单轮返回 |
| **异步私信** | `dm` | 存 `dm/` 目录，维护聊天历史，DmRouter 异步通知，接收者以频道模式回复 |
| **委派** | `delegate` | 隔离子 session，只读工具白名单，进程级并发上限 3 |

### Sub-agent 委派（Delegate）

```
主 session 调用 delegate tool（可并行多个）
  → createDelegateTool.execute()
  → 并发检查（进程级 MAX_CONCURRENT=3）
  → session-coordinator.executeIsolated()
    → 独立 SessionManager + 独立工具集
      builtin: 只读白名单（read/grep/find/ls）
      custom:  研究类白名单（search_memory/recall_experience/web_search/web_fetch）
    → PI SDK createAgentSession → LLM API
    → AbortSignal 传播（含竞争窗口二次检查）
  → 返回 replyText → 主 session 上下文
  → 临时 session 文件清理
```

### 记忆编译

```
Session 结束 → session-summary.js（摘要）
  → memory-ticker.js（定时触发）
  → compile.js 5 步断点续跑：
    1. compileToday — session 摘要 → today.md
    2. compileWeek — today + week.md → 新 week.md
    3. compileLongterm — 依赖 week 完成
    4. syncToMemory — 合并到 memory.md
    5. cleanup — 归档旧数据
  → fact-store.js（结构化存储到 SQLite）
```

### 自动更新

```
启动时 → auto-updater.cjs
  → 读 preferences.update_channel（stable / beta）
  ├─ Windows: electron-updater
  │   → checkForUpdates() → 检测 GitHub Releases
  │   → 用户点击下载 → downloadUpdate() → 进度推送
  │   → 用户点击安装 → quitAndInstall()
  └─ macOS: GitHub API
      → /releases/latest（stable）或 /releases?per_page=5（beta）
      → 发现新版本 → 用户点击 → shell.openExternal()
      → （签名后可无缝切换到 electron-updater）
  → 统一 AutoUpdateState → IPC → 前端 AboutTab
```

---

## 数据目录结构

```
~/.hanako/                            # 生产（开发用 ~/.hanako-dev/）
├── agents/
│   └── {agentId}/
│       ├── config.yaml               # Agent 身份 + 模型配置
│       ├── memory/
│       │   ├── facts.db              # 事实存储（SQLite）
│       │   ├── memory.md             # 主编译记忆
│       │   ├── today.md              # 今日记忆
│       │   ├── week.md              # 本周记忆
│       │   ├── longterm.md          # 长期记忆
│       │   ├── facts.md             # 事实列表
│       │   └── summaries/           # Session 摘要（JSONL）
│       ├── sessions/
│       │   ├── {session-id}.jsonl    # 消息记录
│       │   └── bridge/
│       │       ├── bridge-sessions.json  # Bridge session 索引
│       │       └── {platform}_{key}.jsonl
│       ├── dm/                       # Agent 间私信记录
│       ├── learned-skills/           # 自学习技能
│       ├── activity/                 # 活动日志
│       ├── desk/
│       │   └── cron.json            # 定时任务
│       └── avatars/                  # 头像
├── user/
│   ├── preferences.json              # 全局偏好（含 update_channel）
│   ├── user.md                       # 用户身份
│   └── avatar/                       # 用户头像
├── channels/                         # 频道数据
├── models.json                       # 模型注册表
├── auth.json                         # OAuth tokens
├── server-info.json                  # Server 就绪信号（Electron 轮询检测端口）
└── logs/                             # 运行日志
```

---

## Session 与 Agent 并发模型

### 当前状态：单焦点模型

系统在**聊天 session** 层面是单焦点的：同一时间只有一个 agent 的一个 session 处于活跃状态。

```
SessionCoordinator
├─ _session        → 当前活跃 session（单指针）
├─ _sessions Map   → LRU 缓存（最多 20 个），按 sessionPath 索引
└─ closeAllSessions() → agent 切换时清空整个 Map，abort 所有 streaming session
```

**切换 agent 时的行为：**

| 组件 | 行为 | 影响 |
|------|------|------|
| `AgentManager.switchAgentOnly()` | 调 `cleanupSession()` | 终止前一个 agent 所有在飞的 chat session |
| `SessionCoordinator.closeAllSessions()` | 遍历 `_sessions` Map，对 streaming session 调 `abort()`，然后 `clear()` | 前一个 agent 正在执行的聊天任务被强制中断 |
| `emitStreamEvent()` (chat.js) | 只在 `sessionPath === engine.currentSessionPath` 时广播 | 背景 agent 的流式事件被缓冲但不推送 |
| 前端 Zustand | `currentAgentId` + `currentSessionPath` 单指针 | UI 只显示一个 agent 的一个对话 |

### 不受 agent 切换影响的后台系统

| 系统 | 存活机制 | 说明 |
|------|---------|------|
| **Cron 定时任务** | per-agent 独立 `CronScheduler`（`_agentCrons` Map） | 各 agent 的 cron 完全独立运行，互不干扰 |
| **Memory Ticker** | per-agent 实例，切换时不 dispose | 所有 agent 的记忆编译持续运行 |
| **Bridge 会话** | 走 `executeIsolated()`，不经过 `_sessions` Map | Telegram/飞书等外部消息不受前台切换影响 |
| **Agent 实例** | `_agents` Map 不清空 | 切换只改 `_activeAgentId`，旧 agent 实例保留 |

### PI SDK 并发能力

**这不是 PI SDK 的限制。** PI SDK (`@mariozechner/pi-coding-agent`) 的设计：

- 每次 `createAgentSession()` 创建独立的 `Agent` 实例
- `isStreaming` 是 `agent._state` 上的实例属性，非全局状态
- 多个 Agent 实例可以**同时 streaming**，各自独立
- `executeIsolated()` 已经在利用这一能力（cron/bridge/delegate 和前台 chat 可并行）

**限制完全来自我们的 SessionCoordinator 架构**：单 `_session` 指针 + agent 切换时的 `closeAllSessions()`。

### 要实现聊天并发需要改什么

1. **后端**：`_sessions` Map 改为 per-agent 隔离，agent 切换时只暂停不 abort
2. **WebSocket 广播**：`emitStreamEvent` 去掉 `currentSessionPath` 过滤，改为按客户端订阅推送
3. **前端**：支持多 agent 会话的并行渲染和输入路由

---

## 设计模式

| 模式 | 应用 |
|------|------|
| **Manager Facade** | Engine 包装各 Manager，对外暴露统一 API |
| **依赖注入** | Manager 不持有 engine 引用，依赖通过构造器传入 |
| **EventBus** | 解耦事件通信，替代直接订阅 |
| **Registry** | Bridge adapter、skills、providers 均用注册表模式 |
| **声明式 Provider 插件** | 每个 provider 文件导出声明对象，ProviderRegistry 统一加载、合并用户配置 |
| **四层 Provider 抽象** | 声明（Registry）→ 凭证（AuthStore）→ 发现（Catalog）→ 路由（Router） |
| **隔离执行** | Cron / Heartbeat / Delegate 用 ephemeral session（不持久化、不影响记忆） |
| **Sub-agent 委派** | `delegate` 工具通过 `executeIsolated` 启动隔离子 session，只读工具白名单，进程级并发上限 3，AbortSignal 向下传播 |
| **断点续跑** | 记忆编译 5 步流程，每步独立，中断后从断点继续 |
| **Steer 插话** | 流式回复中用户可插话（PI SDK `session.steer()`），agent 不中断、吸收新消息调整方向 |
| **单焦点 Session** | 聊天 session 同一时间只有一个活跃，agent 切换时 abort 前一个 agent 的所有 session |
| **四层错误防御** | AppError 分类 → ErrorBus 路由 → safe-fs/RegionalErrorBoundary 预防 → StatusBar/Toast 反馈（v0.64+） |
| **声明式配置 Scope** | `CONFIG_SCHEMA` 标注每个字段归属（global / agent），`splitByScope` 自动分流读写（v0.63+） |
| **CSS Modules** | 组件级样式 scoped 到 `.module.css`，全局 CSS 只保留 Token / reset / 骨架 |
| **Action 分离** | 业务逻辑（网络请求、数据处理）从组件提取到 `*-actions.ts`，slice 只定义状态和同步 setter |

---

## 技术栈速查

| 层 | 技术 |
|---|------|
| 桌面壳 | Electron 38 |
| 前端框架 | React 19 + TypeScript |
| 状态管理 | Zustand 5（17 slices） |
| 样式 | CSS Modules + CSS 自定义属性（5 套主题） |
| 构建 | Vite 7 |
| 后端框架 | Fastify 5 |
| AI SDK | PI Coding Agent SDK |
| 数据库 | better-sqlite3 |
| 浏览器自动化 | Playwright |
| 即时通讯 | node-telegram-bot-api, qq-guild-bot, Lark SDK |
| 自动更新 | electron-updater（Windows）+ GitHub API fallback（macOS） |
| 错误处理 | AppError + ErrorBus + safe-fs/safe-parse + RegionalErrorBoundary（v0.64+） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |
