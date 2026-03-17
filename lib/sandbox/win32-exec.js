/**
 * win32-exec.js — Windows 平台的 bash 执行函数
 *
 * Windows 没有 OS 级沙盒（seatbelt/bwrap），bash 走 Pi SDK 默认实现。
 * 但默认实现的 detached: true 在 Windows 上会设 DETACHED_PROCESS 标志，
 * 导致 MSYS2/Git Bash 的 stdout/stderr pipe 可能收不到数据。
 *
 * 这个模块提供替代的 exec 函数，使用 spawnAndStream（已去掉 Windows detached）。
 * 返回值契约匹配 Pi SDK BashOperations.exec。
 */

import { getShellConfig, getShellEnv } from "@mariozechner/pi-coding-agent/dist/utils/shell.js";
import { spawnAndStream } from "./exec-helper.js";

/**
 * 创建 Windows 平台的 bash exec 函数
 * @returns {(command: string, cwd: string, opts: object) => Promise<{exitCode: number|null}>}
 */
export function createWin32Exec() {
  return (command, cwd, { onData, signal, timeout, env }) => {
    const { shell, args } = getShellConfig();
    return spawnAndStream(shell, [...args, command], {
      cwd,
      env: env ?? getShellEnv(),
      onData,
      signal,
      timeout,
    });
  };
}
