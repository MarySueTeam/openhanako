/**
 * 数据迁移 runner
 *
 * 所有用户数据格式变更集中在此文件。
 * preferences.json._dataVersion 记录已执行到的版本号（整数），
 * 启动时只跑 > _dataVersion 的条目。
 *
 * 添加新迁移：在 migrations 对象末尾加一条，key 为递增整数。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { saveConfig } from "../lib/memory/config-loader.js";

// ── 迁移表 ──────────────────────────────────────────────────────────────────

const migrations = {
  // #356: 清理悬空 provider 引用（agent config + preferences）
  1: cleanDanglingProviderRefs,
  // bridge 配置从全局 preferences 迁移到各 agent 的 config.yaml
  2: migrateBridgeToPerAgent,
  // workspace (home_folder) 从全局 preferences 迁移到主 agent config.yaml
  3: migrateWorkspaceToPerAgent,
};

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {string}   ctx.hanakoHome
 * @param {string}   ctx.agentsDir
 * @param {import('./preferences-manager.js').PreferencesManager} ctx.prefs
 * @param {import('./provider-registry.js').ProviderRegistry}     ctx.providerRegistry
 * @param {Function} ctx.log
 */
export function runMigrations(ctx) {
  const { prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const currentVersion = preferences._dataVersion || 0;

  const pending = Object.keys(migrations)
    .map(Number)
    .filter(v => v > currentVersion)
    .sort((a, b) => a - b);

  if (!pending.length) return;

  log(`[migrations] _dataVersion=${currentVersion}，待执行 ${pending.length} 条迁移`);

  for (const v of pending) {
    try {
      migrations[v](ctx);
      log(`[migrations] #${v} 完成`);
    } catch (err) {
      console.error(`[migrations] #${v} 失败: ${err.message}`);
      // 失败则停在当前版本，不继续后续迁移
      break;
    }
    // 每跑完一条就持久化版本号，防止中途崩溃导致重跑已成功的迁移
    const fresh = prefs.getPreferences();
    fresh._dataVersion = v;
    prefs.savePreferences(fresh);
  }
}

// ── 迁移实现 ─────────────────────────────────────────────────────────────────

/**
 * #1 — 清理悬空 provider 引用
 *
 * 用户删除 provider 后，agent config.yaml 和 preferences.json 中
 * 可能残留指向已不存在 provider 的引用，导致启动时模型解析失败。
 * 本迁移扫描所有引用位置，将悬空引用清空。
 */
function cleanDanglingProviderRefs(ctx) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  const providerExists = (id) => !!providerRegistry.get(id);

  // ── 1. Agent config.yaml ──

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return; }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;

    let changed = false;

    // api.provider / embedding_api.provider / utility_api.provider
    for (const block of ["api", "embedding_api", "utility_api"]) {
      const provider = config[block]?.provider;
      if (provider && !providerExists(provider)) {
        config[block].provider = "";
        changed = true;
        log(`[migrations] ${dir.name}: ${block}.provider "${provider}" 不存在，已清空`);
      }
    }

    // models.* — 字符串 "provider/model" 或 { id, provider } 对象
    if (config.models) {
      for (const role of ["chat", "utility", "utility_large", "summarizer", "compiler", "embedding"]) {
        const ref = config.models[role];
        if (!ref) continue;

        if (typeof ref === "object" && ref.provider && !providerExists(ref.provider)) {
          config.models[role] = "";
          changed = true;
          log(`[migrations] ${dir.name}: models.${role}.provider "${ref.provider}" 不存在，已清空`);
        } else if (typeof ref === "string" && ref.includes("/")) {
          const provider = ref.slice(0, ref.indexOf("/"));
          if (!providerExists(provider)) {
            config.models[role] = "";
            changed = true;
            log(`[migrations] ${dir.name}: models.${role} "${ref}" provider 不存在，已清空`);
          }
        }
      }
    }

    if (changed) {
      const tmp = cfgPath + ".tmp";
      fs.writeFileSync(tmp, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
      fs.renameSync(tmp, cfgPath);
    }
  }

  // ── 2. Preferences ──

  const preferences = prefs.getPreferences();
  let prefsChanged = false;

  // 共享模型字段：utility_model, utility_large_model, summarizer_model, compiler_model
  for (const key of ["utility_model", "utility_large_model", "summarizer_model", "compiler_model"]) {
    const val = preferences[key];
    if (!val) continue;

    if (typeof val === "object" && val.provider && !providerExists(val.provider)) {
      preferences[key] = null;
      prefsChanged = true;
      log(`[migrations] preferences.${key}.provider "${val.provider}" 不存在，已清空`);
    } else if (typeof val === "string" && val.includes("/")) {
      const provider = val.slice(0, val.indexOf("/"));
      if (!providerExists(provider)) {
        preferences[key] = null;
        prefsChanged = true;
        log(`[migrations] preferences.${key} "${val}" provider 不存在，已清空`);
      }
    }
  }

  // utility_api_provider
  if (preferences.utility_api_provider && !providerExists(preferences.utility_api_provider)) {
    log(`[migrations] preferences.utility_api_provider "${preferences.utility_api_provider}" 不存在，已清空`);
    preferences.utility_api_provider = null;
    prefsChanged = true;
  }

  if (prefsChanged) {
    prefs.savePreferences(preferences);
  }
}

