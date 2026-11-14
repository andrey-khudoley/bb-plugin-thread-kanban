import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
await build({ stdin: { contents: `export * from './card-work-time'; export { registerCardActivity } from './card-activity-server';`,
  resolveDir: process.cwd(), loader: 'ts' }, outfile: 'dist/card-work-time-server-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { registerCardActivity, cardWorkStartedAt, formatWorkDuration, workStartedAt } = await import('./dist/card-work-time-server-test.mjs');
const row = (seq, type, data = {}) => ({ seq, type, createdAt: seq * 1000, data });

test('duration handles minute/hour/day boundaries and clock skew', () => {
  for (const [seconds, label] of [[0, '00:00'], [9, '00:09'], [59, '00:59'], [60, '01:00'],
    [754, '12:34'], [3599, '59:59'], [3600, '1:00:00'], [3661, '1:01:01'], [90061, '25:01:01']])
    assert.equal(formatWorkDuration(1000, 1000 + seconds * 1000 + 999), label);
  assert.equal(formatWorkDuration(2000, 1000), '00:00');
});

test('native requests and starts preserve a continuous run; completion, stop and retry delimit it', () => {
  const first = [row(1, 'client/turn/requested'), row(2, 'turn/started'),
    row(3, 'client/turn/requested', { target: { kind: 'steer' } }), row(4, 'turn/started')];
  assert.equal(workStartedAt(first.reverse()), 1000);
  assert.equal(workStartedAt([...first, row(5, 'turn/completed')]), null);
  assert.equal(workStartedAt([...first, row(5, 'system/thread/interrupted')]), null);
  assert.equal(workStartedAt([...first, row(5, 'turn/completed'), row(6, 'client/turn/requested'), row(7, 'turn/started')]), 6000);
  assert.equal(workStartedAt([row(5, 'turn/completed'), row(6, 'client/turn/requested', { target: { kind: 'steer' } })]), null);
});

test('linked chat selection excludes finished and archived chats and does not depend on order', () => {
  const chat = (id, changes = {}) => ({ id, runtimeStatus: 'active', status: 'active', queuedWork: 'none',
    isArchived: false, hasPendingInteraction: false, updatedAt: 1, activity: {}, ...changes });
  const samples = { a: { startedAt: 1000 }, b: { startedAt: 2000 }, c: { startedAt: 500 } };
  assert.equal(cardWorkStartedAt([chat('b'), chat('a'), chat('c', { isArchived: true })], samples), 1000);
  assert.equal(cardWorkStartedAt([chat('a', { runtimeStatus: 'idle' })], samples), null);
  assert.equal(cardWorkStartedAt([chat('b', { hasPendingInteraction: true })], samples), 2000);
});

test('RPC recovers old starts through filtered pagination, survives reconnect, and resets on a new run', async t => {
  let events = [row(1, 'turn/completed'), row(2, 'client/turn/requested'), row(3, 'turn/started'),
    ...Array.from({ length: 120 }, (_, i) => row(i + 4, 'client/turn/requested', { target: { kind: 'steer' } }))];
  let active = true;
  const calls = [];
  const host = createFakePluginHost({ sdk: { threads: {
    list: async () => [{ ...makeThreadResponse({ id: 'a', status: active ? 'active' : 'idle', runtime: { displayStatus: active ? 'active' : 'idle' } }),
      queuedWork: 'none', activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0 } }],
    events: { list: async args => {
      calls.push(args);
      return events.filter(event => args.types.includes(event.type) && (!args.beforeSeq || event.seq < Number(args.beforeSeq)))
        .sort((a, b) => b.seq - a.seq).slice(0, Number(args.limit));
    } },
  } } });
  registerCardActivity(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  const read = () => host.harness.behavior.callRpc('cardActivities', { keys: ['a'] });
  assert.equal((await read()).a.startedAt, 2000);
  assert.ok(calls.some(call => call.beforeSeq), 'start is older than a page of lifecycle events');
  assert.equal((await read()).a.startedAt, 2000, 'a second observer sees the saved native start');
  active = false;
  assert.deepEqual(await read(), {});
  events.push(row(124, 'system/thread/interrupted'), row(125, 'client/turn/requested'), row(126, 'turn/started'));
  active = true;
  assert.equal((await read()).a.startedAt, 125000);
});
