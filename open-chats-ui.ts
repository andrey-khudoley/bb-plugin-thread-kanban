import { useEffect, useSyncExternalStore } from "react";
import { experimental_usePanelTabs, experimental_useTabVisible } from "@get-bb/plugin-sdk/app";
import { openChatStore as chats } from "./open-chats";
import { usePanelSection, useSectionVisible } from "./panel-section-ui";
import { contextThreadId, sectionStore } from "./panel-context";
import { tabContext } from "./panel-context-actions";

/** BB keeps hidden tabs mounted; the shell bridge also tracks inactive card tabs. */
export function useVisibleChat(threadId: string, chatVisible: boolean) {
  const tabVisible = experimental_useTabVisible();
  const section = usePanelSection();
  const sectionVisible = useSectionVisible(section);
  const visible = sectionVisible || tabVisible;
  useEffect(() => {
    if (visible && chatVisible) return chats.open(threadId);
  }, [threadId, visible, chatVisible]);
}

export function useChatHighlight(threadIds: readonly string[], issueId?: string) {
  const opened = useSyncExternalStore(chats.subscribe, chats.getSnapshot, chats.getSnapshot);
  const panel = experimental_usePanelTabs();
  // A native tab can keep its key while its card, working chat or view changes.
  useSyncExternalStore(sectionStore.subscribe, sectionStore.getSnapshot, sectionStore.getSnapshot);
  const selected = panel.open ? panel.tabs.find((tab) => tab.key === panel.selectedKey) : undefined;
  const context = selected ? tabContext(selected) : null;
  const activeThreadId = contextThreadId(context);
  const chatActive = activeThreadId !== null && threadIds.includes(activeThreadId);
  // Card identity survives switching views and does not require a working chat.
  const cardActive = chatActive || (context?.kind === 'issue' && context.issueId === issueId);
  return { chatOpen: chatActive || threadIds.some((id) => opened.has(id)), chatActive, cardActive };
}
