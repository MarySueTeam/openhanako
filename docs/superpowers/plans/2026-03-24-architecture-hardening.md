# 架构加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 v0.56 精炼遗漏的巨型组件、消灭 React 范式违规、封堵 engine._ 泄漏，并通过 ESLint 建立自动化防线防止回归。

**Architecture:** 两阶段推进。Phase 1 做结构性组件拆分（OnboardingApp、App.tsx、SkillsTab、BridgeTab、ChannelList、PreviewPanel），每个组件拆完独立验证。Phase 2 做散点纪律修复（key={index}、window 全局、engine._ 穿透、静默 catch）并配置 ESLint 规则防回归。

**Tech Stack:** React 19, Zustand 5, TypeScript, Vite 7, ESLint 9 (flat config)

**验证命令：** 每个 Task 完成后运行 `npm start` 确认应用正常启动，无白屏、无控制台报错。涉及 TypeScript 的改动额外运行 `npx tsc --noEmit` 确认零类型错误。

---

## Phase 1：结构性重构

### Task 1: OnboardingApp.tsx 拆分（900 行 → 7 个文件）

**Files:**
- Modify: `desktop/src/react/onboarding/OnboardingApp.tsx` → 降为 ~150 行编排层
- Create: `desktop/src/react/onboarding/constants.ts` — PROVIDER_PRESETS, OB_THEMES, LOCALES 等常量
- Create: `desktop/src/react/onboarding/onboarding-actions.ts` — hanaFetch 封装 + 所有 API 调用
- Create: `desktop/src/react/onboarding/steps/LocaleStep.tsx` — Step 0: 语言选择
- Create: `desktop/src/react/onboarding/steps/NameStep.tsx` — Step 1: 用户名输入
- Create: `desktop/src/react/onboarding/steps/ProviderStep.tsx` — Step 2: Provider 配置 + 连接测试
- Create: `desktop/src/react/onboarding/steps/ModelStep.tsx` — Step 3: 模型选择
- Create: `desktop/src/react/onboarding/steps/ThemeStep.tsx` — Step 4: 主题选择
- Create: `desktop/src/react/onboarding/steps/TutorialStep.tsx` — Step 5: 教程 + 完成

**拆分原则：**
- 每个 Step 组件接收 props：`goToStep`, `showError`, `hanaFetch`, `serverPort`, `serverToken`
- 常量（PROVIDER_PRESETS, OB_THEMES, LOCALES, TOTAL_STEPS）提取到 `constants.ts`
- API 调用逻辑（testConnection, saveProvider, loadModels, saveModel 等）提取到 `onboarding-actions.ts`
- StepContainer, Multiline, TutorialCard, Icon 组件保留在 OnboardingApp.tsx 底部（仅被本模块引用）
- 状态按 Step 切割：每个 Step 组件用 useState 管理自己的局部状态（如 ProviderStep 管 apiKey/testStatus）
- 跨步骤共享的状态（step, stepKey, serverPort, serverToken, agentName, avatarSrc）留在 OnboardingApp

- [ ] **Step 1:** 创建 `constants.ts`，把 PROVIDER_PRESETS（~L44-72）、OB_THEMES（~L74-76）、LOCALES（~L78-80）、TOTAL_STEPS 从 OnboardingApp.tsx 剪切过去

- [ ] **Step 2:** 创建 `onboarding-actions.ts`，提取 API 调用函数：`testProviderConnection()`, `saveProviderConfig()`, `fetchModels()`, `saveModelConfig()`, `saveLocale()`, `saveUserName()`, `completeOnboarding()`。每个函数接收 `(serverPort, serverToken, ...params)` 而非闭包引用

- [ ] **Step 3:** 创建 `steps/LocaleStep.tsx`（Step 0），从 OnboardingApp.tsx 的 L529-551 提取。Props: `{ locale, agentName, avatarSrc, onNext }`

- [ ] **Step 4:** 创建 `steps/NameStep.tsx`（Step 1），从 L554-580 提取。Props: `{ onNext, onBack }`

