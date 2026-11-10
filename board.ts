import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export const columns = [
  { id: "new", label: "Бэклог", color: "text-muted-foreground", dot: "bg-muted-foreground" },
  { id: "working", label: "Работает", color: "text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
  { id: "waiting", label: "Ожидает ввод", color: "text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  { id: "done", label: "Завершён", color: "text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
] as const;

export type Stage = (typeof columns)[number]["id"];

type StageThread = Pick<PluginSidebarThread, "isArchived" | "hasPendingInteraction" | "runtimeStatus" | "queuedWork" | "activity" | "status">;
type IndexedThread = Pick<PluginSidebarThread, "id" | "parentThreadId" | "updatedAt">;

export function stageOf(thread: StageThread): Stage {
  if (thread.isArchived) return "done";
  if (thread.hasPendingInteraction) return "waiting";
  if (
    ["active", "starting", "stopping", "provisioning", "waiting-for-host"].includes(thread.runtimeStatus) ||
    thread.queuedWork === "waiting" ||
    Object.values(thread.activity).some((count) => count > 0)
  ) return "working";
  return thread.status === "pending" ? "new" : "done";
}

export function indexThreads<T extends IndexedThread>(threads: readonly T[]) {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((thread) => [thread.id, thread]));
  const children = new Map<string, T[]>();

  for (const thread of sorted) {
    if (!thread.parentThreadId) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    children.set(thread.parentThreadId, siblings);
  }

  return { sorted, byId, children };
}

export type ThreadIndex<T extends IndexedThread = PluginSidebarThread> = ReturnType<typeof indexThreads<T>>;

export function ancestorsOf<T extends IndexedThread>(thread: T, index: ThreadIndex<T>) {
  const ancestors: T[] = [];
  const seen = new Set([thread.id]);
  let parentId = thread.parentThreadId;
  while (parentId && !seen.has(parentId)) {
    const parent = index.byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent);
    seen.add(parentId);
    parentId = parent.parentThreadId;
  }
  return ancestors.reverse();
}

export function descendantIds<T extends IndexedThread>(threadId: string, index: ThreadIndex<T>) {
  const seen = new Set([threadId]);
  const pending = [threadId];
  while (pending.length) {
    const parentId = pending.pop()!;
    for (const child of index.children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      pending.push(child.id);
    }
  }
  seen.delete(threadId);
  return seen;
}
