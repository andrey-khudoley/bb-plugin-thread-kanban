import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
await build({ entryPoints: ['card-activity-server.ts'], outfile: 'dist/card-activity-server-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { registerCardActivity } = await import('./dist/card-activity-server-test.mjs');

test('activity RPC reads only requested running chats, returns human labels and disposes pending invalidations', async t => {
  const threads = [makeThreadResponse({ id: 'a', status: 'active', runtime: { displayStatus: 'active' } }),
    makeThreadResponse({ id: 'b' }), makeThreadResponse({ id: 'c', archivedAt: Date.now(), status: 'active', runtime: { displayStatus: 'active' } })]
    .map(thread => ({ ...thread, queuedWork: 'none', hasPendingInteraction: false,
      activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0 } }));
  const calls = [];
  const host = createFakePluginHost({ pluginId: 'thread-kanban', sdk: { threads: {
    list: async ({ threadIds }) => threads.filter(thread => threadIds.includes(thread.id)),
    events: { list: async args => { calls.push(args); return [{ seq: 1, createdAt: 1, type: 'item/started',
      data: { item: { id: 'one', type: 'fileRead', path: 'SECRET', status: 'pending' } } }]; } },
  } } });
  registerCardActivity(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  const rpc = keys => host.harness.behavior.callRpc('cardActivities', { keys });
  assert.deepEqual(await rpc([]), {});
  const result = await rpc(['a', 'b', 'c', 'a']);
  assert.deepEqual(Object.keys(result), ['a']);
  assert.equal(result.a.label, 'Читаю содержимое файла');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(calls.length, 2); assert.equal(calls[0].order, 'desc'); assert.equal(calls[0].limit, '100');
  assert.equal(result.a.startedAt, null, 'missing lifecycle evidence must not invent an observation-time start');
  const states = await host.harness.behavior.callRpc('cardThreadStates', { keys: ['a', 'b', 'c'] });
  assert.deepEqual(Object.keys(states).sort(), ['a', 'b', 'c']);
  assert.equal(states.c.isArchived, true);
  assert.equal(states.a.runtimeStatus, 'active');
  assert.equal(calls.length, 2, 'lifecycle reads must not fetch idle or archived event histories');
  await host.harness.behavior.emitThreadEvent('experimental_thread.events', { thread: threads[0], sequence: 1 });
  await host.harness.lifecycle.dispose();
});
