import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies session memory before creating the agent session", async () => {
    let sessionMemoryEnabled = true;
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      buildSystemPrompt: () => sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
    };

    const resourceLoader = {
      getSystemPrompt: () => (sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF"),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("fresh session freezes the effective memory state into meta for cache safety", async () => {
    const sessionFile = path.join(tempDir, "frozen-memory.jsonl");
    let sessionMemoryEnabled = true;
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      memoryMasterEnabled: false,
      get sessionMemoryEnabled() { return sessionMemoryEnabled; },
      get memoryEnabled() { return this.memoryMasterEnabled && sessionMemoryEnabled; },
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      getToolsSnapshot: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? [{ name: "search_memory" }] : [{ name: "todo_write" }],
      ),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
      ),
      config: { tools: {} },
      tools: [{ name: "todo_write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "test-model", provider: "test" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "test-model", provider: "test", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
    const meta = JSON.parse(fs.readFileSync(path.join(tempDir, "hana", "sessions", "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].memoryEnabled).toBe(false);
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: { id: "default-model", provider: "test" } } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("subagent task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("executeIsolated builds non-session tools from the master memory switch, not the focused session switch", async () => {
    const sessionFile = path.join(tempDir, "isolated-master-tools.jsonl");
    const builtinTool = { name: "read" };
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    const getToolsSnapshot = vi.fn(({ forceMemoryEnabled } = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [builtinTool],
      customTools,
    }));
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: false,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "MEMORY MASTER PROMPT",
      tools: [plainTool],
      getToolsSnapshot,
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check");

    expect(getToolsSnapshot).toHaveBeenCalledWith({ forceMemoryEnabled: true });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("switchSession 拒绝 subagent-sessions/activity/.ephemeral 等旁路路径", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({ sessionDir: "/tmp/agents/hana/sessions" }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await expect(
      coordinator.switchSession("/tmp/agents/hana/subagent-sessions/child.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/activity/tick.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/.ephemeral/iso.jsonl"),
    ).rejects.toThrow(/path must be in/);
  });

  it("listSessions 不给旁路路径（subagent-sessions 等）伪造占位条目", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "hana", "sessions"),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
    });

    // 模拟焦点被污染到 subagent-sessions 下
    const subagentPath = path.join(tempDir, "hana", "subagent-sessions", "child.jsonl");
    coordinator._session = {
      sessionManager: {
        getSessionFile: () => subagentPath,
        getCwd: () => "/tmp/home",
      },
    };
    coordinator._sessionStarted = true;

    const sessions = await coordinator.listSessions();
    expect(sessions.find((s) => s.path === subagentPath)).toBeUndefined();
  });
});
