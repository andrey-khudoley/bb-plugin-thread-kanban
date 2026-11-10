import type { ExperimentalPanelController } from '@get-bb/plugin-sdk/app';
import { focusSection, sectionId, tabContext } from './panel-context-actions';

const panels = new Map<HTMLElement, ExperimentalPanelController>();
export function registerStatusPanel(root: HTMLElement, panel: ExperimentalPanelController) {
  panels.set(root, panel);
  return () => { panels.delete(root); };
}

/** A status-list selection always focuses an existing card, including from a blank/new tab. */
export function focusStatusChat(threadId: string) {
  for (const [root, panel] of panels) {
    if (!root.isConnected) continue;
    const snapshot = panel.getTabs();
    const candidates = snapshot.tabs.filter(tab => {
      const context = tabContext(tab);
      return context?.threadId === threadId;
    }).sort((a, b) => Number(b.key === snapshot.selectedKey) - Number(a.key === snapshot.selectedKey));
    for (const tab of candidates) if (panel.selectTab(tab.key)) {
      const id = sectionId(tab); if (id) focusSection(id);
      return true;
    }
  }
  return false;
}