- [ ] **Step 5:** 创建 `steps/ProviderStep.tsx`（Step 2），从 L583-690 提取。这是最大的 Step，包含 preset 选择、custom 输入、API key、测试连接。所有 provider 相关状态（selectedPreset, apiKey, testStatus 等 ~12 个 useState）移入此组件

- [ ] **Step 6:** 创建 `steps/ModelStep.tsx`（Step 3），从 L693-766 提取。Props: `{ onNext, onBack, hanaFetch }`。fetchedModels, selectedModel, modelSearch 等状态移入此组件

- [ ] **Step 7:** 创建 `steps/ThemeStep.tsx`（Step 4），从 L769-803 提取

- [ ] **Step 8:** 创建 `steps/TutorialStep.tsx`（Step 5），从 L806-837 提取

- [ ] **Step 9:** 改写 OnboardingApp.tsx，只保留：共享状态（step, stepKey, serverPort, serverToken, agentName, avatarSrc）+ init useEffect + progress dots + step switch 渲染 + 底部辅助组件。目标 ≤150 行

- [ ] **Step 10:** 运行 `npx tsc --noEmit && npm start`，打开 onboarding 窗口走完全流程验证

- [ ] **Step 11:** Commit
```bash
git add desktop/src/react/onboarding/
git commit -m "refactor(onboarding): split OnboardingApp 900→7 files"
```

---

### Task 2: App.tsx 拆分（635 行 → 3 个文件）

**Files:**
- Modify: `desktop/src/react/App.tsx` → 降为 ~250 行（纯布局）
- Create: `desktop/src/react/app-init.ts` — init() 函数 + 全局错误监听器 + keyboard shortcut 注册
- Create: `desktop/src/react/MainContent.tsx` — 拖拽区域 + 聊天/频道/面板布局

**拆分原则：**
- `app-init.ts` 导出 `initApp(store)` 函数，包含 L87-231 的全部初始化逻辑 + L64-83 的 window error listeners。不是 React 组件，是纯函数
- `MainContent.tsx` 包含 MainContentDrag 组件 + handleDrop 函数 + DropText 组件。Props: `{ currentTab }`
- App.tsx 保留：useEffect 调 initApp、titlebar、sidebar、MainContent、overlays、StatusBar/Toast 的编排
- 内联子组件（WelcomeContainer, AutomationBadge, BridgeDot, ConnectionStatus, JianChannelInfo）体量小（5-15行），留在 App.tsx

- [ ] **Step 1:** 创建 `app-init.ts`，把 init() 函数（L87-231）+ window error/rejection listeners（L64-83）剪切过去。导出 `initApp()` 函数。确保 `initTheme()` 和 `initDragPrevention()` 的模块顶层调用留在 App.tsx

- [ ] **Step 2:** 创建 `MainContent.tsx`，把 MainContentDrag 组件（L518-558）+ handleDrop 函数（L235-300）+ DropText 组件（L579-582）移入。导出 `MainContent` 组件

- [ ] **Step 3:** 改写 App.tsx：import initApp 和 MainContent，useEffect 里调 `initApp()`，JSX 里用 `<MainContent>`。目标 ≤250 行

- [ ] **Step 4:** 运行 `npx tsc --noEmit && npm start`，验证主窗口正常（拖拽文件、切换 tab、sidebar 操作）

- [ ] **Step 5:** Commit
```bash
git add desktop/src/react/App.tsx desktop/src/react/app-init.ts desktop/src/react/MainContent.tsx
git commit -m "refactor(app): extract init + MainContent from App.tsx (635→250 lines)"
```

---

### Task 3: SkillsTab.tsx 拆分（641 行 → 4 个文件）

