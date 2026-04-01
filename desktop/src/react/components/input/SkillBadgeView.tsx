import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import styles from './SkillBadgeView.module.css';

export function SkillBadgeView({ node, deleteNode }: NodeViewProps) {
  const name = node.attrs.name as string;

  return (
    <NodeViewWrapper as="span" className={styles.badge}>
      <svg className={styles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
        <path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z" />
      </svg>
      <span className={styles.name}>{name}</span>
      <button
        className={styles.remove}
        onClick={deleteNode}
        contentEditable={false}
        tabIndex={-1}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </NodeViewWrapper>
  );
}
