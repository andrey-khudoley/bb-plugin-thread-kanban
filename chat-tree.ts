import { useEffect, useRef, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ancestorsOf, indexThreads } from "./board";

type SidebarThread = PluginSidebarThread;
export type ChatNode = Pick<SidebarThread,
  "id" | "projectId" | "parentThreadId" | "displayTitle" | "href" | "updatedAt" | "status" |
  "runtimeStatus" | "queuedWork" | "hasPendingInteraction" | "activity" | "isArchived" | "isHidden" | "isUnread" |
  "parentNotifications" | "pinnedAt" | "archivedAt" | "sectionId"
> & {
  environment: Pick<NonNullable<SidebarThread["environment"]>, "id" | "path"> | null;
  host?: { id: string } | null;
};
type Sdk = ReturnType<typeof useSdk>;
type ListThread = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

function node(row: ListThread): ChatNode {
  return {
    ...row,
    displayTitle: row.title || row.titleFallback || row.id,
    href: `/projects/${row.projectId}/threads/${row.id}`,
    runtimeStatus: row.runtime.displayStatus,
    isArchived: !!row.archivedAt,
    isHidden: row.visibility === "hidden",
    isUnread: row.latestAttentionAt > (row.lastReadAt ?? 0),
    host: row.environmentHostId ? { id: row.environmentHostId } : null,
    environment: row.environmentId ? { id: row.environmentId, path: row.environmentPath } : null,
    activity: {
      workflows: row.activity.activeWorkflowCount,
      backgroundAgents: row.activity.activeBackgroundAgentCount,
      backgroundCommands: row.activity.activeBackgroundCommandCount,
      planMode: row.activity.activePlanModeCount,
    },
  };
}

export function useChatTree(threadId: string, revision: string, archiveParents: Readonly<Record<string, string>>) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [state, setState] = useState<{
    threadId: string;
    nodes: ChatNode[];
    ancestorIds: string[];
    error: string;
  } | null>(null);
  useEffect(() => {
    const { threads } = sdkRef.current;
    const abort = new AbortController();
    const { signal } = abort;
    void (async () => {
      try {
        const [ancestors, descendants] = await Promise.all([
          (async () => {
            const found = new Set([threadId]);
            let root = threadId;
            for (;;) {
              const result = await threads.experimental_listAncestors({ threadIds: [root], signal });
              const ids = result.threads[0]?.ancestorIds ?? [];
              ids.forEach((id) => found.add(id));
              const parent = archiveParents[ids.at(-1) ?? root];
              if (!parent || found.has(parent)) return found;
              found.add(parent);
              root = parent;
            }
          })(),
          (async () => {
            const found = new Set([threadId]);
            const pending = [threadId];
            while (pending.length) {
              const result = await threads.experimental_listDescendants({
                threadIds: pending.splice(0, 200), includeArchived: true, includeHidden: true, signal,
              });
              result.threads.forEach(({ descendantIds }) => descendantIds.forEach((id) => found.add(id)));
              for (const [child, parent] of Object.entries(archiveParents)) {
                if (!found.has(parent) || found.has(child)) continue;
                found.add(child);
                pending.push(child);
              }
            }
            return found;
          })(),
        ]);
        const branchIds = [...new Set([...ancestors, ...descendants])];
        const requests = [];
        for (let index = 0; index < branchIds.length; index += 200) {
          const args = { threadIds: branchIds.slice(index, index + 200), includeHidden: true, limit: 200, signal };
          requests.push(threads.list({ ...args, archived: false }), threads.list({ ...args, archived: true }));
        }
        const records = (await Promise.all(requests)).flat();
        const nodes = [...new Map(records.map((row) => [row.id, node(row)])).values()].map((row) => ({
          ...row, parentThreadId: row.parentThreadId ?? archiveParents[row.id] ?? null,
        }));
        const index = indexThreads(nodes);
        const root = index.byId.get(threadId);
        const ancestorIds = root ? ancestorsOf(root, index).map(({ id }) => id) : [];
        if (!signal.aborted) setState({ threadId, nodes, ancestorIds, error: "" });
      } catch (cause) {
        if (!signal.aborted) setState({ threadId, nodes: [], ancestorIds: [], error: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
    return () => abort.abort();
  }, [threadId, revision, archiveParents]);
  return state?.threadId === threadId ? state : null;
}
