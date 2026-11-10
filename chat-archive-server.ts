import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { archiveChanged, archiveRpc, threadArchiveTag } from "./chat-archive";
import { stageOf } from "./board";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type SavedLink = { childId: string; parentId: string; sectionId: string | null };
export const archiveMigration = `CREATE TABLE IF NOT EXISTS kanban_archive_links (
  childId TEXT PRIMARY KEY, parentId TEXT NOT NULL, sectionId TEXT
)`;

function isDone(thread: Thread) {
  return stageOf({
    ...thread, isArchived: false, runtimeStatus: thread.runtime.displayStatus,
    activity: {
      workflows: thread.activity.activeWorkflowCount,
      backgroundAgents: thread.activity.activeBackgroundAgentCount,
      backgroundCommands: thread.activity.activeBackgroundCommandCount,
      planMode: thread.activity.activePlanModeCount,
    },
  }) === "done";
}

export function registerChatArchive(bb: BbPluginApi) {
  const db = bb.storage.database();
  const list = db.prepare("SELECT childId, parentId, sectionId FROM kanban_archive_links");
  const childrenOf = db.prepare("SELECT childId, parentId, sectionId FROM kanban_archive_links WHERE parentId = ?");
  const remember = db.prepare("INSERT OR REPLACE INTO kanban_archive_links VALUES (?, ?, ?)");
  const forget = db.prepare("DELETE FROM kanban_archive_links WHERE childId = ?");
  const forgetThread = db.prepare("DELETE FROM kanban_archive_links WHERE childId = ? OR parentId = ?");
  const publish = () => bb.realtime.publish(archiveChanged, null);
  const invalidateThread = ({ thread }: { thread: { id: string } }) =>
    bb.rpc.experimental_invalidate([threadArchiveTag(thread.id)]);
  let changing = false;

  async function restoreChildren(parentId: string) {
    const links = childrenOf.all(parentId) as SavedLink[];
    if (!links.length) return;
    for (let offset = 0; offset < links.length; offset += 200) {
      const page = links.slice(offset, offset + 200);
      const rows = (await Promise.all([false, true].map((archived) => bb.sdk.threads.list({
        threadIds: page.map(({ childId }) => childId), includeHidden: true, archived, limit: 200,
      })))).flat();
      const byId = new Map(rows.map((thread) => [thread.id, thread]));
      for (const link of page) {
        const child = byId.get(link.childId);
        if (child?.parentThreadId === null) {
          await bb.sdk.threads.update({
            threadId: child.id, parentThreadId: parentId, sectionId: link.sectionId,
          });
        }
        forget.run(link.childId);
      }
    }
  }

  async function archiveOnly(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt) return;
    async function checkDone() {
      const [row] = await bb.sdk.threads.list({ threadIds: [threadId], archived: false, includeHidden: true });
      if (!row || !isDone(row)) throw new Error("Архивировать можно завершённый чат.");
    }
    await checkDone();

    // BB 0.49 exposes a cascading archive. Detach its ordinary children
    // before calling it and remember their links for the board and tree.
    const rows: Thread[] = [];
    await Promise.all([false, true].map(async (archived) => {
      for (let offset = 0; ; offset += 200) {
        const page = await bb.sdk.threads.list({ archived, includeHidden: true, limit: 200, offset });
        rows.push(...page);
        if (page.length < 200) break;
      }
    }));
    const dependencies = new Map<string, Thread[]>();
    const directChildren = rows.filter((child) => child.parentThreadId === threadId);
    for (const child of rows) {
      const parents = new Set([
        child.parentThreadId === threadId ? null : child.parentThreadId,
        child.lifecycleOwnerThreadId,
        child.visibility === "hidden" ? child.sourceThreadId : null,
      ]);
      for (const parent of parents) {
        if (!parent) continue;
        const siblings = dependencies.get(parent) ?? [];
        siblings.push(child);
        dependencies.set(parent, siblings);
      }
    }
    const pending = [...(dependencies.get(threadId) ?? [])];
    const seen = new Set([threadId]);
    while (pending.length) {
      const child = pending.pop()!;
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (!child.archivedAt) throw new Error("BB связывает архивирование этого чата с зависимыми чатами.");
      pending.push(...(dependencies.get(child.id) ?? []));
    }

    try {
      for (const child of directChildren) {
        remember.run(child.id, threadId, child.sectionId);
        await bb.sdk.threads.update({ threadId: child.id, parentThreadId: null, sectionId: child.sectionId });
      }
      const cascade = await bb.sdk.threads.experimental_listCascade({ threadIds: [threadId], action: "archive" });
      if (cascade.threads[0]?.cascadeThreadIds.length) {
        throw new Error("В ветке появились зависимые чаты. Повторите архивирование.");
      }
      await checkDone();
      await bb.sdk.threads.archive({ threadId });
    } catch (error) {
      const current = await bb.sdk.threads.get({ threadId });
      if (!current.archivedAt) await restoreChildren(threadId);
      throw error;
    }
  }

  bb.events.on("experimental_thread.parentChanged", ({ thread }) => {
    if (thread.parentThreadId && forget.run(thread.id).changes) publish();
  });
  bb.events.on("thread.archived", invalidateThread);
  bb.events.on("thread.unarchived", invalidateThread);
  bb.events.on("thread.deleted", (event) => {
    const { thread } = event;
    forgetThread.run(thread.id, thread.id);
    invalidateThread(event);
    publish();
  });
  bb.rpc.register(archiveRpc, {
    archiveParents() {
      return Object.fromEntries((list.all() as SavedLink[]).map(({ childId, parentId }) => [childId, parentId]));
    },
    async archivedThreads({ keys }) {
      const rows = await bb.sdk.threads.list({ threadIds: keys, archived: true, includeHidden: true, limit: keys.length });
      const titles = new Map(rows.map((row) => [row.id, row.title || row.titleFallback || row.id]));
      return Object.fromEntries(keys.map((id) => [id, titles.get(id) ?? null]));
    },
    async archiveChat({ threadId, archived }) {
      if (changing) throw new Error("Дождитесь завершения операции с архивом.");
      changing = true;
      try {
        if (archived) await archiveOnly(threadId);
        else {
          await bb.sdk.threads.unarchive({ threadId });
          await restoreChildren(threadId);
        }
        return null;
      } finally {
        changing = false;
        publish();
      }
    },
  });
}
