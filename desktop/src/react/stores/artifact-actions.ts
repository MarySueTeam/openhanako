/**
 * artifact-actions.ts — Artifact 预览管理
 *
 * 预览面板状态是 user-level flat state，跨所有 session 共享。
 * 切换 / 新建 / 切回 session 都不影响 artifacts / openTabs / activeTabId。
 */

import { useStore } from './index';
import type { StoreState } from './index';
import { updateLayout } from '../components/SidebarLayout';
import type { Artifact } from '../types';
import type { ArtifactSlice } from './artifact-slice';

/* eslint-disable @typescript-eslint/no-explicit-any -- IPC callback data */

let _artifactCounter = 0;

// ── Internal write primitive ──

function updatePreview(
  updater: (prev: Pick<ArtifactSlice, 'artifacts' | 'openTabs' | 'activeTabId'>) =>
    Partial<Pick<ArtifactSlice, 'artifacts' | 'openTabs' | 'activeTabId'>>,
): void {
  useStore.setState((s: StoreState) => {
    const prev = { artifacts: s.artifacts, openTabs: s.openTabs, activeTabId: s.activeTabId };
    return updater(prev);
  });
}

// ── Public primitives ──

/** upsert 一条 artifact 到全局池 */
export function upsertArtifact(artifact: Artifact): void {
  updatePreview(prev => {
    const arts = [...prev.artifacts];
    const idx = arts.findIndex(a => a.id === artifact.id);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    return { artifacts: arts };
  });
}

/** 打开 tab 并激活（已存在的 id 只切换激活） */
export function openTab(id: string): void {
  updatePreview(prev => {
    const tabs = prev.openTabs.includes(id) ? prev.openTabs : [...prev.openTabs, id];
    return { openTabs: tabs, activeTabId: id };
  });
}

/** 关闭 tab；若关闭的是 active，激活前一个 */
export function closeTab(id: string): void {
  updatePreview(prev => {
    const idx = prev.openTabs.indexOf(id);
    if (idx < 0) return {};
    const tabs = prev.openTabs.filter(t => t !== id);
    let active = prev.activeTabId;
    if (active === id) {
      active = tabs[Math.max(0, idx - 1)] ?? null;
    }
    return { openTabs: tabs, activeTabId: active };
  });
}

/** 切换激活 tab */
export function setActiveTab(id: string): void {
  updatePreview(() => ({ activeTabId: id }));
}

/** 清空整个预览池 */
export function clearPreview(): void {
  updatePreview(() => ({ artifacts: [], openTabs: [], activeTabId: null }));
}

// ── High-level actions ──

/** 注册 artifact 并打开为 tab，展开面板 */
export function openPreview(artifact: Artifact): void {
  upsertArtifact(artifact);
  openTab(artifact.id);
  useStore.getState().setPreviewOpen(true);
  updateLayout();
}

/** 收起面板，保留 tabs 和 artifacts（下次打开恢复） */
export function closePreview(): void {
  const s = useStore.getState();
  s.setPreviewOpen(false);
  if (s.quotedSelection) s.clearQuotedSelection();
  updateLayout();
}

/** 流式事件：AI 生成 artifact 进全局池（不再按 sessionPath 路由） */
export function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
  };
  upsertArtifact(artifact);
}

/** 注册编辑器 dock/detach 事件监听（App mount 时调用一次） */
export function initEditorEvents(): void {
  window.platform?.onEditorDockFile?.((data: any) => {
    const existing = useStore.getState().artifacts.find((a: Artifact) => a.filePath === data.filePath);
    if (existing) {
      openPreview(existing);
    } else {
      window.platform?.readFile(data.filePath).then((content: string | null) => {
        if (content == null) return;
        const artifact: Artifact = {
          id: `file-${data.filePath}`,
          type: data.type,
          title: data.title,
          content,
          filePath: data.filePath,
          language: data.language,
        };
        openPreview(artifact);
      });
    }
    useStore.getState().setEditorDetached(false);
  });

  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
    if (detached) {
      const s = useStore.getState();
      if (s.activeTabId) {
        closeTab(s.activeTabId);
        const after = useStore.getState();
        if (after.openTabs.length === 0) {
          closePreview();
        }
      }
    }
  });
}
