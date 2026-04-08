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

// ── 迁移表 ──────────────────────────────────────────────────────────────────

const migrations = {
  // #356: 清理悬空 provider 引用（agent config + preferences）
  1: cleanDanglingProviderRefs,
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
