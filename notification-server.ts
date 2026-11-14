import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { channel, contract, testNotificationChannel } from './notification-contract';
import { notificationStore } from './notification-store';
import { SOUND_MAX_AGE, soundDelivery } from './sound-delivery';
import { migrateStatusBar } from './notification-migration';
import { notificationTargets } from './notification-targets';

type Thread = Awaited<ReturnType<BbPluginApi['sdk']['threads']['list']>>[number];
type Interaction = Awaited<ReturnType<BbPluginApi['sdk']['threads']['interactions']['list']>>[number];
const titleOf = (thread: { id: string; title: string | null; titleFallback: string | null }) =>
  (thread.title ?? thread.titleFallback ?? thread.id).slice(0, 500);

export function registerNotifications(bb: BbPluginApi) {
  const store = notificationStore(bb);
  const settings = bb.settings.define({
    soundEnabled: { type: 'boolean', label: 'Звук новых уведомлений',
      description: 'Короткий сигнал колокольчика при поступлении новых уведомлений.', default: false },
    soundPreferSystem: { type: 'boolean', label: 'Предпочитать системный звук',
      description: 'Пропускать сигнал колокольчика, если доступно системное уведомление BB. Включайте, только если его звук слышен.', default: false },
  });
  const sound = soundDelivery(bb, async () => (await settings.get()).soundEnabled,
    async () => (await settings.get()).soundPreferSystem);
  settings.onChange((next, previous) => {
    if (next.soundEnabled !== previous.soundEnabled || next.soundPreferSystem !== previous.soundPreferSystem) sound.invalidate();
  });
  let initialization: Promise<void> | null = null;
  const ready = () => initialization ??= migrateStatusBar(bb, values => settings.experimental_set(values))
    .catch(error => { initialization = null; throw error; });
  const startedAt = Date.now();
  const changed = () => bb.realtime.publish(channel, {});
  let stopped = false;
  const pending = new Map<string, Promise<void>>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const deleted = new Set<string>();
  const internal = (thread: Pick<Thread, 'originPluginId' | 'visibility'>) => thread.originPluginId === bb.pluginId && thread.visibility === 'hidden';
  async function readThread(threadId: string) {
    await ready();
    const thread = await bb.sdk.threads.markRead({ threadId });
    if (thread.lastReadAt !== null) sound.cancelThread(thread.id, thread.lastReadAt);
    if (thread.lastReadAt !== null && store.readThread(thread.id, thread.lastReadAt)) changed();
    return { ok: true };
  }
  const question = (thread: Pick<Thread, 'id' | 'title' | 'titleFallback' | 'lastReadAt' | 'originPluginId' | 'visibility'>, interaction: Interaction, live = false) => {
    if (stopped || internal(thread) || deleted.has(thread.id) || interaction.status !== 'pending' || interaction.payload.kind === 'approval') return;
    const detail = interaction.payload.kind === 'user_question'
      ? interaction.payload.questions.map(question => question.prompt).join('\n')
      : 'title' in interaction.payload ? interaction.payload.title : 'Агент ожидает вашего ответа';
    if (store.insert({ id: `question:${thread.id}:${interaction.id}`, threadId: thread.id,
      title: titleOf(thread), kind: 'question', detail: detail.slice(0, 2000), createdAt: interaction.createdAt,
      readAt: (thread.lastReadAt ?? 0) >= interaction.createdAt ? thread.lastReadAt : null })) {
      changed();
      if (live && interaction.createdAt >= startedAt && (thread.lastReadAt ?? 0) < interaction.createdAt)
        sound.publish(`question:${thread.id}:${interaction.id}`, 'question', thread.id);
    }
  };
  async function scan(threadId: string, live: boolean) {
    if (stopped || deleted.has(threadId)) return;
    const thread = (await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true }))[0];
    if (!thread || stopped) return;
    const state = store.state(threadId);
    // Only lifecycle facts enter this policy; assistant text and punctuation never do.
    for (;;) {
      const rows = await bb.sdk.threads.events.list({ threadId, afterSeq: String(state.seq), order: 'asc', limit: '100',
        types: ['client/turn/requested', 'turn/started', 'turn/completed', 'system/thread/interrupted'] });
      if (stopped) return;
      for (const row of rows) {
        state.seq = Math.max(state.seq, row.seq);
        if (row.type === 'turn/completed') {
          state.candidate = row.data.status === 'completed' && row.createdAt >= store.since
            ? { id: row.id, seq: row.seq, createdAt: row.createdAt } : null;
        } else state.candidate = null;
      }
      store.save(threadId, state);
      if (rows.length < 100) break;
    }
    // Re-read after the event query: an idle DTO captured before a new turn is stale.
    const current = (await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true }))[0];
    if (!current || stopped || deleted.has(threadId)) return;
    if (current.hasPendingInteraction) {
      for (const interaction of await bb.sdk.threads.interactions.list({ threadId })) question(current, interaction, live);
    }
    const idle = (thread: Thread) => thread.status === 'idle' && thread.runtime.displayStatus === 'idle' &&
      !thread.hasPendingInteraction && thread.queuedWork === 'none' &&
      Object.values(thread.activity).every(count => count === 0);
    if (state.candidate && idle(current)) {
      const candidate = state.candidate;
      if (store.insert({ id: `completed:${threadId}:${candidate.id}`, threadId, title: titleOf(current),
        kind: 'completed', detail: 'Агент завершил работу. Откройте чат, чтобы прочитать результат.',
        createdAt: candidate.createdAt, readAt: (current.lastReadAt ?? 0) >= candidate.createdAt ? current.lastReadAt : null })) {
        changed();
        if (live && !internal(current) && candidate.createdAt >= startedAt && (current.lastReadAt ?? 0) < candidate.createdAt)
          sound.publish(`completed:${threadId}:${candidate.id}`, 'completed', threadId);
      }
    }
    if (current.lastReadAt !== null && store.readThread(threadId, current.lastReadAt)) changed();
  }
  function enqueue(threadId: string, live = true) {
    clearTimeout(retries.get(threadId)); retries.delete(threadId);
    const task = (pending.get(threadId) ?? Promise.resolve()).catch(() => {}).then(async () => { await ready(); await scan(threadId, live); }).catch(error => {
      if (stopped) return;
      bb.log.warn(`Notification scan failed for ${threadId}; retrying: ${String(error).slice(0, 500)}`);
      if (!retries.has(threadId)) retries.set(threadId, setTimeout(() => { void enqueue(threadId, live); }, 3000));
    });
    pending.set(threadId, task);
    void task.finally(() => { if (pending.get(threadId) === task) pending.delete(threadId); }).catch(() => {});
    return task;
  }
  bb.events.on('experimental_thread.events', ({ thread }) => enqueue(thread.id));
  bb.events.on('thread.idle', ({ thread }) => enqueue(thread.id));
  bb.events.on('thread.active', async ({ thread }) => {
    await ready(); if (store.resetLegacy(thread.id)) changed(); });
  bb.events.on('thread.failed', async ({ thread }) => {
    await ready();
    if (store.resetLegacy(thread.id)) changed();
    if (!internal(thread) && thread.updatedAt >= startedAt && (thread.lastReadAt ?? 0) < thread.updatedAt)
      sound.publish(`error:${thread.id}:${thread.updatedAt}`, 'error', thread.id);
  });
  bb.events.on('interaction.pending', async ({ thread, interaction }) => { await ready(); question(thread, interaction, true); });
  bb.events.on('experimental_thread.read', async ({ thread }) => {
    await ready();
    if (thread.lastReadAt !== null) sound.cancelThread(thread.id, thread.lastReadAt);
    if (thread.lastReadAt !== null && store.readThread(thread.id, thread.lastReadAt)) changed();
  });
  bb.events.on('thread.deleted', async ({ thread }) => {
    await ready();
    sound.cancelThread(thread.id);
    deleted.add(thread.id); clearTimeout(retries.get(thread.id)); retries.delete(thread.id);
    if (store.removeThread(thread.id)) changed();
  });
  bb.rpc.register(contract, {
    'notifications.sound.test': async () => {
      await ready();
      const id = `test:${randomUUID()}`;
      bb.realtime.publish(testNotificationChannel, { id, label: 'Тестовое уведомление', title: 'Проверка звука колокольчика BB' });
      sound.publish(id, 'test');
      return { ok: true, id };
    },
    'notifications.sound.setEnabled': async ({ enabled }) => {
      await ready();
      await settings.experimental_set({ soundEnabled: enabled });
      return { enabled };
    },
    'notifications.sound.presence': async ({ clientId, systemChannel }) => { await ready(); return sound.presence(clientId, systemChannel); },
    'notifications.sound.claim': async ({ id }) => { await ready(); return sound.claim(id); },
    'notifications.sound.contribute': async ({ id }) => { await ready(); sound.publish(id, 'derivation'); return { ok: true }; },
    'notifications.list': async () => {
      await ready();
      const targets = await notificationTargets(bb, store.unreadThreadIds());
      const result = store.list(targets.project);
      for (const notice of result.notices) {
        if (notice.derivationId && notice.createdAt >= startedAt && Date.now() - notice.createdAt < SOUND_MAX_AGE)
          sound.publish(notice.id, 'completed');
      }
      return { ...result, hiddenLegacyThreads: [...new Set([...result.hiddenLegacyThreads, ...targets.hiddenThreads])] };
    },
    'notifications.viewThread': ({ threadId }) => readThread(threadId),
    'notifications.dismissAll': async ({ legacyThreadIds }) => {
      await ready();
      store.dismissAll(legacyThreadIds);
      sound.invalidate();
      changed();
      return { ok: true };
    },
    'notifications.dismiss': async ({ id }) => {
      await ready();
      if (!store.get(id)) return { ok: false };
      if (store.dismiss(id)) changed();
      return { ok: true };
    },
    'notifications.dismissLegacy': async ({ threadId }) => {
      await ready();
      const thread = (await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true }))[0];
      if (!thread) return { ok: false };
      if (store.hideLegacy(threadId)) changed();
      return { ok: true };
    },
    'notifications.read': async ({ id }) => {
      await ready();
      const notice = store.get(id);
      if (!notice) return { ok: false };
      const target = (await notificationTargets(bb, [notice.threadId])).project(notice);
      if (!target) return { ok: false };
      if (!target.derivationId) return readThread(target.threadId);
      if (!target.issueId) await readThread(target.threadId);
      if (store.read(id, Date.now())) changed();
      return { ok: true };
    },
  });
  bb.background.service('notification-recovery', { async start(signal) {
    await ready();
    signal.addEventListener('abort', () => { stopped = true; }, { once: true });
    // Handlers are already registered; queues serialize live events and recovery per chat.
    for (let offset = 0; !signal.aborted; offset += 200) {
      const threads = await bb.sdk.threads.list({ includeHidden: true, limit: 200, offset, signal });
      await Promise.all(threads.filter(thread => thread.updatedAt >= store.since || thread.hasPendingInteraction)
        .map(thread => enqueue(thread.id, false)));
      if (threads.length < 200) break;
    }
  } });
  bb.onDispose(async () => { stopped = true; retries.forEach(timer => clearTimeout(timer)); retries.clear();
    await Promise.allSettled([...pending.values()]); });
}

export default registerNotifications;
