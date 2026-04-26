/**
 * core/provider-compat.js — LLM HTTP payload 兼容层（唯一对外入口）
 *
 * 架构：dispatcher + 子模块。所有 provider-specific 补丁拆到 ./provider-compat/<name>.js。
 * 完整规范见 ./provider-compat/README.md。
 *
 * 两条调用路径共享本入口（commit f5b5d69 立的纪律）：
 *   - core/llm-client.js 的 callText（非流式 / utility 路径）
 *   - core/engine.js 的 Pi SDK before_provider_request 扩展（流式 / chat 路径）
 *
 * 本文件只保留：
 *   1. dispatcher（按 matches 分发到子模块，first-match-wins）
 *   2. 与 provider 无关的通用补丁（stripEmptyTools, stripIncompatibleThinking）
 *   3. 鉴别函数（isDeepSeekModel, isAnthropicModel）— 供其他 hana 模块复用
 *
 * 不允许在本文件加任何 provider-specific 实现细节；新 provider 一律开
 * core/provider-compat/<name>.js 子模块。
 */

import * as deepseek from "./provider-compat/deepseek.js";
import * as qwen from "./provider-compat/qwen.js";

/**
 * 子模块注册表。顺序敏感：first-match-wins。
 * 新 provider 默认加在末尾；只有当模块的 matches 是另一模块子集（更具体规则）时才前置。
 */
const PROVIDER_MODULES = [deepseek, qwen];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

// ── Provider 鉴别（导出供其他 hana 模块复用，不属于子模块逻辑）──

/**
 * 判断 model 是否走 DeepSeek 兼容路径。
 * 委托给 deepseek 子模块的 matches，避免双源真相。
 */
export function isDeepSeekModel(model) {
  return deepseek.matches(model);
}

/**
 * 判断 model 是否走 Anthropic 兼容路径。
 * Anthropic 没有专门的子模块（pi-ai SDK 已直接兼容），仅供本文件 stripIncompatibleThinking 与
 * 其他 hana 模块的鉴别需求复用。
 */
export function isAnthropicModel(model) {
  if (!model || typeof model !== "object") return false;
  return lower(model.provider) === "anthropic";
}

// ── 通用 payload 处理（与 provider 无关）──

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
 * Provider payload 兼容化的唯一入口。chat 路径与 utility 路径共享。
 *
 * 处理顺序：
 *   1. 通用补丁（stripEmptyTools / stripIncompatibleThinking）
 *   2. 子模块分发（first-match-wins，最多匹配一个）
 *
 * @param {object} payload — 即将发送的 HTTP body（OpenAI / Anthropic 风格）
 * @param {object|null|undefined} model — 完整 model 对象 {id, provider, baseUrl, reasoning, maxTokens, quirks, ...}
 * @param {{ mode?: "chat" | "utility", reasoningLevel?: string }} [options]
 * @returns {object} 处理后的 payload
 */
export function normalizeProviderPayload(payload, model, options = {}) {
  if (!payload || typeof payload !== "object") return payload;

  let result = payload;

  // 1. 通用补丁（与 provider 无关）
  result = stripEmptyTools(result);
  result = stripIncompatibleThinking(result, model);

  // 2. Provider-specific 补丁（按 matches 分发，first-match-wins）
  for (const mod of PROVIDER_MODULES) {
    if (mod.matches(model)) {
      result = mod.apply(result, model, options);
      break;
    }
  }

  return result;
}
