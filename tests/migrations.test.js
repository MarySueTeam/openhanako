/**
 * core/migrations.js 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { runMigrations } from "../core/migrations.js";

// ── 测试工具 ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrations-"));
}

/** 最小化 PreferencesManager stub */
function makePrefs(userDir) {
  const p = path.join(userDir, "preferences.json");
  fs.mkdirSync(userDir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "{}", "utf-8");
  return {
    getPreferences() { return JSON.parse(fs.readFileSync(p, "utf-8")); },
    savePreferences(data) {
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
    },
  };
}

/** 最小化 ProviderRegistry stub — 只需 get() 返回是否存在 */
function makeRegistry(existingProviders) {
  const set = new Set(existingProviders);
  return { get(id) { return set.has(id) ? { id } : null; } };
}

function writeAgentConfig(agentsDir, agentId, config) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
    "utf-8",
  );
}

function readAgentConfig(agentsDir, agentId) {
  return YAML.load(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8"));
}

// ── runner 行为 ──────────────────────────────────────────────────────────────

describe("runMigrations runner", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("首次运行：_dataVersion 从 0 升到最新", () => {
    const prefs = makePrefs(userDir);
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    expect(prefs.getPreferences()._dataVersion).toBeGreaterThan(0);
  });

  it("已迁移过：不重复执行", () => {
    const prefs = makePrefs(userDir);
    // 设置一个很大的 _dataVersion，所有迁移都应跳过
    prefs.savePreferences({ _dataVersion: 9999 });

    writeAgentConfig(agentsDir, "hana", { api: { provider: "ghost-provider" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    // config 不应被修改（ghost-provider 应原样保留）
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("ghost-provider");
  });
});

// ── 迁移 #1：清理悬空 provider 引用 ─────────────────────────────────────────

describe("migration #1: cleanDanglingProviderRefs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("清空指向不存在 provider 的 api.provider", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "dead-provider" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("");
  });

  it("保留指向存在 provider 的引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "openai" },
      models: { chat: "openai/gpt-4o" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("openai");
    expect(config.models.chat).toBe("openai/gpt-4o");
  });

  it("清空 models.chat 中 provider/model 格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "minimax-token_plan/minimax-large", utility: "openai/gpt-4o-mini" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
    expect(config.models.utility).toBe("openai/gpt-4o-mini");
  });

  it("清空 models.chat 中 {id, provider} 对象格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: { id: "some-model", provider: "dead-provider" } },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
  });

  it("清空 embedding_api.provider 的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      embedding_api: { provider: "dead" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.embedding_api.provider).toBe("");
  });

  it("清空 preferences 中悬空的共享模型引用", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_large_model: { id: "some-model", provider: "dead" },
      utility_api_provider: "also-dead",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.utility_large_model).toBeNull();
    expect(p.utility_api_provider).toBeNull();
  });

  it("preferences 中字符串格式的悬空共享模型也被清空", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      summarizer_model: "dead-provider/fast-model",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.summarizer_model).toBeNull();
  });

  it("多个 agent 同时修复", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "dead" } });
    writeAgentConfig(agentsDir, "butter", { api: { provider: "openai" } });
    writeAgentConfig(agentsDir, "xiaohua", {
      api: { provider: "dead" },
      models: { chat: "dead/model" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    expect(readAgentConfig(agentsDir, "hana").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "butter").api.provider).toBe("openai");
    expect(readAgentConfig(agentsDir, "xiaohua").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "xiaohua").models.chat).toBe("");
  });
});
