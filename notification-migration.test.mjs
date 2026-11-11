import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from './dist/server.js';

await build({ stdin: { contents: `export {migrateStatusBar} from './notification-migration';
  export {notificationStore} from './notification-store'; export {notificationMigrations} from './notification-migrations';
  export {derivationMigration} from './derive-server'; export {mergeMigration} from './merge-resolution';
  export {archiveMigration} from './chat-archive-server';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: 'dist/notification-migration-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { migrateStatusBar, notificationStore, notificationMigrations, derivationMigration, mergeMigration, archiveMigration } = await import('./dist/notification-migration-test.mjs');

function setup(t, legacy = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kanban-notifications-'));
  const source = join(dataDir, 'plugins', 'status-bar', 'data.db');
  if (legacy) {
    mkdirSync(join(dataDir, 'plugins', 'status-bar'), { recursive: true });
    const old = new Database(source);
    if (legacy === 'wal') old.pragma('journal_mode=WAL');
    for (const sql of notificationMigrations) old.exec(sql);
    const insert = old.prepare('INSERT INTO notices VALUES (?,?,?,?,?,?,?,?)');
    insert.run('completed:a:event', 'a', 'A', 'completed', 'Result', 10, null, null);
    insert.run('read', 'b', 'B', 'question', 'Read question', 10, 15, null);
    insert.run('dismissed', 'c', 'C', 'question', 'Hidden question', 10, null, 15);
    old.prepare('INSERT INTO scans VALUES (?,?)').run('a', JSON.stringify({ seq: 7, candidate: { id: 'event', seq: 7, createdAt: 10 } }));
    old.exec("INSERT INTO config VALUES ('since',1),('clearedBefore',5),('lastSoundAt',11)");
    old.exec("INSERT INTO hidden_legacy VALUES ('hidden-chat'); INSERT INTO notification_reads VALUES ('b',15)");
    old.exec("INSERT INTO sound_events VALUES ('old-sound','question','b',10,11,'play')");
    if (legacy === 'wal') t.after(() => old.close()); else old.close();
  }
  let disabled = 0;
  const entry = { id: 'status-bar', enabled: true, status: 'running' };
  const host = createFakePluginHost({ pluginId: 'thread-kanban', dataDir, sdk: { plugins: {
    list: async () => ({ plugins: [entry] }),
    getSettings: async () => ({ values: { soundEnabled: true, soundPreferSystem: true } }),
    disable: async () => { disabled++; entry.enabled = false; return { ok: true }; },
  }, threads: { list: async () => [] } } });
  t.after(() => host.harness.lifecycle.dispose());
  return { ...host, source, get disabled() { return disabled; } };
}

test('the merged server preserves the shipped Kanban migrations and imports the complete legacy state once', async t => {
  const s = setup(t), before = readFileSync(s.source), db = s.bb.storage.database();
  s.bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS kanban_issues (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    derivationMigration, mergeMigration, archiveMigration,
    'CREATE TABLE IF NOT EXISTS kanban_review_workers (issue_id TEXT PRIMARY KEY, worker_id TEXT UNIQUE NOT NULL, request TEXT NOT NULL, revision TEXT NOT NULL)',
  ]);
  db.exec(`INSERT INTO kanban_issues VALUES ('existing','{"marker":true}')`);
  await plugin(s.bb);
  const first = await s.harness.behavior.callRpc('notifications.list', {});
  assert.equal(s.disabled, 1); assert.equal(first.unread, 1);
  assert.equal(first.notices[0].id, 'completed:a:event'); assert.deepEqual(first.hiddenLegacyThreads, ['hidden-chat']);
  assert.deepEqual(first.coveredThreads, ['a']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notices').get().n, 3);
  assert.equal(db.prepare("SELECT payload FROM kanban_issues WHERE id='existing'").get().payload, '{"marker":true}');
  assert.equal(db.prepare("SELECT value FROM config WHERE key='since'").get().value, 1);
  assert.equal(db.prepare("SELECT consumedAt FROM sound_events WHERE id='old-sound'").get().consumedAt, 11);
  assert.equal(db.prepare("SELECT readAt FROM notification_reads WHERE threadId='b'").get().readAt, 15);
  assert.equal((await s.harness.behavior.callRpc('read', null)), null, 'execution settings RPC remains independent');
  // Re-initialization cannot reimport old state or replace newer settings.
  await migrateStatusBar(s.bb, () => { throw Error('Settings were imported twice'); });
  assert.equal(s.disabled, 1); assert.deepEqual(readFileSync(s.source), before);
  assert.equal(s.harness.realtimeSignals.filter(signal => signal.channel === 'sound-arrival').length, 0);
  const preview = await s.harness.behavior.callRpc('notifications.sound.test', {});
  assert.equal((await s.harness.behavior.callRpc('notifications.sound.claim', { id: preview.id })).play, true);
});

test('a failed settings import is retryable without duplicating notices or losing read and hidden states', async t => {
  const s = setup(t); notificationStore(s.bb);
  await assert.rejects(migrateStatusBar(s.bb, async () => { throw Error('retry'); }), /retry/);
  const values = [];
  await migrateStatusBar(s.bb, async value => { values.push(value); });
  assert.deepEqual(values, [{ soundEnabled: true, soundPreferSystem: true }]);
  assert.equal(s.bb.storage.database().prepare('SELECT count(*) AS n FROM notices').get().n, 3);
  assert.equal(s.disabled, 1);
});

test('a fresh installation needs no former plugin and records the migration without reading global plugin settings', async t => {
  const s = setup(t, false); const store = notificationStore(s.bb);
  await migrateStatusBar(s.bb, async () => { throw Error('No legacy settings expected'); });
  assert.equal(store.list().unread, 0); assert.equal(s.disabled, 0);
  assert.equal(s.harness.inspection.sdk.callsTo('plugins.list').length, 0);
});

test('a stopped producer with a WAL is copied consistently without modifying either source file', async t => {
  const s = setup(t, 'wal'), database = readFileSync(s.source), wal = readFileSync(s.source + '-wal');
  notificationStore(s.bb);
  await migrateStatusBar(s.bb, async () => {});
  assert.equal(s.bb.storage.database().prepare('SELECT count(*) AS n FROM notices').get().n, 3);
  assert.deepEqual(readFileSync(s.source), database); assert.deepEqual(readFileSync(s.source + '-wal'), wal);
});
