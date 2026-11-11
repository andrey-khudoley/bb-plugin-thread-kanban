import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';


await build({ entryPoints: ['notification-server.ts'], outfile: 'dist/notification-policy-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { default: plugin } = await import('./dist/notification-policy-test.mjs');

const now = Date.now() + 1000;
const row = (id, extra = {}) => ({ ...makeThreadResponse({ id, title: `Chat ${id}`, updatedAt: now }),
  hasPendingInteraction: false, queuedWork: 'none',
  activity: { activeWorkflowCount: 0, activePlanModeCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0 }, ...extra });
const event = (threadId, seq, type = 'turn/completed', data = { status: 'completed' }) =>
  ({ id: `${threadId}-${seq}`, threadId, seq, createdAt: now + seq, scope: { kind: 'turn', turnId: `turn-${seq}` }, type, data });
const interaction = (threadId, id = 'q1', kind = 'user_question') => ({ id, threadId, createdAt: now,
  status: 'pending', payload: kind === 'user_question' ? { kind, questions: [{ id: 'one', prompt: 'Choose an option', required: true }] } : { kind, title: 'Input' } });

async function setup(t) {
  const threads = [row('a'), row('b')], events = new Map(), interactions = new Map();
  let host = createFakePluginHost({ pluginId: 'thread-kanban', sdk: { threads: {
    list: async ({ threadIds, offset = 0, limit = 200 } = {}) => threads.filter(thread => !threadIds || threadIds.includes(thread.id)).slice(offset, offset + limit),
    events: { list: async ({ threadId, afterSeq = '0', limit = '100', types }) => {
      assert.ok(Number(limit) <= 100, 'BB caps each event page at 100 rows');
      return (events.get(threadId) ?? []).filter(event => event.seq > Number(afterSeq) && types.includes(event.type)).slice(0, Number(limit));
    } },
    interactions: { list: async ({ threadId }) => interactions.get(threadId) ?? [] },
    markRead: async ({ threadId }) => { const thread = threads.find(item => item.id === threadId); thread.lastReadAt = now + 5000; return thread; },
  } } });
  await plugin(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  const emit = async (id = 'a', name = 'experimental_thread.events') => host.harness.behavior.emitThreadEvent(name,
    { thread: threads.find(item => item.id === id), sequence: 100, lastAssistantText: 'Done?' });
  const list = () => host.harness.behavior.callRpc('notifications.list', {});
  const recover = async () => { const service = host.harness.behavior.runService('notification-recovery'); await service.done; };
  const reload = async () => { host = await host.harness.lifecycle.reload(plugin); };
  return { get harness() { return host.harness; }, get db() { return host.bb.storage.database(); }, threads, events, interactions, emit, list, recover, reload };
}

test('two concurrent chats deliver exactly one completion each; replay and idle overlap are idempotent', async t => {
  const s = await setup(t);
  s.events.set('a', [event('a', 1)]); s.events.set('b', [event('b', 1)]);
  await Promise.all([s.emit('a'), s.emit('b'), s.emit('a', 'thread.idle'), s.emit('b')]);
  const result = await s.list();
  assert.equal(result.notices.length, 2); assert.equal(result.unread, 2);
  assert.deepEqual(result.notices.map(n => n.threadId).sort(), ['a', 'b']);
  await s.emit(); await s.recover(); assert.equal((await s.list()).notices.length, 2);
});

test('commentary, question marks, failed/interrupted turns and idle without completion do not notify', async t => {
  const s = await setup(t);
  await s.emit('a', 'thread.idle');
  for (const [seq, type, data] of [[1, 'item/completed', { text: 'Finished?' }], [2, 'turn/completed', { status: 'failed' }],
    [3, 'turn/completed', { status: 'interrupted' }], [4, 'system/thread/interrupted', {}]]) {
    s.events.set('a', [event('a', seq, type, data)]); await s.emit();
  }
  assert.equal((await s.list()).unread, 0);
});

test('background work, queue, pending interaction and active runtime defer completion; a new run invalidates the candidate', async t => {
  const s = await setup(t); s.events.set('a', [event('a', 1)]);
  for (const patch of [{ activity: { activeWorkflowCount: 1 } }, { queuedWork: 'waiting' }, { hasPendingInteraction: true },
    { runtime: { displayStatus: 'active' } }, { status: 'error' }]) {
    s.threads[0] = row('a', patch); await s.emit(); assert.equal((await s.list()).unread, 0);
  }
  s.threads[0] = row('a'); s.events.get('a').push(event('a', 2, 'turn/started', {}));
  await s.emit(); assert.equal((await s.list()).unread, 0);
  s.events.get('a').push(event('a', 3)); await s.emit(); assert.equal((await s.list()).unread, 1);
});

test('structured question and recovery share the interaction ID; approvals and resolved inputs do not create questions', async t => {
  const s = await setup(t), q = interaction('a');
  s.threads[0].hasPendingInteraction = true; s.interactions.set('a', [q]);
  await Promise.all([s.harness.behavior.emitThreadEvent('interaction.pending', { thread: s.threads[0], interaction: q }), s.emit()]);
  await s.recover();
  let result = await s.list(); assert.equal(result.unread, 1); assert.equal(result.notices[0].kind, 'question');
  assert.equal(result.notices[0].title, 'Chat a'); assert.match(result.notices[0].detail, /Choose/);
  for (const q2 of [interaction('b', 'approval', 'approval'), { ...interaction('b', 'resolved'), status: 'resolved' }])
    await s.harness.behavior.emitThreadEvent('interaction.pending', { thread: s.threads[1], interaction: q2 });
  assert.equal((await s.list()).notices.length, 1);
});

test('opening reads the matching chat, read events sync other windows, and a later event stays unread', async t => {
  const s = await setup(t); s.events.set('a', [event('a', 1)]); s.events.set('b', [event('b', 1)]);
  await s.emit('a'); await s.emit('b');
  const a = (await s.list()).notices.find(n => n.threadId === 'a');
  await s.harness.behavior.callRpc('notifications.read', { id: a.id });
  assert.equal((await s.list()).unread, 1);
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead')[0][0].threadId, 'a');
  s.threads[1].lastReadAt = now + 100;
  await s.emit('b', 'experimental_thread.read'); assert.equal((await s.list()).unread, 0);
  s.events.get('a').push({ ...event('a', 2), createdAt: now + 6000 });
  await s.emit('a'); assert.equal((await s.list()).unread, 1);
});

test('backend reload preserves notifications, read state and deduplication; missed events recover', async t => {
  const s = await setup(t); s.events.set('a', [event('a', 1)]); await s.emit();
  const original = (await s.list()).notices[0];
  await s.harness.behavior.callRpc('notifications.read', { id: original.id });
  await s.reload(); await s.recover(); await s.emit();
  let result = await s.list(); assert.equal(result.notices.length, 0); assert.equal(result.unread, 0);
  assert.ok(s.db.prepare('SELECT readAt FROM notices WHERE id = ?').get(original.id).readAt !== null);
  s.events.set('b', [event('b', 1)]); await s.reload(); await s.recover();
  result = await s.list(); assert.equal(result.notices.length, 1); assert.equal(result.unread, 1);
});

test('event pagination does not skip the terminal event and deleted chat notifications disappear', async t => {
  const s = await setup(t);
  s.events.set('a', [...Array.from({ length: 210 }, (_, i) => event('a', i + 1, 'turn/started', {})), event('a', 211)]);
  await s.emit(); assert.equal((await s.list()).notices.length, 1);
  await s.emit('a', 'thread.deleted'); assert.equal((await s.list()).notices.length, 0);
});

test('plugin uses only public SDK surfaces', async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^react(?:-dom)?$/, /^@radix-ui\//, /^@testing-library\//,
    /^jsdom$/, /^esbuild$/, /^better-sqlite3$/, /^sonner$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^@modelcontextprotocol\/(?:server|client)(?:\/stdio)?$/] });
  assert.deepEqual(result.violations, []); assert.deepEqual(result.privateDependencies, []);
});

