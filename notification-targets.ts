import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { DerivationJob } from './derive-server';
import type { Notice } from './notification-contract';

/** The worker's transcript is an implementation detail; the saved result owns navigation. */
export async function notificationTargets(bb: BbPluginApi, threadIds: string[]) {
  const db = bb.storage.database();
  const jobs = new Map((db.prepare('SELECT payload FROM kanban_derivations').all() as { payload: string }[])
    .map(row => JSON.parse(row.payload) as DerivationJob).filter(job => job.workerId)
    .map(job => [job.workerId!, job]));
  const threads = [];
  for (let offset = 0; offset < threadIds.length; offset += 200) {
    const ids = threadIds.slice(offset, offset + 200);
    threads.push(...await bb.sdk.threads.list({ threadIds: ids, includeHidden: true, limit: 200 }));
  }
  const internal = new Set(threads.filter(thread => thread.originPluginId === bb.pluginId && thread.visibility === 'hidden')
    .map(thread => thread.id));
  const issue = db.prepare('SELECT payload FROM kanban_issues WHERE id = ?');
  return {
    hiddenThreads: [...new Set([...internal, ...jobs.keys()])],
    project(notice: Notice): Notice | null {
      const job = jobs.get(notice.threadId);
      if (!job) return internal.has(notice.threadId) ? null : notice;
      if (notice.kind !== 'completed' || job.result.status === 'running' || !job.source) return null;
      const children = job.result.children;
      const issueId = children.length === 1 ? children[0].id : job.result.parentId ?? job.source.issueId;
      const saved = issueId ? issue.get(issueId) as { payload: string } | undefined : undefined;
      if (issueId && !saved) return null; // A deleted result must never fall back to its worker.
      const target = saved ? JSON.parse(saved.payload) as { title: string } : null;
      if (!target && !job.source.threadId) return null;
      return { ...notice, derivationId: job.id, ...(issueId ? { issueId } : { threadId: job.source.threadId! }),
        title: target?.title || job.source.title,
        label: job.result.status === 'failed' ? 'Ошибка подготовки' : children.length === 1 ? 'Задача создана' :
          children.length > 1 ? 'Подзадачи созданы' : 'Подготовка завершена',
        detail: job.result.status === 'failed' || !children.length ? job.result.message :
          children.length === 1 ? 'Откройте созданную карточку задачи.' : `Создано подзадач: ${children.length}. Откройте родительскую карточку.`,
      };
    },
  };
}