/**
 * #2 — bridge 配置从全局 preferences 迁移到 per-agent config.yaml
 *
 * preferences.json 中的 bridge.telegram / feishu / qq / wechat / whatsapp
 * 各自可能带 agentId 字段指定归属 agent。迁移后每个 platform config
 * 写入对应 agent 的 config.yaml，owner 信息一并合入，
 * readOnly 只写入 primaryAgent。迁移完成后删除 prefs.bridge。
 */
function migrateBridgeToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const bridge = preferences.bridge;
  if (!bridge) return; // nothing to migrate

  const primaryAgentId = preferences.primaryAgent || null;
  const ownerDict = bridge.owner || {};
  const readOnly = !!bridge.readOnly;

  const PLATFORMS = ["telegram", "feishu", "qq", "wechat", "whatsapp"];
  const agentConfigs = new Map(); // agentId → { platform: config }

  // Find fallback agent: primary if it exists, otherwise first available
  let fallbackAgentId = null;
  if (primaryAgentId) {
    const primaryDir = path.join(agentsDir, primaryAgentId);
    if (fs.existsSync(path.join(primaryDir, "config.yaml"))) {
      fallbackAgentId = primaryAgentId;
    } else {
      log(`[migrations] primaryAgent "${primaryAgentId}" dir/config.yaml not found, scanning for fallback`);
    }
  }
  if (!fallbackAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          fallbackAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  for (const platform of PLATFORMS) {
    const cfg = bridge[platform];
    if (!cfg) continue;

    // Determine target agent
    let targetAgentId = cfg.agentId || null;
    if (targetAgentId) {
      const agentCfg = path.join(agentsDir, targetAgentId, "config.yaml");
      if (!fs.existsSync(agentCfg)) {
        log(`[migrations] bridge.${platform}.agentId "${targetAgentId}" not found, using fallback`);
        targetAgentId = null;
      }
    }
    if (!targetAgentId) targetAgentId = fallbackAgentId;
    if (!targetAgentId) {
      log(`[migrations] no agent available for bridge.${platform}, skipping`);
      continue;
    }

    if (!agentConfigs.has(targetAgentId)) agentConfigs.set(targetAgentId, {});
    const ac = agentConfigs.get(targetAgentId);

    // Clean config: strip agentId field (now implicit by location)
    const cleanCfg = { ...cfg };
    delete cleanCfg.agentId;

    // Resolve owner: composite key "platform:agentId" > legacy "platform"
    const compositeKey = `${platform}:${targetAgentId}`;
    const owner = ownerDict[compositeKey] || ownerDict[platform] || null;
    if (owner) cleanCfg.owner = owner;

    ac[platform] = cleanCfg;
  }

  // Write to each agent's config.yaml
  for (const [agentId, bridgeConfig] of agentConfigs) {
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) {
      log(`[migrations] agent ${agentId} config.yaml not found, skipping`);
      continue;
    }
    // readOnly only goes to primary agent
    const bridgeBlock = agentId === primaryAgentId
      ? { ...bridgeConfig, readOnly }
      : { ...bridgeConfig };
    saveConfig(cfgPath, { bridge: bridgeBlock });
    log(`[migrations] migrated bridge config → agent ${agentId} (${Object.keys(bridgeConfig).join(", ")})`);
  }

  // Delete bridge from global preferences
  delete preferences.bridge;
  prefs.savePreferences(preferences);
  log(`[migrations] deleted prefs.bridge`);
}

/**
 * #3 — workspace (home_folder) 从全局 preferences 迁移到主 agent config.yaml
 *
 * preferences.json 中 home_folder 是顶层字段（不在 desk. 下）。
 * 迁移后写入主 agent 的 config.yaml 的 desk.home_folder，
 * 其他 agent 运行时通过 fallback 链继承主 agent 的值。
 */
function migrateWorkspaceToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const homeFolder = preferences.home_folder;

  if (!homeFolder) {
    log("[migrations] #3: no home_folder in preferences, skipping");
    return;
  }

  // Find primary agent
  const primaryAgentId = preferences.primaryAgent || null;
  let targetAgentId = null;

  if (primaryAgentId) {
    const cfgPath = path.join(agentsDir, primaryAgentId, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      targetAgentId = primaryAgentId;
    } else {
      log(`[migrations] #3: primaryAgent "${primaryAgentId}" config.yaml not found, scanning`);
    }
  }

  if (!targetAgentId) {
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          targetAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  if (!targetAgentId) {
    throw new Error("no agent with config.yaml found, home_folder preserved in preferences");
  }

  // Write to agent config
  const cfgPath = path.join(agentsDir, targetAgentId, "config.yaml");
  saveConfig(cfgPath, { desk: { home_folder: homeFolder } });

  // Verify write
  const verify = safeReadYAMLSync(cfgPath, null, YAML);
  if (verify?.desk?.home_folder !== homeFolder) {
    throw new Error(`write verification failed for agent ${targetAgentId}, home_folder preserved in preferences`);
  }

  // Delete from preferences only after verified write
  delete preferences.home_folder;
  prefs.savePreferences(preferences);

  log(`[migrations] #3: migrated home_folder "${homeFolder}" → agent ${targetAgentId}`);
}
