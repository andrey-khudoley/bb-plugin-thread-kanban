import type { ExperimentalPanelController } from '@get-bb/plugin-sdk/app';
import { focusSection, focusedSection, openPanelContext, sectionId, tabContext } from './panel-context-actions';
import { contextKey, sectionStore, type PanelContext } from './panel-context';
import { artifactOwner, artifactStore } from './panel-artifacts';
import type { Issue } from './issues';
import { setPanelState } from './panel-view-state';

type StatusIssue = Pick<Issue, 'id' | 'title' | 'threadIds'>;
const panels = new Map<HTMLElement, { panel: ExperimentalPanelController; issues: readonly StatusIssue[] }>();
export function registerStatusPanel(root: HTMLElement, panel: ExperimentalPanelController, issues: readonly StatusIssue[] = []) {
  panels.set(root, { panel, issues });
  return () => { panels.delete(root); };
}

function visible(root: HTMLElement) {
  if (!root.isConnected || root.closest('[hidden], [aria-hidden="true"]') || !root.getClientRects().length) return false;
  const rect = root.getBoundingClientRect(), win = root.ownerDocument.defaultView;
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
    rect.top < (win?.innerHeight ?? 0) && rect.left < (win?.innerWidth ?? 0);
}

/** Only the displayed board owns notification navigation; mounted background boards must decline. */
function openStatusCard(target: { threadId: string; title: string } | { issueId: string }) {
  for (const [root, { panel, issues }] of panels) {
    if (!visible(root)) continue;
    const threadId = 'threadId' in target ? target.threadId : null;
    const issue = issues.find(item => 'issueId' in target ? item.id === target.issueId : item.threadIds.includes(target.threadId));
    const snapshot = panel.getTabs();
    const candidates = snapshot.tabs.filter(tab => {
      const context = tabContext(tab);
      if ('issueId' in target) return context?.kind === 'issue' && context.issueId === target.issueId;
      return issue ? context?.kind === 'issue' && context.issueId === issue.id : context?.threadId === threadId;
    }).sort((a, b) => Number(b.key === snapshot.selectedKey) - Number(a.key === snapshot.selectedKey));
    for (const tab of candidates) if (panel.selectTab(tab.key)) {
      const id = sectionId(tab), context = tabContext(tab);
      if (id && context) {
        focusSection(id);
        // A result/question must reveal its exact chat, even if this card showed files or another linked chat.
        if (threadId) {
          if (context.kind === 'chat') setPanelState(id, `${threadId}:workspace-view`, 'chat');
          sectionStore.replace(id, { ...context, threadId, view: 'chat',
            ...(context.kind === 'issue' ? { request: Math.max(Date.now(), context.request + 1) } : {}) });
        }
        artifactStore.select(artifactOwner(id, contextKey(context)), null);
      }
      return true;
    }
    if (candidates.length) return false;
    const issueId = issue?.id ?? ('issueId' in target ? target.issueId : null);
    const context: PanelContext = issueId
      ? { kind: 'issue', issueId,
        title: issue?.title || 'Новая задача', threadId: threadId ?? issue?.threadIds.at(-1) ?? null,
        startWithAssistant: false, request: Date.now(), ...(threadId ? { view: 'chat' as const } : {}) }
      : { kind: 'chat', threadId: threadId!, title: 'title' in target ? target.title : 'Чат', view: 'chat' };
    const opened = openPanelContext(panel, context);
    if (opened && focusedSection) {
      if (context.kind === 'chat') setPanelState(focusedSection, `${context.threadId}:workspace-view`, 'chat');
      artifactStore.select(artifactOwner(focusedSection, contextKey(context)), null);
    }
    return opened;
  }
  return false;
}

export function focusStatusChat(threadId: string, title = 'Чат') { return openStatusCard({ threadId, title }); }
export function focusStatusIssue(issueId: string) { return openStatusCard({ issueId }); }