**Files:**
- Modify: `desktop/src/react/settings/tabs/SkillsTab.tsx` → 降为 ~200 行
- Create: `desktop/src/react/settings/tabs/skills/SkillRow.tsx` — 技能行组件（含 ExternalSkillRow）
- Create: `desktop/src/react/settings/tabs/skills/CompatPathDrawer.tsx` — 外部技能路径折叠面板
- Create: `desktop/src/react/settings/tabs/skills/SkillCapabilities.tsx` — 学习能力配置区（含 GitHub/Safety 警告弹窗）

**拆分原则：**
- SkillRow（L479-529）和 ExternalSkillRow（L531-571）合并到一个文件，共享渲染逻辑
- CompatPathDrawer（L573-641）已经是独立组件，直接提取
- SkillCapabilities 包含 learn_skills toggle + GitHub/Safety 警告弹窗（L298-474），这块逻辑自成一体
- SkillsTab 保留：用户技能列表 + 拖拽安装 + 外部路径管理的编排层

- [ ] **Step 1:** 创建 `skills/SkillRow.tsx`，提取 SkillRow + ExternalSkillRow。共用 Props 接口，通过 `deletable` 布尔值区分

- [ ] **Step 2:** 创建 `skills/CompatPathDrawer.tsx`，提取 CompatPathDrawer 组件

- [ ] **Step 3:** 创建 `skills/SkillCapabilities.tsx`，提取学习能力配置区 + GitHub/Safety 两个警告弹窗。内部管理 showGithubWarning / showSafetyWarning 状态

- [ ] **Step 4:** 改写 SkillsTab.tsx，import 三个子组件，目标 ≤200 行

- [ ] **Step 5:** 运行 `npx tsc --noEmit && npm start`，打开设置页 Skills tab 验证：技能列表、toggle、外部路径、警告弹窗

- [ ] **Step 6:** Commit
```bash
git add desktop/src/react/settings/tabs/SkillsTab.tsx desktop/src/react/settings/tabs/skills/
git commit -m "refactor(settings): split SkillsTab 641→4 files"
```

---

### Task 4: BridgeTab.tsx 拆分（597 行 → 3 个文件）

**Files:**
- Modify: `desktop/src/react/settings/tabs/BridgeTab.tsx` → 降为 ~150 行
- Create: `desktop/src/react/settings/tabs/bridge/PlatformSection.tsx` — 通用平台配置区组件
- Create: `desktop/src/react/settings/tabs/bridge/BridgeWidgets.tsx` — BridgeStatusDot + BridgeStatusText + OwnerSelect

**拆分原则：**
- 5 个平台区段（Telegram、飞书、QQ、微信、WhatsApp）高度重复，用 `PlatformSection` 泛型组件消除重复。Props 接收：平台名、credential 字段定义、状态、回调
- 微信特殊（扫码 vs token），通过 `renderCustomBody` prop 自定义
- BridgeStatusDot（L525-531）、BridgeStatusText（L533-538）、OwnerSelect（L540-597）提取到 BridgeWidgets
- BridgeTab 保留：状态加载 + PublicIshiki textarea + 5 个 PlatformSection 实例

- [ ] **Step 1:** 创建 `bridge/BridgeWidgets.tsx`，提取 BridgeStatusDot、BridgeStatusText、OwnerSelect 三个组件

- [ ] **Step 2:** 创建 `bridge/PlatformSection.tsx`，抽象出通用平台配置区。Props:
```typescript
interface PlatformSectionProps {
  platform: string;
  title: string;
  status?: { status?: string; error?: string; enabled?: boolean };
  credentialFields: { key: string; label: string; type: 'text' | 'secret'; value: string; onChange: (v: string) => void }[];
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  testing: boolean;
  ownerUsers?: KnownUser[];
  currentOwner?: string;
  onOwnerChange?: (userId: string) => void;
  children?: React.ReactNode;  // 微信扫码等自定义内容
}
```

- [ ] **Step 3:** 改写 BridgeTab.tsx，用 PlatformSection 替换 5 个重复区段。目标 ≤150 行

- [ ] **Step 4:** 运行 `npx tsc --noEmit && npm start`，打开设置页 Bridge tab 验证：5 个平台区段、token 输入、测试连接、toggle 开关

