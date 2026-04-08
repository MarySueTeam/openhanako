import { describe, expect, it, vi } from "vitest";
import { createSubagentTool } from "../lib/tools/subagent-tool.js";

function makePrepareIsolatedSession(runResult) {
  return vi.fn().mockResolvedValue({
    sessionPath: "/test/child-session.jsonl",
    run: vi.fn().mockResolvedValue(runResult),
  });
}

describe("subagent-tool (async deferred)", () => {
  it("dispatches task via deferred store and returns immediately", async () => {
    const prepareIsolatedSession = makePrepareIsolatedSession({ replyText: "done", error: null });

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
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

    // prepareIsolatedSession 应该被调用
    expect(prepareIsolatedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        toolFilter: "*",
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
    const prepareIsolatedSession = vi.fn().mockResolvedValue({
      sessionPath: "/test/child-session.jsonl",
      run: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
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
    const prepareIsolatedSession = makePrepareIsolatedSession({ replyText: "sync result", error: null });

    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
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
    const prepareIsolatedSession = vi.fn().mockImplementation(() => Promise.resolve({
      sessionPath: "/test/child-session.jsonl",
      run: () => new Promise((resolve) => {
        releases.push(resolve);
      }),
    }));

    const mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    };

    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
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
    expect(prepareIsolatedSession).toHaveBeenCalledTimes(5);
  });

  it("lists agents in discovery mode", async () => {
    const prepareIsolatedSession = vi.fn();
    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
      getDeferredStore: () => null,
      getSessionPath: () => null,
      listAgents: () => [
        { id: "agent-a", name: "Alpha", model: "gpt-4", summary: "数学专家" },
        { id: "agent-b", name: "Beta", model: "", summary: "" },
        { id: "self", name: "Self", model: "", summary: "" },
      ],
      currentAgentId: "self",
    });

    const result = await tool.execute("call_1", { task: "", agent: "?" });
    expect(result.content[0].text).toContain("agent-a");
    expect(result.content[0].text).toContain("Alpha");
    expect(result.content[0].text).not.toContain("self");
    expect(prepareIsolatedSession).not.toHaveBeenCalled();
  });
});
