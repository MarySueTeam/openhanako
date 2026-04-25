import { describe, expect, it } from "vitest";
import {
  normalizeProviderPayload,
  isDeepSeekModel,
  isAnthropicModel,
} from "../core/provider-compat.js";

describe("isDeepSeekModel", () => {
  it("只把官方 DeepSeek provider / baseUrl 视为 DeepSeek 兼容路径", () => {
    expect(isDeepSeekModel({ provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    expect(isDeepSeekModel({ provider: "openrouter", id: "deepseek/deepseek-v3.2" })).toBe(false);
  });
});

describe("isAnthropicModel", () => {
  it("匹配 anthropic provider", () => {
    expect(isAnthropicModel({ provider: "anthropic" })).toBe(true);
    expect(isAnthropicModel({ provider: "openai" })).toBe(false);
  });
});

describe("normalizeProviderPayload — 通用层", () => {
  it("剥离空 tools 数组（dashscope/volcengine 兼容）", () => {
    const payload = {
      model: "qwen3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const result = normalizeProviderPayload(payload, { provider: "dashscope" });
    expect(result).not.toHaveProperty("tools");
  });

  it("剥离不兼容 provider 的 thinking 字段", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, { provider: "kimi-coding" });
    expect(result).not.toHaveProperty("thinking");
  });

  it("anthropic 模型保留 thinking", () => {
    const payload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, { provider: "anthropic" });
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("无 model 信息时保留 thinking 不误删", () => {
    const payload = {
      model: "unknown",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const result = normalizeProviderPayload(payload, null);
    expect(result.thinking).toEqual({ type: "enabled" });
  });
});

describe("normalizeProviderPayload — DeepSeek chat 模式", () => {
  const deepseekModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    reasoning: true,
    maxTokens: 384000,
  };

  it("非 DeepSeek 模型不动 DeepSeek 专用字段", () => {
    const payload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, { provider: "openai", reasoning: true }, { mode: "chat" });
    expect(result.reasoning_effort).toBe("medium");
    expect(result.max_completion_tokens).toBe(32000);
  });

  it("DeepSeek 无工具思考请求使用官方 max_tokens，并抬过 high thinking budget", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, { mode: "chat" });
    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning_effort: "high",
      max_tokens: 65536,
    });
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(payload).toHaveProperty("max_completion_tokens", 32000);
  });

  it("DeepSeek V4 xhigh 会按官方兼容规则转成 max", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 131072,
    });
  });

  it("DeepSeek V4 off 会显式关闭官方思考模式", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "off",
    });
    expect(result).toMatchObject({ thinking: { type: "disabled" } });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_tokens).toBe(32000);
  });

  it("DeepSeek 已经足够大的 max_tokens 不被放大", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      max_tokens: 50000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, { mode: "chat" });
    expect(result.max_tokens).toBe(50000);
  });

  it("DeepSeek V4 工具请求保留官方思考协议和 reasoning_content", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "look up date" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Need to call the date tool.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "2026-04-24" },
      ],
      tools: [{ type: "function", function: { name: "date", parameters: { type: "object" } } }],
      reasoning_effort: "medium",
      max_completion_tokens: 32000,
    };
    const result = normalizeProviderPayload(payload, deepseekModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 131072,
    });
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result.messages[1]).toHaveProperty("reasoning_content", "Need to call the date tool.");
    expect(payload.messages[1]).toHaveProperty("reasoning_content");
  });

  it("DeepSeek v4 即使缺少本地 reasoning 标记，也按默认思考模式防护", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "look up date" }],
      tools: [{ type: "function", function: { name: "date", parameters: { type: "object" } } }],
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
    }, { mode: "chat" });
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      max_tokens: 65536,
    });
  });
});

describe("normalizeProviderPayload — DeepSeek utility 模式", () => {
  const deepseekV4 = {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    reasoning: true,
    maxTokens: 384000,
  };

  it("utility 模式下 DeepSeek reasoning 模型主动 disableThinking（避免短输出耗光思考预算）", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    };
    const result = normalizeProviderPayload(payload, deepseekV4, { mode: "utility" });
    expect(result).toMatchObject({ thinking: { type: "disabled" } });
    // utility 不放大 max_tokens：保留调用方传入的 50
    expect(result.max_tokens).toBe(50);
  });

  it("utility 模式下普通 DeepSeek 非 reasoning 模型不被改", () => {
    const payload = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-chat",
      provider: "deepseek",
      reasoning: false,
    }, { mode: "utility", reasoningLevel: "high" });
    expect(result).not.toHaveProperty("thinking");
    expect(result.max_tokens).toBe(100);
  });

  it("utility 模式默认就是 utility，不传 mode 时按 chat 处理", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    };
    // 默认 mode = "chat"，会拉 max_tokens
    const result = normalizeProviderPayload(payload, deepseekV4);
    expect(result.max_tokens).toBe(65536);
  });
});

describe("normalizeProviderPayload — 边界条件", () => {
  it("payload 非对象时原样返回", () => {
    expect(normalizeProviderPayload(null, { provider: "deepseek" })).toBe(null);
    expect(normalizeProviderPayload(undefined, { provider: "deepseek" })).toBe(undefined);
  });

  it("无 messages 字段的 DeepSeek payload 不抛错", () => {
    const payload = { model: "deepseek-v4-pro" };
    const result = normalizeProviderPayload(payload, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      reasoning: true,
    }, { mode: "chat" });
    // 没 messages 数组，DeepSeek 兼容层直接放过
    expect(result).toBe(payload);
  });
});