- [ ] **Step 5:** Commit
```bash
git add desktop/src/react/settings/tabs/BridgeTab.tsx desktop/src/react/settings/tabs/bridge/
git commit -m "refactor(settings): split BridgeTab 597→3 files, deduplicate platform sections"
```

---

### Task 5: ChannelList.showChannelWarning() → React 确认对话框

**Files:**
- Modify: `desktop/src/react/components/channels/ChannelList.tsx` — 删除 showChannelWarning 函数
- Create: `desktop/src/react/components/channels/ChannelWarningModal.tsx` — React 确认对话框组件

**问题：** `showChannelWarning()` (L116-163) 用 `document.createElement` 手搓了一个完整的确认对话框（overlay + box + title + body + buttons），返回 Promise<boolean>。这是 React 迁移时遗漏的孤岛。

- [ ] **Step 1:** 创建 `ChannelWarningModal.tsx`：
```tsx
interface ChannelWarningModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ChannelWarningModal({ open, onConfirm, onCancel }: ChannelWarningModalProps) {
  if (!open) return null;
  const t = window.t;
  const body = (t('channel.warningBody') || '').split('\n\n');
  return (
    <div className="hana-warning-overlay">
      <div className="hana-warning-box">
        <h3 className="hana-warning-title">{t('channel.warningTitle')}</h3>
        <div className="hana-warning-body">
          {body.map((para, idx) => (
            <p key={`para-${idx}`}>
              {para.split('\n').map((line, li) => (
                <span key={`line-${li}`}>{li > 0 && <br />}{line}</span>
              ))}
            </p>
          ))}
        </div>
        <div className="hana-warning-actions">
          <button className="hana-warning-cancel" onClick={onCancel}>{t('channel.createCancel')}</button>
          <button className="hana-warning-confirm" onClick={onConfirm}>{t('channel.warningConfirm')}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2:** 在 ChannelList.tsx 中，删除 `showChannelWarning()` 函数（L116-163）。添加 `const [warningOpen, setWarningOpen] = useState(false)` 状态。在调用 `showChannelWarning()` 的地方改为 `setWarningOpen(true)`，确认/取消回调里处理原有的 resolve 逻辑

- [ ] **Step 3:** 在 ChannelList 的 JSX 底部添加 `<ChannelWarningModal open={warningOpen} onConfirm={...} onCancel={...} />`

- [ ] **Step 4:** 运行 `npx tsc --noEmit && npm start`，切到 Channels tab，触发需要警告的操作验证弹窗

- [ ] **Step 5:** Commit
```bash
git add desktop/src/react/components/channels/
git commit -m "refactor(channels): replace imperative showChannelWarning with React component"
```

---

### Task 6: PreviewPanel 命令式 DOM → React ArtifactRenderer

**Files:**
- Modify: `desktop/src/react/components/PreviewPanel.tsx` — 删除 switch/case DOM 构建
- Create: `desktop/src/react/components/preview/ArtifactRenderer.tsx` — 按类型渲染 artifact

**问题：** PreviewPanel 的 useEffect（L74-218）用 `document.createElement` 为每种 artifact 类型手搓 DOM 节点（iframe, pre, img, table 等），共 11 个 case 分支、~150 行命令式代码。

- [ ] **Step 1:** 创建 `preview/ArtifactRenderer.tsx`，包含主组件和类型子组件：
```tsx
import { renderMarkdown } from '../../utils/markdown';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { fileIconSvg } from '../../utils/icons';
import type { Artifact } from '../../types';

interface ArtifactRendererProps {
  artifact: Artifact;
}

