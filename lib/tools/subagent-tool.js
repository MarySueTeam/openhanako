/**
 * subagent-tool.js — Sub-agent 工具（非阻塞）
 *
 * 将独立子任务派给隔离的 agent session 执行。
 * 任务在后台运行，完成后通过 DeferredResultStore 持久化结果，
 * deferred-result-ext 以 steer 消息注入对话。
 * 调用方无需等待，可继续与用户对话。
 */

import { Type } from "@sinclair/typebox";
import { t, getLocale } from "../../server/i18n.js";

const SUBAGENT_CUSTOM_TOOLS = "*";
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

let activeCount = 0;
const MAX_CONCURRENT = 5;

function getSubagentPreamble() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return "你现在是一个调研子任务。要求：\n" +
      "- 不需要 MOOD 区块\n" +
      "- 不需要寒暄，直接给结论\n" +
      "- 输出简洁、结构化，附上关键证据和来源\n" +
      "- 如果信息不足，明确说明缺什么\n\n" +
      "任务：\n";
  }
  return "You are a research sub-task. Requirements:\n" +
    "- No MOOD block\n" +
    "- No pleasantries — go straight to conclusions\n" +
    "- Output should be concise, structured, with key evidence and sources\n" +
    "- If information is insufficient, state clearly what is missing\n\n" +
    "Task:\n";
}

/**
 * @param {object} deps
 * @param {(prompt: string, opts: object) => Promise} deps.executeIsolated
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {string[]} deps.readOnlyBuiltinTools
 * @param {() => import("../deferred-result-store.js").DeferredResultStore|null} deps.getDeferredStore
 * @param {() => string|null} deps.getSessionPath
 */
export function createSubagentTool(deps) {
  return {
    name: "subagent",
    label: t("toolDef.subagent.label"),
    description: t("toolDef.subagent.description"),
    parameters: Type.Object({
      task: Type.String({ description: t("toolDef.subagent.taskDesc") }),
      model: Type.Optional(Type.String({ description: t("toolDef.subagent.modelDesc") })),
    }),

    execute: async (_toolCallId, params) => {
      if (activeCount >= MAX_CONCURRENT) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_CONCURRENT }) }],
        };
      }

      const store = deps.getDeferredStore?.();
      const sessionPath = deps.getSessionPath?.();

      if (!store || !sessionPath) {
        // deferred 基础设施不可用时同步 fallback
        return _syncFallback(deps, params);
      }

      const taskId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskSummary = params.task.length > 80
        ? params.task.slice(0, 80) + "…"
        : params.task;

      store.defer(taskId, sessionPath, { type: "subagent", summary: taskSummary });

      activeCount++;
      const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);

      // 后台执行，不 await
      deps.executeIsolated(
        getSubagentPreamble() + params.task,
        {
          model: params.model || deps.resolveUtilityModel(),
          toolFilter: SUBAGENT_CUSTOM_TOOLS,
          builtinFilter: deps.readOnlyBuiltinTools,
          signal: timeoutSignal,
        },
      ).then(result => {
        if (result.error) {
          store.fail(taskId, result.error);
        } else {
          store.resolve(taskId, result.replyText || t("error.subagentNoOutput"));
        }
      }).catch(err => {
        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
        store.fail(taskId, isTimeout
          ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })
          : err.message || String(err));
      }).finally(() => {
        activeCount--;
      });

      return {
        content: [{ type: "text", text: t("error.subagentDispatched", { taskId }) }],
      };
    },
  };
}

/** deferred 不可用时的同步 fallback */
async function _syncFallback(deps, params) {
  const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
  activeCount++;
  try {
    const result = await deps.executeIsolated(
      getSubagentPreamble() + params.task,
      {
        model: params.model || deps.resolveUtilityModel(),
        toolFilter: SUBAGENT_CUSTOM_TOOLS,
        builtinFilter: deps.readOnlyBuiltinTools,
        signal: timeoutSignal,
      },
    );
    if (result.error) {
      return { content: [{ type: "text", text: t("error.subagentFailed", { msg: result.error }) }] };
    }
    return { content: [{ type: "text", text: result.replyText || t("error.subagentNoOutput") }] };
  } catch (err) {
    return { content: [{ type: "text", text: t("error.subagentFailed", { msg: err.message }) }] };
  } finally {
    activeCount--;
  }
}
