import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { Notice } from './notification-contract';
import { kanbanDatabase } from './database';

export type ScanState = { seq: number; candidate: { id: string; seq: number; createdAt: number } | null };
export function notificationStore(bb: BbPluginApi) {
  const db = kanbanDatabase(bb);

  db.prepare('INSERT OR IGNORE INTO config VALUES (?, ?)').run('since', Date.now());
  return {
    get since() { return (db.prepare('SELECT value FROM config WHERE key = ?').get('since') as { value: number }).value; },
    insert(notice: Notice) {
      return db.prepare(`INSERT OR IGNORE INTO notices (id, threadId, title, kind, detail, createdAt, readAt, dismissedAt)
        VALUES (@id, @threadId, @title, @kind, @detail, @createdAt,
          CASE WHEN @createdAt <= (SELECT readAt FROM notification_reads WHERE threadId = @threadId)
            THEN MAX(COALESCE(@readAt, 0), (SELECT readAt FROM notification_reads WHERE threadId = @threadId)) ELSE @readAt END,
          CASE WHEN @createdAt <= (SELECT value FROM config WHERE key = 'clearedBefore')
            THEN (SELECT value FROM config WHERE key = 'clearedBefore') ELSE NULL END)`)
        .run(notice).changes > 0;
    },
    unreadThreadIds() {
      return (db.prepare('SELECT DISTINCT threadId FROM notices WHERE dismissedAt IS NULL AND readAt IS NULL').all() as { threadId: string }[]).map(row => row.threadId);
    },
    list(project: (notice: Notice) => Notice | null = notice => notice) {
      const visible = (db.prepare('SELECT * FROM notices WHERE dismissedAt IS NULL AND readAt IS NULL ORDER BY createdAt DESC, id DESC').all() as Notice[])
        .flatMap(notice => { const target = project(notice); return target ? [target] : []; });
      const notices = visible.slice(0, 200), unread = visible.length;
      const coveredThreads = (db.prepare('SELECT threadId, state FROM scans').all() as { threadId: string; state: string }[])
        .flatMap(({ threadId, state }) => {
          const candidate = (JSON.parse(state) as ScanState).candidate;
          return candidate && db.prepare('SELECT 1 FROM notices WHERE id = ?').get(`completed:${threadId}:${candidate.id}`) ? [threadId] : [];
        });
      const hiddenLegacyThreads = (db.prepare('SELECT threadId FROM hidden_legacy').all() as { threadId: string }[]).map(row => row.threadId);
      return { notices, unread, coveredThreads, hiddenLegacyThreads };
    },
    get(id: string) { return db.prepare('SELECT * FROM notices WHERE id = ?').get(id) as Notice | undefined; },
    dismiss(id: string) {
      return db.prepare('UPDATE notices SET dismissedAt = ? WHERE id = ? AND dismissedAt IS NULL').run(Date.now(), id).changes > 0;
    },
    dismissAll(legacyThreadIds: readonly string[]) {
      const at = Date.now();
      db.transaction(() => {
        db.prepare('UPDATE notices SET dismissedAt = ? WHERE dismissedAt IS NULL AND createdAt <= ?').run(at, at);
        db.prepare(`INSERT INTO config (key, value) VALUES ('clearedBefore', ?)
          ON CONFLICT(key) DO UPDATE SET value = MAX(config.value, excluded.value)`).run(at);
        const hide = db.prepare('INSERT OR IGNORE INTO hidden_legacy VALUES (?)');
        for (const threadId of legacyThreadIds) hide.run(threadId);
      })();
    },
    hideLegacy(threadId: string) { return db.prepare('INSERT OR IGNORE INTO hidden_legacy VALUES (?)').run(threadId).changes > 0; },
    resetLegacy(threadId: string) { return db.prepare('DELETE FROM hidden_legacy WHERE threadId = ?').run(threadId).changes > 0; },
    read(id: string, at: number) { return db.prepare('UPDATE notices SET readAt = ? WHERE id = ? AND readAt IS NULL').run(at, id).changes > 0; },
    readThread(threadId: string, at: number) {
      return db.transaction(() => {
        db.prepare(`INSERT INTO notification_reads VALUES (?, ?) ON CONFLICT(threadId)
          DO UPDATE SET readAt = MAX(notification_reads.readAt, excluded.readAt)`).run(threadId, at);
        return db.prepare('UPDATE notices SET readAt = ? WHERE threadId = ? AND createdAt <= ? AND readAt IS NULL')
          .run(at, threadId, at).changes > 0;
      })();
    },
    removeThread(threadId: string) {
      return db.prepare('DELETE FROM notices WHERE threadId = ?').run(threadId).changes > 0;
    },
    state(threadId: string): ScanState {
      const row = db.prepare('SELECT state FROM scans WHERE threadId = ?').get(threadId) as { state: string } | undefined;
      return row ? JSON.parse(row.state) : { seq: 0, candidate: null };
    },
    save(threadId: string, state: ScanState) {
      db.prepare('INSERT OR REPLACE INTO scans VALUES (?, ?)').run(threadId, JSON.stringify(state));
    },
  };
}