export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  switch (artifact.type) {
    case 'html':
      return <iframe sandbox="allow-scripts" srcDoc={artifact.content} />;
    case 'markdown':
      return <MarkdownPreview content={artifact.content} />;
    case 'code':
      return (
        <pre className="preview-code">
          <code className={artifact.language ? `language-${artifact.language}` : undefined}>
            {artifact.content}
          </code>
        </pre>
      );
    case 'svg':
      return <img className="preview-image" src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(artifact.content)))}`} alt={artifact.title} />;
    case 'image':
      return <img className="preview-image" src={`data:image/${artifact.ext === 'jpg' ? 'jpeg' : (artifact.ext || 'png')};base64,${artifact.content}`} alt={artifact.title} />;
    case 'pdf':
      return <iframe className="preview-pdf" src={`data:application/pdf;base64,${artifact.content}`} />;
    case 'csv':
      return <CsvPreview content={artifact.content} />;
    case 'docx':
      return <div className="preview-docx md-content" dangerouslySetInnerHTML={{ __html: artifact.content }} />;
    case 'xlsx':
      return <div className="preview-csv" dangerouslySetInnerHTML={{ __html: artifact.content }} />;
    case 'file-info':
      return <FileInfoPreview artifact={artifact} />;
    default:
      return <pre className="preview-code">{artifact.content}</pre>;
  }
}
```

MarkdownPreview 需要 useEffect + ref 来调用 injectCopyButtons（因为需要 DOM ref）：
```tsx
function MarkdownPreview({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) injectCopyButtons(ref.current);
  }, [content]);
  return <div ref={ref} className="preview-markdown md-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
```

CsvPreview 用 parseCSV + JSX table。FileInfoPreview 用 JSX 替代 createElement。

- [ ] **Step 2:** 在 PreviewPanel.tsx 中，删除 L74-218 的 useEffect switch/case 块。在 JSX 的 body ref 区域内，当 `!editable && artifact` 时渲染 `<ArtifactRenderer artifact={artifact} />`

- [ ] **Step 3:** 清理 PreviewPanel.tsx 中不再需要的 import（如果 renderMarkdown, parseCSV, fileIconSvg 已全部移入 ArtifactRenderer）

- [ ] **Step 4:** 运行 `npx tsc --noEmit && npm start`，测试各种 artifact 类型的预览：HTML、Markdown、代码、CSV、图片、SVG

- [ ] **Step 5:** Commit
```bash
git add desktop/src/react/components/PreviewPanel.tsx desktop/src/react/components/preview/ArtifactRenderer.tsx
git commit -m "refactor(preview): replace imperative DOM with React ArtifactRenderer"
```

---

## Phase 2：纪律执行 + 防回归

### Task 7: 消灭所有 key={index}

**Files (10 个文件，15 处修改):**
- Modify: `desktop/src/react/components/chat/AssistantMessage.tsx:93`
- Modify: `desktop/src/react/components/chat/UserMessage.tsx:82,92`
- Modify: `desktop/src/react/components/BridgePanel.tsx:286`
- Modify: `desktop/src/react/components/ContextMenu.tsx:82,86`
- Modify: `desktop/src/react/components/SkillViewerOverlay.tsx:133,189`
- Modify: `desktop/src/react/components/ActivityPanel.tsx:275,298`
- Modify: `desktop/src/react/components/input/TodoDisplay.tsx:17`
- Modify: `desktop/src/react/settings/overlays/BridgeTutorial.tsx:36,44`
- Modify: `desktop/src/react/onboarding/OnboardingApp.tsx` — progress dots 的 key={i} + Multiline 组件的 key={i}。**注意：** Task 1 已拆分此文件，行号会变。按 `key={i}` 模式搜索定位，不要依赖行号。

**策略：**
- 有唯一 ID 的数据（messages, todos, channels）→ 用 `item.id`
- 有唯一属性的数据（attachments 用 name、menu items 用 label）→ 用该属性
- 纯展示列表（progress dots、text lines、tutorial steps）→ 用 `\`prefix-${index}\`` 语义前缀
- ContextMenu 的 items 加 `id` 或用 `label` 做 key

- [ ] **Step 1:** 逐文件替换。每处修改确认：（1）key 在兄弟节点中唯一 （2）key 在列表重新排序时稳定

