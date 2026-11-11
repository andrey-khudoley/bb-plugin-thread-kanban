import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { build } from 'esbuild';


await build({ entryPoints: ['notification-server.ts'], outfile: 'dist/sound-server-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { default: plugin } = await import('./dist/sound-server-test.mjs');

await build({ entryPoints: ['notification-sound.ts'], outfile: 'dist/audio-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm' });
const { createNotificationAudio } = await import('./dist/audio-test.mjs');

async function setup(t, { enabled = true, push = false, preferSystem = false } = {}) {
  let at = Date.now() + 1000;
  t.mock.method(Date, 'now', () => at);
  const row = id => ({ ...makeThreadResponse({ id, status: 'idle', lastReadAt: null, updatedAt: at + 1 }),
    hasPendingInteraction: false, queuedWork: 'none',
    activity: { activeWorkflowCount: 0, activePlanModeCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0 } });
  const threads = [row('a'), row('b')];
  const events = new Map(), interactions = new Map();
  let preference = 'all';
  const host = createFakePluginHost({ pluginId: 'thread-kanban', settings: { soundEnabled: enabled, soundPreferSystem: preferSystem }, sdk: {
    threads: {
      list: async ({ threadIds, offset = 0, limit = 200 } = {}) => threads.filter(thread => !threadIds || threadIds.includes(thread.id)).slice(offset, offset + limit),
      get: async ({ threadId }) => threads.find(thread => thread.id === threadId),
      events: { list: async ({ threadId, afterSeq = '0' }) => (events.get(threadId) ?? []).filter(event => event.seq > Number(afterSeq)) },
      interactions: { list: async ({ threadId }) => interactions.get(threadId) ?? [] },
    },
    plugins: {
      list: async () => ({ plugins: push ? [{ id: 'push-notifications', enabled: true, status: 'running' }] : [] }),
      getSettings: async () => ({ values: { desktopEnabled: true, webEnabled: true, defaultLevel: 'all', childLevel: 'input-only' } }),
      callRpc: async () => ({ threads: { a: { own: preference, ancestorCap: null }, b: { own: preference, ancestorCap: null } } }),
    },
  } });
  await plugin(host.bb); t.after(() => host.harness.lifecycle.dispose());
  const call = (method, input = {}) => host.harness.behavior.callRpc(method, input);
  async function question(id = 'q1', threadId = 'a') {
    const q = { id, threadId, status: 'pending', createdAt: at + 1,
      payload: { kind: 'user_question', questions: [{ id: 'one', prompt: 'Test', required: true }] } };
    interactions.set(threadId, [q]);
    await host.harness.behavior.emitThreadEvent('interaction.pending', { thread: threads.find(t => t.id === threadId), interaction: q });
    return `question:${threadId}:${id}`;
  }
  return { ...host, call, question, events, threads, interactions,
    advance(ms) { at += ms; }, preference(value) { preference = value; },
    signals: () => host.harness.realtimeSignals.filter(signal => signal.channel === 'sound-arrival'),
  };
}

test('explicit test broadcasts a popup and one normal sound without adding notification history', async t => {
  const s = await setup(t), result = await s.call('notifications.sound.test');
  assert.equal(result.ok, true); assert.match(result.id, /^test:/);
  assert.equal((await s.call('notifications.list')).notices.length, 0);
  assert.equal(s.harness.realtimeSignals.filter(signal => signal.channel === 'test-notification').length, 1);
  assert.equal(s.signals().length, 1);
  assert.equal((await s.call('notifications.sound.claim', { id: result.id })).play, true);
  assert.equal((await s.call('notifications.sound.claim', { id: result.id })).play, false);
});

test('one live question emits once; snapshots, read changes and repeated delivery never request another sound', async t => {
  const s = await setup(t), id = await s.question();
  await s.question(); await s.call('notifications.list'); await s.call('notifications.dismiss', { id });
  assert.equal(s.signals().length, 1);
  assert.deepEqual(await s.call('notifications.sound.claim', { id }), { play: false, reason: 'missing' });
});

test('atomic claims across windows and origins permit one sound; a burst is consumed without delayed replay', async t => {
  const s = await setup(t), id = await s.question();
  const claims = await Promise.all([s.call('notifications.sound.claim', { id }), s.call('notifications.sound.claim', { id })]);
  assert.equal(claims.filter(result => result.play).length, 1);
  const burst = await s.question('q2', 'b');
  assert.equal((await s.call('notifications.sound.claim', { id: burst })).reason, 'cooldown');
  s.advance(3100);
  assert.equal((await s.call('notifications.sound.claim', { id: burst })).reason, 'claimed');
  const next = await s.question('q3');
  assert.equal((await s.call('notifications.sound.claim', { id: next })).play, true);
});

test('sound disabled, toggles, stale arrivals and missing IDs never produce backlog', async t => {
  const s = await setup(t, { enabled: false }), old = await s.question();
  assert.equal((await s.call('notifications.sound.claim', { id: old })).reason, 'disabled');
  await s.call('notifications.sound.setEnabled', { enabled: true });
  assert.equal((await s.call('notifications.sound.claim', { id: old })).reason, 'claimed');
  const stale = await s.question('stale'); s.advance(10001);
  assert.equal((await s.call('notifications.sound.claim', { id: stale })).reason, 'expired');
  assert.equal((await s.call('notifications.sound.claim', { id: 'invented' })).reason, 'missing');
  assert.equal(s.harness.inspection.sdk.callsTo('threads.markRead').length, 0);
});

test('startup recovery and old live interactions restore history without audio signals', async t => {
  const s = await setup(t);
  s.threads[0].hasPendingInteraction = true;
  s.interactions.set('a', [{ id: 'old', threadId: 'a', status: 'pending', createdAt: Date.now() - 100,
    payload: { kind: 'user_question', questions: [] } }]);
  const service = s.harness.behavior.runService('notification-recovery'); await service.done;
  await s.harness.behavior.emitThreadEvent('interaction.pending', { thread: s.threads[0], interaction: s.interactions.get('a')[0] });
  assert.equal((await s.call('notifications.list')).notices.length, 1);
  assert.equal(s.signals().length, 0);
});

test('available system notification wins across clients, but derivation has its own signal and presence expires', async t => {
  const s = await setup(t, { push: true, preferSystem: true });
  await s.call('notifications.sound.presence', { clientId: 'desktop-with-permission', systemChannel: 'desktop' });
  const id = await s.question();
  assert.equal((await s.call('notifications.sound.claim', { id })).reason, 'system');
  assert.equal(s.harness.inspection.sdk.callsTo('plugins.callRpc').length, 1);
  await s.call('notifications.sound.contribute', { id: 'derivation:test:1' });
  await s.call('notifications.sound.contribute', { id: 'derivation:test:1' });
  assert.equal(s.signals().length, 2);
  assert.equal((await s.call('notifications.sound.claim', { id: 'derivation:test:1' })).play, true);
  s.advance(46000);
  const next = await s.question('after-close');
  assert.equal((await s.call('notifications.sound.claim', { id: next })).play, true);
});

test('a push channel that skips completed turns does not suppress the bell completion sound', async t => {
  const s = await setup(t, { push: true, preferSystem: true }); s.preference('input-only');
  await s.call('notifications.sound.presence', { clientId: 'browser', systemChannel: 'web' });
  s.events.set('a', [{ id: 'turn-one', seq: 1, threadId: 'a', type: 'turn/completed', createdAt: Date.now() + 1, data: { status: 'completed' } }]);
  await s.harness.behavior.emitThreadEvent('experimental_thread.events', { thread: s.threads[0], sequence: 1 });
  assert.deepEqual(await s.call('notifications.sound.claim', { id: 'completed:a:turn-one' }), { play: true, reason: 'play' });
});

test('ordinary completion and question sound by default even when a system-capable client and push channels exist', async t => {
  const s = await setup(t, { push: true });
  await s.call('notifications.sound.presence', { clientId: 'browser-with-notification-permission', systemChannel: 'web' });
  s.events.set('a', [{ id: 'ordinary-completed', seq: 1, threadId: 'a', type: 'turn/completed', createdAt: Date.now() + 1, data: { status: 'completed' } }]);
  await s.harness.behavior.emitThreadEvent('experimental_thread.events', { thread: s.threads[0], sequence: 1 });
  const completed = 'completed:a:ordinary-completed';
  assert.deepEqual(await s.call('notifications.sound.claim', { id: completed }), { play: true, reason: 'play' });
  s.advance(3100);
  const question = await s.question();
  assert.deepEqual(await s.call('notifications.sound.claim', { id: question }), { play: true, reason: 'play' });
  assert.equal(s.harness.inspection.sdk.callsTo('plugins.list').length, 0);
  assert.equal(s.harness.inspection.sdk.callsTo('plugins.callRpc').length, 0);
  assert.deepEqual(s.bb.storage.database().prepare('SELECT decision FROM sound_events WHERE id IN (?,?)').all(completed, question),
    [{ decision: 'play' }, { decision: 'play' }]);
});

test('system preference is explicit, recorded, and turning it off restores ordinary bell delivery', async t => {
  const s = await setup(t, { push: true, preferSystem: true });
  await s.call('notifications.sound.presence', { clientId: 'desktop', systemChannel: 'desktop' });
  const suppressed = await s.question();
  assert.equal((await s.call('notifications.sound.claim', { id: suppressed })).reason, 'system');
  assert.equal(s.bb.storage.database().prepare('SELECT decision FROM sound_events WHERE id=?').get(suppressed).decision, 'system');
  await s.harness.behavior.setSettings({ soundPreferSystem: false });
  const next = await s.question('after-preference-off');
  assert.deepEqual(await s.call('notifications.sound.claim', { id: next }), { play: true, reason: 'play' });
});

test('a chat read while system policy is loading cancels the pending claim', async t => {
  const s = await setup(t, { push: true, preferSystem: true });
  await s.call('notifications.sound.presence', { clientId: 'browser', systemChannel: 'web' });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  s.harness.sdk.stub('plugins.getSettings', async () => { entered(); await new Promise(resolve => { release = resolve; });
    return { values: { webEnabled: false, desktopEnabled: false } }; });
  const id = await s.question(), pending = s.call('notifications.sound.claim', { id });
  await waiting;
  await s.call('notifications.dismiss', { id }); release();
  assert.equal((await pending).play, false);
});

test('a live error signals once; restoring a completed turn during startup stays silent', async t => {
  const s = await setup(t);
  await s.harness.behavior.emitThreadEvent('thread.failed', { thread: s.threads[0], lastAssistantText: 'Failure' });
  await s.harness.behavior.emitThreadEvent('thread.failed', { thread: s.threads[0], lastAssistantText: 'Failure' });
  assert.equal(s.signals().length, 1);
  assert.equal((await s.call('notifications.sound.claim', { id: `error:a:${s.threads[0].updatedAt}` })).play, true);
  s.events.set('b', [{ id: 'recovered', seq: 1, threadId: 'b', type: 'turn/completed', createdAt: Date.now() + 1, data: { status: 'completed' } }]);
  const service = s.harness.behavior.runService('notification-recovery'); await service.done;
  assert.equal((await s.call('notifications.list')).notices.length, 1);
  assert.equal(s.signals().length, 1);
});

test('hiding or reading a legacy error and clearing contributions cancel their pending sound', async t => {
  const s = await setup(t);
  const failed = async () => s.harness.behavior.emitThreadEvent('thread.failed', { thread: s.threads[0], lastAssistantText: 'Failure' });
  await failed();
  await s.call('notifications.dismissLegacy', { threadId: 'a' });
  assert.equal((await s.call('notifications.sound.claim', { id: `error:a:${s.threads[0].updatedAt}` })).play, false);
  await s.harness.behavior.emitThreadEvent('thread.active', { thread: s.threads[0] });
  s.threads[0].updatedAt += 1;
  await failed(); s.threads[0].lastReadAt = Date.now() + 100;
  await s.harness.behavior.emitThreadEvent('experimental_thread.read', { thread: s.threads[0] });
  assert.equal((await s.call('notifications.sound.claim', { id: `error:a:${s.threads[0].updatedAt}` })).play, false);
  await s.call('notifications.sound.contribute', { id: 'derivation:clear-pending' });
  await s.call('notifications.dismissAll', { legacyThreadIds: [] });
  assert.equal((await s.call('notifications.sound.claim', { id: 'derivation:clear-pending' })).reason, 'claimed');
});

test('audio never schedules before activation; a running context schedules two short tones and disposes all nodes', async () => {
  const states = [], starts = [], stops = [], disconnected = [];
  const contexts = [];
  class Context {
    state = 'suspended'; currentTime = 5; destination = {};
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, disconnect() { disconnected.push('oscillator'); },
      start(at) { starts.push(at); }, stop(at) { stops.push(at); } }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, disconnect() { disconnected.push('gain'); } }; }
  }
  globalThis.window = { AudioContext: Context };
  const audio = createNotificationAudio(state => states.push(state));
  await audio.unlock(); assert.equal(audio.play(), false); assert.equal(starts.length, 0);
  contexts[0].state = 'running'; contexts[0].onstatechange();
  assert.equal(audio.play(), true); assert.deepEqual(starts, [5, 5.12]);
  assert.ok(stops.every(at => at < 5.4));
  audio.stop(); assert.equal(disconnected.length, 4);
  audio.dispose(); assert.equal(contexts[0].state, 'closed'); assert.equal(audio.play(), false);
  assert.ok(states.includes('blocked')); assert.ok(states.includes('ready'));
});
