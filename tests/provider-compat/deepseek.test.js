import { describe, expect, it } from "vitest";
import * as deepseek from "../../core/provider-compat/deepseek.js";

describe("provider-compat/deepseek 模块导出形态", () => {
  it("导出 matches 函数", () => {
    expect(typeof deepseek.matches).toBe("function");
  });

  it("导出 apply 函数", () => {
    expect(typeof deepseek.apply).toBe("function");
  });

  it("matches 对 null/undefined 返回 false（不抛错）", () => {
    expect(deepseek.matches(null)).toBe(false);
    expect(deepseek.matches(undefined)).toBe(false);
    expect(deepseek.matches({})).toBe(false);
  });

  it("matches 识别 deepseek provider", () => {
    expect(deepseek.matches({ provider: "deepseek" })).toBe(true);
  });

  it("matches 识别官方 baseUrl", () => {
    expect(deepseek.matches({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
  });

  it("matches 不把 openrouter 上的 deepseek 视为 deepseek", () => {
    expect(deepseek.matches({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      id: "deepseek/deepseek-v3.2",
    })).toBe(false);
  });
});