- [ ] **Step 2:** 运行 `npx tsc --noEmit && npm start`

- [ ] **Step 3:** Commit
```bash
git commit -m "fix: replace all key={index} with unique keys (15 instances across 10 files)"
```

---

### Task 8: window.__oauthSessionId → Zustand

**Files:**
- Modify: `desktop/src/react/settings/tabs/providers/OAuthCredentials.tsx:43,58`
- Modify: `desktop/src/react/stores/connection-slice.ts` — 添加 `oauthSessionId` 字段（或新建 auth-slice）

- [ ] **Step 1:** 在 connection-slice.ts（或更合适的 slice）中添加 `oauthSessionId: string | null` 状态和 `setOauthSessionId` setter

- [ ] **Step 2:** 在 OAuthCredentials.tsx 中，将 `window.__oauthSessionId = data.sessionId` 替换为 `useStore.getState().setOauthSessionId(data.sessionId)`，将读取处替换为 `useStore.getState().oauthSessionId`

- [ ] **Step 3:** 从 `global.d.ts` 中移除 `__oauthSessionId` 声明（如果有的话）

- [ ] **Step 4:** 运行 `npx tsc --noEmit && npm start`，测试 OAuth 登录流程

- [ ] **Step 5:** Commit
```bash
git commit -m "refactor: move oauthSessionId from window global to Zustand store"
```

---

### Task 9: engine._ 穿透 → public facade

**Files:**
- Modify: `core/engine.js:407` — 去掉 `_resolveProviderCredentials` 的下划线，改为 `resolveProviderCredentials`
- Modify: `core/engine.js:578` — 添加 public `emitEvent(event, sessionPath)` 方法
- Modify: `server/routes/models.js:79` — `engine._resolveProviderCredentials` → `engine.resolveProviderCredentials`
- Modify: `server/routes/confirm.js:22` — `engine._emitEvent` → `engine.emitEvent`

- [ ] **Step 1:** 在 engine.js 中：
  - L407: 把 `_resolveProviderCredentials` 重命名为 `resolveProviderCredentials`（公开方法）
  - L578 后添加：`emitEvent(event, sessionPath) { this._emitEvent(event, sessionPath); }`
  - 保留 `_emitEvent` 作为内部实现（被 `emitDevLog` 等内部方法调用）

- [ ] **Step 2:** 在 `server/routes/models.js:79`，改 `engine._resolveProviderCredentials(` → `engine.resolveProviderCredentials(`

- [ ] **Step 3:** 在 `server/routes/confirm.js:22`，改 `engine._emitEvent(` → `engine.emitEvent(`

- [ ] **Step 4:** 全局搜索确认无其他 `engine._resolveProviderCredentials` 或路由文件中的 `engine._emitEvent` 调用

- [ ] **Step 5:** 运行 `npm start`，验证模型切换和确认流正常

- [ ] **Step 6:** Commit
```bash
git commit -m "refactor(engine): expose resolveProviderCredentials + emitEvent as public API"
```

---

### Task 10: 静默 .catch(() => {}) → 有意义的错误处理

**Files (5 处，3 处 clipboard 可保留):**
- Modify: `desktop/src/react/stores/channel-actions.ts:105` — mark-as-read 失败应 console.warn
- Modify: `desktop/src/react/settings/overlays/WechatQrcodeOverlay.tsx:89` — 设置 owner 失败应 console.warn
- Modify: `desktop/src/react/components/InputArea.tsx:222` — 加载 config 失败应 console.warn

clipboard 的 3 处（DeskFileItem, AssistantMessage, XingCard）可以保留空 catch，因为 clipboard API 在无焦点/无权限时 reject 是正常行为，不值得通知用户。但加上注释说明为什么静默。

- [ ] **Step 1:** 3 处非 clipboard 的 catch 改为 `catch((err) => console.warn('[context]', err))`

- [ ] **Step 2:** 3 处 clipboard catch 加注释：`// clipboard 无权限时静默（非关键操作）`

