import { describe, expect, it, vi } from "vitest";
import { createSubagentTool } from "../lib/tools/subagent-tool.js";

describe("subagent-tool (async deferred)", () => {
  it("dispatches task via deferred store and returns immediately", async () => {
    const executeIsolated = vi.fn().mockResolvedValue({
      replyText: "done",
      error: null,
    });

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read", "grep", "find", "ls"],
      getDeferredStore: () => mockStore,
      getSessionPath: () => "/test/session.jsonl",
    });

    const result = await tool.execute("call_1", { task: "查一下项目状态" });

    // 立即返回 dispatched 消息
    expect(result.content[0].text).toContain("subagentDispatched");

    // store.defer 应该被调用
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent" }),
    );

    // executeIsolated 应该被调用（后台执行）
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.stringContaining("查一下项目状态"),
      expect.objectContaining({
        model: "utility-model",
        toolFilter: "*",
        builtinFilter: ["read", "grep", "find", "ls"],
      }),
    );

    // 等 promise 链走完
    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
  });

  it("calls store.fail when execution errors", async () => {
    const executeIsolated = vi.fn().mockRejectedValue(new Error("boom"));

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read"],
      getDeferredStore: () => mockStore,
      getSessionPath: () => "/test/session.jsonl",
    });

    await tool.execute("call_1", { task: "会失败的任务" });

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
  });

  it("falls back to sync execution when deferred store is unavailable", async () => {
    const executeIsolated = vi.fn().mockResolvedValue({
      replyText: "sync result",
      error: null,
    });

    const tool = createSubagentTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read"],
      getDeferredStore: () => null,
      getSessionPath: () => null,
    });

    const result = await tool.execute("call_1", { task: "同步任务" });

    expect(result).toEqual({
      content: [{ type: "text", text: "sync result" }],
    });
  });

  it("rejects new work when the concurrency limit (5) is reached", async () => {
    const releases = [];
    const executeIsolated = vi.fn().mockImplementation(() => new Promise((resolve) => {
      releases.push(resolve);
    }));

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      executeIsolated,
      resolveUtilityModel: () => "utility-model",
      readOnlyBuiltinTools: ["read"],
      getDeferredStore: () => mockStore,
      getSessionPath: () => "/test/session.jsonl",
    });

    // 启动 5 个（非阻塞，立即返回）
    const running = [];
    for (let i = 0; i < 5; i++) {
      running.push(tool.execute(`call_${i}`, { task: `任务 ${i}` }));
    }
    await Promise.all(running);

    // 第 6 个被拒
    const blocked = await tool.execute("call_5", { task: "任务 5" });
    expect(blocked.content[0].text).toContain("subagentMaxConcurrent");

    // 释放
    for (const release of releases) {
      release({ replyText: "ok", error: null });
    }
    expect(executeIsolated).toHaveBeenCalledTimes(5);
  });
});
