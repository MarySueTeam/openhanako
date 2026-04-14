/**
 * DeskSkillsSection — 技能快捷区（可折叠列表 + toggle 开关）
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Desk.module.css';

const DESK_SKILLS_KEY = 'hana-desk-skills-collapsed';

export function DeskSkillsSection() {
  const skills = useStore(s => s.deskSkills);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkillsFn = useCallback(async () => {
    try {
      const agentId = useStore.getState().currentAgentId;
      if (!agentId) return; // currentAgentId 未就绪时跳过，避免错位
      const res = await hanaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const data = await res.json();
      if (data.error) return;
      const all = (data.skills || []) as Array<{
        name: string; enabled: boolean; hidden?: boolean;
        source?: string; externalLabel?: string | null; managedBy?: string | null;
      }>;
      useStore.getState().setDeskSkills(
        all.filter(s => !s.hidden).map(s => ({
          name: s.name,
          enabled: s.enabled,
          source: s.source,
          externalLabel: s.externalLabel,
          managedBy: s.managedBy,
        })),
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadDeskSkillsFn();
    window.__loadDeskSkills = loadDeskSkillsFn;
    return () => { delete window.__loadDeskSkills; };
  }, [loadDeskSkillsFn, currentAgentId, currentSessionPath]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const prev = useStore.getState().deskSkills;
    const agentId = useStore.getState().currentAgentId || '';
    if (!agentId) return;
    const target = prev.find(s => s.name === name);
    if (target?.managedBy === 'workspace') return;

    // 乐观更新
    useStore.getState().setDeskSkills(
      prev.map(s => s.name === name ? { ...s, enabled: enable } : s),
    );

    try {
      // 关键：重新拉取当前 agent 的最新 skill 列表，再在 fresh list 上派生 enabledList
      // 避免本地 store 是错位 agent 的状态导致把别人的列表写到当前 agent (#397)
      const freshRes = await hanaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const freshData = await freshRes.json();
      if (freshData.error) throw new Error(freshData.error);
      const freshSkills = (freshData.skills || []) as Array<{ name: string; enabled: boolean; managedBy?: string | null }>;
      const enabledList = freshSkills
        .map(s => s.name === name ? { ...s, enabled: enable } : s)
        .filter(s => s.enabled && s.managedBy !== 'workspace')
        .map(s => s.name);

      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      useStore.getState().setDeskSkills(prev);
    }
  }, []);

  const enabledCount = skills.filter(s => s.enabled).length;
  const t = window.t ?? ((p: string) => p);

  if (skills.length === 0) return null;

  return (
    <div className={s.skillsSection}>
      <button className={s.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.skills')}</span>
        <span className={s.skillsCount}>{enabledCount}</span>
        <svg
          className={`${s.skillsChevron}${collapsed ? '' : ` ${s.skillsChevronOpen}`}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className={s.skillsList}>
          {skills.map(sk => (
            <div className={s.skillItem} key={sk.name}>
              <span className={s.skillName}>{sk.name}</span>
              {sk.externalLabel && (
                <span className={s.skillSource}>{sk.externalLabel}</span>
              )}
              <button
                className={`hana-toggle mini${sk.enabled ? ' on' : ''}`}
                disabled={sk.managedBy === 'workspace'}
                onClick={() => toggleSkill(sk.name, !sk.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
