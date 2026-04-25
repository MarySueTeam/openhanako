/**
 * core/provider-compat.js — LLM HTTP payload 兼容层（唯一根）
 *
 * 所有 provider-specific 的 payload 调整集中在这里。两条调用路径共享：
 *   - core/llm-client.js 的 callText（非流式 / utility 路径）
 *   - core/engine.js 的 Pi SDK before_provider_request 扩展（流式 / chat 路径）
 *
 * 末端分叉只发生在 fetch 层本身（流式 SSE vs 非流式 POST），跟 provider 兼容性无关。
 *
 * mode 区分：
 *   - "chat"：保留思考链。chat 路径默认。
 *   - "utility"：短文本调用，DeepSeek reasoning 模型主动 disableThinking
 *     （utility 是 50~500 token 输出，思考链既无意义也耗光预算）。
 */

const DEEPSEEK_HIGH_THINKING_BUDGET = 32768;
const DEEPSEEK_HIGH_SAFE_MAX_TOKENS = 65536;
const DEEPSEEK_MAX_SAFE_MAX_TOKENS = 131072;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ── Provider 鉴别 ──

export function isDeepSeekModel(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

export function isAnthropicModel(model) {
  if (!model || typeof model !== "object") return false;
  return lower(model.provider) === "anthropic";
}

function isKnownThinkingModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-reasoner" || normalized.startsWith("deepseek-v4-");
}

// ── DeepSeek 专用处理 ──

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function reasoningEffortForLevel(level) {
  if (!level) return null;
  if (level === "xhigh" || level === "max") return "max";
  if (level === "minimal" || level === "low" || level === "medium" || level === "high") return "high";
  return null;
}

function applyRequestedReasoningLevel(payload, level) {
  const effort = reasoningEffortForLevel(level);
  if (effort) payload.reasoning_effort = effort;
}

function enableThinking(payload) {
  payload.thinking = { type: "enabled" };
}

function shouldUseThinking(payload, model, reasoningLevel) {
  if (payload.thinking?.type === "disabled") return false;
  if (isThinkingOff(reasoningLevel)) return false;
  const knownThinkingModel = model?.reasoning === true || isKnownThinkingModelId(model?.id || payload.model);
  return Boolean(
    payload.reasoning_effort
    || (knownThinkingModel && reasoningEffortForLevel(reasoningLevel))
    || knownThinkingModel
  );
}

function normalizeReasoningEffort(payload) {
  if (!hasOwn(payload, "reasoning_effort")) return;
  if (payload.reasoning_effort === "low" || payload.reasoning_effort === "medium") {
    payload.reasoning_effort = "high";
  } else if (payload.reasoning_effort === "xhigh") {
    payload.reasoning_effort = "max";
  }
}

function stripReasoningContent(messages) {
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || !hasOwn(message, "reasoning_content")) {
      return message;
    }
    changed = true;
    const copy = { ...message };
    delete copy.reasoning_content;
    return copy;
  });
  return changed ? next : messages;
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return;
  if (!hasOwn(payload, "max_tokens")) {
    payload.max_tokens = payload.max_completion_tokens;
  }
  delete payload.max_completion_tokens;
}

function ensureThinkingTokenBudget(payload, model) {
  const current = positiveInteger(payload.max_tokens);
  if (current && current > DEEPSEEK_HIGH_THINKING_BUDGET) return;

  const modelLimit = positiveInteger(model?.maxTokens || model?.maxOutput);
  const desired = payload.reasoning_effort === "max"
    ? DEEPSEEK_MAX_SAFE_MAX_TOKENS
    : DEEPSEEK_HIGH_SAFE_MAX_TOKENS;
  const target = modelLimit ? Math.min(modelLimit, desired) : desired;

  if (target <= DEEPSEEK_HIGH_THINKING_BUDGET) {
    disableThinking(payload);
    return;
  }

  payload.max_tokens = target;
}

function applyDeepSeekCompat(payload, model, options) {
  if (!Array.isArray(payload.messages)) return payload;
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (hasOwn(payload, "max_completion_tokens")) {
    normalizeMaxTokenField(editable());
  }

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    disableThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  if (mode === "utility") {
    disableThinking(editable());
    return next;
  }

  const p = editable();
  applyRequestedReasoningLevel(p, reasoningLevel);
  normalizeReasoningEffort(p);
  enableThinking(p);
  ensureThinkingTokenBudget(p, model);
  return next;
}

// ── 通用 payload 处理 ──

function stripEmptyTools(payload) {
  if (Array.isArray(payload.tools) && payload.tools.length === 0) {
    const { tools, ...rest } = payload;
    return rest;
  }
  return payload;
}

function stripIncompatibleThinking(payload, model) {
  if (!payload.thinking) return payload;
  // thinking 字段只有 anthropic-messages / deepseek 协议接受。其他 provider 收到会 400。
  // 没有 model 信息时保守保留（旧降级路径），避免误删 anthropic 调用。
  if (!model) return payload;
  if (isAnthropicModel(model) || isDeepSeekModel(model)) return payload;
  const { thinking, ...rest } = payload;
  return rest;
}

/**
 * Provider payload 兼容化的唯一入口。
 *
 * @param {object} payload — 即将发送的 HTTP body（OpenAI / Anthropic 风格）
 * @param {object|null|undefined} model — 完整 model 对象 {id, provider, baseUrl, reasoning, maxTokens, ...}
 * @param {{ mode?: "chat" | "utility", reasoningLevel?: string }} [options]
 * @returns {object} 处理后的 payload
 */
export function normalizeProviderPayload(payload, model, options = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const mode = options.mode || "chat";

  let result = payload;
  result = stripEmptyTools(result);
  result = stripIncompatibleThinking(result, model);

  if (isDeepSeekModel(model)) {
    result = applyDeepSeekCompat(result, model, { mode, reasoningLevel: options.reasoningLevel });
  }

  return result;
}