test('hiding a bell entry persists without reading the chat, changing readAt or replaying a hidden event', async t => {
  const s = await setup(t); s.events.set('a', [event('a', 1)]); await s.emit();
  const original = (await s.list()).notices[0];
  const response = await s.harness.behavior.callRpc('notifications.dismiss', { id: original.id });
  assert.equal(response.ok, true);
  assert.equal((await s.list()).unread, 0); assert.equal((await s.list()).notices.length, 0);
  assert.deepEqual((await s.list()).coveredThreads, ['a']);
  const stored = s.db.prepare('SELECT readAt, dismissedAt FROM notices WHERE id = ?').get(original.id);
  assert.equal(stored.readAt, null); assert.ok(stored.dismissedAt > 0);
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead').length, 0);
  await s.reload(); await s.recover(); await s.emit();
  assert.equal((await s.list()).notices.length, 0);
  await s.harness.behavior.callRpc('notifications.dismiss', { id: original.id });
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead').length, 0);
  s.events.get('a').push(event('a', 2)); await s.emit();
  assert.equal((await s.list()).notices.length, 1);
});

test('hiding legacy errors persists until new work, without calling markRead', async t => {
  const s = await setup(t);
  await s.harness.behavior.callRpc('notifications.dismissLegacy', { threadId: 'a' });
  assert.deepEqual((await s.list()).hiddenLegacyThreads, ['a']);
  await s.reload(); assert.deepEqual((await s.list()).hiddenLegacyThreads, ['a']);
  await s.emit('a', 'thread.active'); assert.deepEqual((await s.list()).hiddenLegacyThreads, []);
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead').length, 0);
});

