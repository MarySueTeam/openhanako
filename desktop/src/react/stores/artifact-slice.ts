import type { Artifact } from '../types';

// ── Slice ──

export interface ArtifactSlice {
  /** 全局 artifact 池（user-level），所有 session 共享 */
  artifacts: Artifact[];
  /** 当前打开的 tab id 列表（user-level） */
  openTabs: string[];
  /** 当前激活的 tab id */
  activeTabId: string | null;
  /** 编辑器是否已 detach 到独立窗口 */
  editorDetached: boolean;
  setEditorDetached: (detached: boolean) => void;
}

export const createArtifactSlice = (
  set: (partial: Partial<ArtifactSlice> | ((s: ArtifactSlice) => Partial<ArtifactSlice>)) => void
): ArtifactSlice => ({
  artifacts: [],
  openTabs: [],
  activeTabId: null,
  editorDetached: false,
  setEditorDetached: (detached) => set({ editorDetached: detached }),
});

// ── Selectors ──

export const selectArtifacts = (s: ArtifactSlice): Artifact[] => s.artifacts;
export const selectOpenTabs = (s: ArtifactSlice): string[] => s.openTabs;
export const selectActiveTabId = (s: ArtifactSlice): string | null => s.activeTabId;
export const selectEditorDetached = (s: ArtifactSlice): boolean => s.editorDetached;
