import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFromEvents, cardPresentation, toolActivity } from './card-activity.ts';

const row = (seq, type, data = {}) => ({ seq, createdAt: seq * 1000, type, data });
const start = (seq, item) => row(seq, 'item/started', { item });
const finish = (seq, item) => row(seq, 'item/completed', { item });
const chat = (id = 'a', extra = {}) => ({ id, updatedAt: 0, isArchived: false, status: 'active', runtimeStatus: 'active', queuedWork: 'none',
  hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, ...extra });
const idle = chat('a', { status: 'idle', runtimeStatus: 'idle' });
const reading = { id: 'read', type: 'fileRead', path: 'private.txt', status: 'pending' };

test('reasoning → read → write → reply → completion follows actual item lifetimes', () => {
  const events = [row(1, 'turn/started'), start(2, { id: 'think', type: 'reasoning' })];
  const label = () => activityFromEvents(events).label;
  assert.equal(label(), 'Думаю…');
  events.push(start(3, reading)); assert.equal(label(), 'Читаю содержимое файла');
  events.push(finish(4, reading)); assert.equal(label(), 'Думаю…');
  const write = { id: 'write', type: 'fileChange', changes: [{ kind: 'add', path: 'new.txt' }], status: 'pending' };
  events.push(start(5, write)); assert.equal(label(), 'Записываю новый файл');
  events.push(finish(6, write), finish(7, { id: 'think', type: 'reasoning' }), start(8, { id: 'reply', type: 'agentMessage' }));
  assert.equal(label(), 'Пишу ответ…');
  events.push(row(9, 'turn/completed', { status: 'completed' }));
  assert.deepEqual(activityFromEvents(events), { label: 'Работа завершена', seq: 9, at: 9000, phase: 'done' });
});

test('a late completion for another parallel tool cannot erase the running action', () => {
  const events = [start(1, reading), start(2, { id: 'search', type: 'search' }), finish(3, reading)];
  assert.equal(activityFromEvents(events).label, 'Ищу в файлах');
  assert.equal(activityFromEvents([...events, finish(4, { id: 'search' })]).label, 'Думаю…');
});

test('retries, interruption and a failed turn clear pending tools; replay is ordered', () => {
  const events = [start(1, reading), row(2, 'turn/completed', { status: 'failed' })];
  assert.equal(activityFromEvents(events).phase, 'error');
  events.push(row(3, 'client/turn/requested'));
  assert.equal(activityFromEvents(events).label, 'Думаю…');
  events.push(start(4, reading), row(5, 'system/thread/interrupted'));
  assert.equal(activityFromEvents(events.reverse()).label, 'Работа остановлена');
});

test('tool progress reclassifies a tool; nested reasoning and messages cannot hide a pending tool', () => {
  const events = [start(1, { id: 'tool', type: 'toolCall', tool: 'read_file', status: 'pending' }),
    start(2, { id: 'thought', type: 'reasoning' }), start(3, { id: 'message', type: 'agentMessage' })];
  assert.equal(activityFromEvents(events).label, 'Читаю содержимое файла');
  events.push(row(4, 'item/toolCall/progress', { item: { id: 'tool', type: 'toolCall', tool: 'write_file', status: 'pending' } }));
  assert.equal(activityFromEvents(events).label, 'Записываю новый файл');
});

test('the vocabulary never exposes tool names, secrets, user text or arbitrary tool descriptions', () => {
  for (const item of [{ type: 'extension', title: 'SECRET', presentation: { label: { pending: 'SECRET' } } },
    { type: 'toolCall', tool: 'private_customer_tool_SECRET', arguments: { token: 'SECRET' } },
    { type: 'reasoning', content: ['SECRET'] }]) assert.ok(!toolActivity(item).includes('SECRET'));
  assert.equal(toolActivity({ type: 'toolCall', tool: 'mcp__fs__read_file' }), 'Читаю содержимое файла');
  assert.equal(toolActivity({ type: 'commandExecution', command: 'Get-Content secret.txt' }), 'Читаю содержимое файла');
  assert.equal(toolActivity({ type: 'commandExecution', command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content private.txt"' }), 'Читаю содержимое файла');
  assert.equal(toolActivity({ type: 'commandExecution', command: 'Get-Content x; Set-Content y z' }), 'Выполняю команду');
  assert.equal(toolActivity({ type: 'commandExecution', command: 'npm test' }), 'Проверяю изменения');
  assert.equal(toolActivity({ type: 'commandExecution', command: 'New-Item -ItemType File -Path new.txt' }), 'Записываю новый файл');
  assert.equal(toolActivity({ type: 'commandExecution', command: 'Set-Content existing.txt value' }), 'Записываю файл');
  assert.equal(toolActivity({ type: 'fileChange', changes: [{ kind: 'update' }] }), 'Изменяю файлы');
});

test('current lifecycle overrides stale read samples immediately, including offline and archived chats', () => {
  const samples = { a: activityFromEvents([start(1, reading)]) };
  assert.equal(cardPresentation([chat()], samples).label, 'Читаю содержимое файла');
  assert.equal(cardPresentation([idle], samples).label, 'Работа завершена');
  assert.equal(cardPresentation([chat('a', { hasPendingInteraction: true })], samples).state, 'waiting');
  assert.equal(cardPresentation([chat('a', { runtimeStatus: 'waiting-for-host' })], samples).label, 'Ожидаю подключения машины');
  assert.equal(cardPresentation([chat('a', { isArchived: true })], samples).state, 'done');
  assert.equal(cardPresentation([chat('a', { status: 'error', runtimeStatus: 'error' })], samples).state, 'error');
  assert.equal(cardPresentation([chat('a', { status: 'error', runtimeStatus: 'error', isArchived: true })], samples).state, 'error');
});

test('completion and error events override a lagging active sidebar DTO', () => {
  const completed = activityFromEvents([row(5, 'turn/completed', { status: 'completed' })]);
  assert.equal(cardPresentation([chat()], { a: completed }).state, 'done');
  const failed = activityFromEvents([row(6, 'turn/completed', { status: 'failed' })]);
  assert.equal(cardPresentation([chat()], { a: failed }).state, 'error');
});

test('multiple linked chats choose current work and expose the count; waiting takes priority', () => {
  const failed = chat('old', { status: 'error', runtimeStatus: 'error' });
  const samples = { a: activityFromEvents([start(1, reading)]) };
  assert.equal(cardPresentation([failed, chat()], samples).state, 'working');
  assert.match(cardPresentation([chat(), chat('b')], samples).label, /ещё 1 чат/);
  assert.equal(cardPresentation([chat(), chat('b', { hasPendingInteraction: true })], samples).threadId, 'b');
});

test('chatless tasks, planning, dependencies and task errors have explicit resting states', () => {
  assert.equal(cardPresentation([], {}).state, 'idle');
  assert.equal(cardPresentation([], {}, { status: 'done' }).state, 'done');
  assert.equal(cardPresentation([], {}, { busy: 'planning' }).label, 'Готовлю план…');
  assert.equal(cardPresentation([], {}, { blocked: true }).state, 'waiting');
  assert.equal(cardPresentation([], {}, { error: 'Failure' }).hint, 'Failure');
  assert.equal(cardPresentation([], {}, { hasLinkedChats: true }).label, 'Получаю состояние чата…');
});
