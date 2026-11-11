import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { soundChannel, type SoundEvent, type soundDecisionSchema } from './notification-contract';

export const SOUND_MAX_AGE = 10000;
export const SOUND_COOLDOWN = 3000;
const PRESENCE_TTL = 45000;
type Decision = z.infer<typeof soundDecisionSchema>;
type SystemChannel = 'web' | 'desktop';
const level = z.enum(['all', 'input-only', 'muted']);
const preferences = z.object({ threads: z.record(z.string(), z.object({
  own: z.enum(['inherit', 'all', 'input-only', 'muted']),
  ancestorCap: z.object({ level, threadId: z.string() }).nullable(),
})) });

/** Shared by every frontend, including clients at different origins. No replay queue. */
export function soundDelivery(bb: BbPluginApi, enabled: () => Promise<boolean>, preferSystem: () => Promise<boolean>) {
  const db = bb.storage.database();
  const clients = new Map<string, { channel: SystemChannel; at: number }>();
  let active = true;
  function presence(clientId: string, channel: SystemChannel | null) {
    for (const [id, client] of clients) if (Date.now() - client.at > PRESENCE_TTL) clients.delete(id);
    if (channel === null) clients.delete(clientId);
    else clients.set(clientId, { channel, at: Date.now() });
    return { ok: true };
  }
  function publish(id: string, kind: SoundEvent['kind'], threadId: string | null = null) {
    if (!active) return;
    const at = Date.now();
    const inserted = db.prepare('INSERT OR IGNORE INTO sound_events (id,kind,threadId,at) VALUES (?,?,?,?)')
      .run(id, kind, threadId, at).changes;
    if (!inserted) return;
    // Bound persistent deduplication; stale events can never claim a sound.
    db.prepare('DELETE FROM sound_events WHERE at < ?').run(at - 86400000);
    bb.realtime.publish(soundChannel, { id, kind, threadId, at });
  }
  async function systemWillNotify(event: SoundEvent) {
    if (event.kind === 'derivation' || event.threadId === null) return false;
    const channels = new Set([...clients.values()].filter(client => Date.now() - client.at < PRESENCE_TTL).map(client => client.channel));
    if (!channels.size) return false;
    try {
      const plugins = await bb.sdk.plugins.list();
      if (!plugins.plugins.some(plugin => plugin.id === 'push-notifications' && plugin.enabled && plugin.status === 'running')) return false;
      const { values } = await bb.sdk.plugins.getSettings({ pluginId: 'push-notifications' });
      if (![...channels].some(channel => values[`${channel}Enabled`] === true)) return false;
      const [result, thread] = await Promise.all([
        bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'threadNotifications.list',
          input: { threadIds: [event.threadId] }, outputSchema: preferences }),
        bb.sdk.threads.get({ threadId: event.threadId }),
      ]);
      const pref = result.threads[event.threadId];
      if (!pref) return true; // Avoid a second signal when push policy is unavailable.
      const own = pref.own !== 'inherit' ? pref.own : thread.parentThreadId !== null && values.childLevel !== 'inherit'
        ? values.childLevel : values.defaultLevel;
      const ranks: Record<string, number> = { muted: 0, 'input-only': 1, all: 2 };
      const rank = Math.min(ranks[String(own)] ?? 2, pref.ancestorCap ? ranks[pref.ancestorCap.level] : 2);
      return rank >= (event.kind === 'completed' ? 2 : 1);
    } catch {
      return true; // A known system-capable client takes precedence if policy reads fail.
    }
  }
  const consume = db.transaction((event: SoundEvent, system: boolean): Decision => {
    const at = Date.now();
    if (at - event.at > SOUND_MAX_AGE) return { play: false, reason: 'expired' };
    if (event.kind === 'completed' || event.kind === 'question') {
      const notice = db.prepare('SELECT readAt,dismissedAt FROM notices WHERE id = ?').get(event.id) as { readAt: number | null; dismissedAt: number | null } | undefined;
      if (!notice || notice.readAt !== null || notice.dismissedAt !== null) return { play: false, reason: 'missing' };
    }
    if (event.kind === 'error' && db.prepare('SELECT 1 FROM hidden_legacy WHERE threadId = ?').get(event.threadId))
      return { play: false, reason: 'missing' };
    const last = (db.prepare("SELECT value FROM config WHERE key = 'lastSoundAt'").get() as { value: number } | undefined)?.value;
    const reason = system ? 'system' : last !== undefined && at - last < SOUND_COOLDOWN ? 'cooldown' : 'play';
    if (!db.prepare('UPDATE sound_events SET consumedAt = ?, decision = ? WHERE id = ? AND consumedAt IS NULL').run(at, reason, event.id).changes)
      return { play: false, reason: 'claimed' };
    if (reason !== 'play') return { play: false, reason };
    db.prepare("INSERT INTO config VALUES ('lastSoundAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(at);
    return { play: true, reason: 'play' };
  });
  async function claim(id: string): Promise<Decision> {
    if (!active || !await enabled()) return { play: false, reason: 'disabled' };
    const event = db.prepare('SELECT * FROM sound_events WHERE id = ?').get(id) as SoundEvent & { consumedAt: number | null } | undefined;
    if (!event) return { play: false, reason: 'missing' };
    if (event.consumedAt !== null) return { play: false, reason: 'claimed' };
    if (Date.now() - event.at > SOUND_MAX_AGE) return { play: false, reason: 'expired' };
    // Reading, dismissing or deleting a chat while the request is in flight cancels its sound.
    if (event.kind === 'completed' || event.kind === 'question') {
      const notice = db.prepare('SELECT readAt,dismissedAt FROM notices WHERE id = ?').get(id) as { readAt: number | null; dismissedAt: number | null } | undefined;
      if (!notice || notice.readAt !== null || notice.dismissedAt !== null) return { play: false, reason: 'missing' };
    }
    // Notification permission does not prove an audible system delivery. Bell sound is
    // authoritative unless the user explicitly chooses the system-sound preference.
    const system = await preferSystem() && await systemWillNotify(event);
    if (!active || !await enabled()) return { play: false, reason: 'disabled' };
    return consume(event, system);
  }
  bb.onDispose(() => { active = false; clients.clear(); });
  return { publish, presence, claim, cancelThread(threadId: string, before = Date.now()) {
    db.prepare("UPDATE sound_events SET consumedAt = ?, decision = 'cancelled' WHERE threadId = ? AND at <= ? AND consumedAt IS NULL")
      .run(Date.now(), threadId, before);
  }, invalidate() {
    db.prepare("UPDATE sound_events SET consumedAt = ?, decision = 'cancelled' WHERE consumedAt IS NULL").run(Date.now());
  } };
}