- [ ] **Step 3:** Commit
```bash
git commit -m "fix: replace silent catches with console.warn, document clipboard exceptions"
```

---

### Task 11: ESLint 配置（防回归自动化防线）

**Files:**
- Create: `eslint.config.js` — ESLint flat config
- Modify: `package.json` — 添加 eslint + 插件依赖 + lint script

**注意：** 项目当前没有 ESLint。这是从零开始配置。目标是防止已修复的问题回归，不追求覆盖所有规则。

- [ ] **Step 1:** 安装依赖
```bash
npm install --save-dev eslint @eslint/js typescript-eslint eslint-plugin-react-hooks
```

- [ ] **Step 2:** 创建 `eslint.config.js`（flat config 格式）：
```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['desktop/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // 防止 key={index} 回归 — 需要手动检查（ESLint 无内置规则精确匹配）
      // 用 no-restricted-syntax 禁止 document.createElement in .tsx
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name='createElement']",
          message: 'React 组件中不要用 document.createElement，用 JSX。如确需操作 DOM（canvas/resize），加 eslint-disable 注释说明原因。',
        },
      ],
      // React hooks 规则
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript 相关
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // server routes: 禁止 engine._ 穿透
    files: ['server/routes/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='engine'][property.name=/^_/]",
          message: '不要访问 engine 的私有方法。通过 engine 公开 API 访问。',
        },
      ],
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'dist-renderer/', '**/*.cjs'],
  },
];
```

- [ ] **Step 3:** 在 `package.json` scripts 中添加：`"lint": "eslint desktop/src/ server/"`

- [ ] **Step 4:** 运行 `npm run lint`，确认输出中：
  - 零 `engine._` 违规（Task 9 已修复）
  - `@typescript-eslint/no-explicit-any` 产生 warn（不阻塞，作为渐进改善信号）
  - `document.createElement` 规则会在以下合法场景触发，需逐一加 `// eslint-disable-next-line no-restricted-syntax -- [原因]`：

| 文件 | 原因 |
|------|------|
| `components/ArtifactEditor.tsx` | CodeMirror widget，非 React 管理的 DOM |
| `components/chat/AssistantMessage.tsx` | 临时 div 做文本提取（clipboard） |
| `settings/helpers.ts` | `escapeHtml()` 工具函数 |
| `settings/tabs/MeTab.tsx` | 文件选择器触发 `<input type="file">` |
| `settings/tabs/AgentTab.tsx` | 文件选择器触发 |
| `settings/tabs/agent/AgentMemory.tsx` | 下载链接 + 文件选择器 |
| `settings/overlays/CropOverlay.tsx` | canvas 图片裁剪 |
| `react/utils/format.ts` | 注入复制按钮到已渲染 Markdown |
| `editor-window-entry.ts` | CodeMirror 编辑器窗口，刻意不用 React，自管 DOM |

- [ ] **Step 5:** 逐一给上述 8 个文件的合法 `document.createElement` 调用加 eslint-disable 注释

- [ ] **Step 6:** ~~electron-rebuild 已不需要~~（v0.66+ Server 以独立 Node 进程运行，native addon 由 build-server.mjs 处理）

- [ ] **Step 7:** Commit
```bash
git commit -m "chore: add ESLint with architecture guardrails (no-createElement, no-engine._, hooks rules)"
```

---

## 验收检查清单

完成所有 Task 后的最终验证：

- [ ] `npx tsc --noEmit` — 零 TypeScript 错误
- [ ] `npm run lint` — 零 error（warn 可接受）
- [ ] `npm start` — 应用正常启动，无白屏
- [ ] Onboarding 窗口走完 6 步
- [ ] 设置页：Skills tab、Bridge tab 功能正常
- [ ] Channels tab：创建频道触发警告弹窗正常
- [ ] 预览面板：HTML/Markdown/Code/CSV/Image 各类型预览正常
- [ ] ~~electron-rebuild 已不需要~~（v0.66+）