test('clear all hides history beyond the visible page, preserves read state and survives recovery', async t => {
  const s = await setup(t);
  s.events.set('a', [event('a', 1)]); await s.emit();
  const insert = s.db.prepare('INSERT INTO notices (id,threadId,title,kind,detail,createdAt,readAt) VALUES (?,?,?,?,?,?,?)');
  for (let index = 0; index < 250; index++) insert.run(`history-${index}`, 'a', 'History', 'completed', '', now, index % 5 === 0 ? now : null);
  assert.equal((await s.list()).notices.length, 200);
  const beforeReadAt = s.db.prepare('SELECT id, readAt FROM notices ORDER BY id').all();
  const clock = t.mock.method(Date, 'now', () => now + 100);
  try {
    await s.harness.behavior.callRpc('notifications.dismissAll', { legacyThreadIds: ['b'] });
  } finally { clock.mock.restore(); }
  const result = await s.list();
  assert.equal(result.notices.length, 0); assert.equal(result.unread, 0);
  assert.deepEqual(result.hiddenLegacyThreads, ['b']);
  assert.deepEqual(s.db.prepare('SELECT id, readAt FROM notices ORDER BY id').all(), beforeReadAt);
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead').length, 0);
  await s.reload(); await s.recover(); await s.emit();
  assert.equal((await s.list()).notices.length, 0);
  // A delayed pre-clear event stays hidden; a later event is delivered normally.
  s.events.set('b', [event('b', 1)]); await s.emit('b');
  assert.equal((await s.list()).notices.length, 0);
  s.events.get('a').push({ ...event('a', 2), createdAt: now + 200 }); await s.emit();
  assert.equal((await s.list()).unread, 1);
});

test('manual chat read removes only its notifications; delayed delivery stays read and later work is new', async t => {
  const s = await setup(t);
  s.events.set('a', [event('a', 1)]); s.events.set('b', [event('b', 1)]);
  await s.emit('a'); await s.emit('b');
  s.threads[0].lastReadAt = now + 10;
  await s.emit('a', 'experimental_thread.read');
  assert.deepEqual((await s.list()).notices.map(notice => notice.threadId), ['b']);
  s.threads[0].lastReadAt = null; // An older DTO may race with the committed read event.
  s.events.get('a').push({ ...event('a', 2), createdAt: now + 5 }); await s.emit('a');
  assert.deepEqual((await s.list()).notices.map(notice => notice.threadId), ['b']);
  s.threads[0].lastReadAt = now + 10;
  await s.reload(); await s.recover();
  assert.deepEqual((await s.list()).notices.map(notice => notice.threadId), ['b']);
  s.events.get('a').push({ ...event('a', 3), createdAt: now + 11 }); await s.emit('a');
  assert.equal((await s.list()).unread, 2);
});

test('an explicit visible-chat acknowledgement reads that chat, without resolving its pending question', async t => {
  const s = await setup(t); const q = interaction('a');
  s.threads[0].hasPendingInteraction = true; s.interactions.set('a', [q]);
  await s.harness.behavior.emitThreadEvent('interaction.pending', { thread: s.threads[0], interaction: q });
  await s.harness.behavior.callRpc('notifications.viewThread', { threadId: 'a' });
  assert.equal((await s.list()).notices.length, 0);
  assert.equal(s.interactions.get('a')[0].status, 'pending');
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead')[0][0].threadId, 'a');
});
