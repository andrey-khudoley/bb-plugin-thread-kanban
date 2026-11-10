import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver',
  'CustomEvent', 'Event', 'getComputedStyle', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { default: userEvent } = await import('@testing-library/user-event');
const { cleanup, waitFor, within } = await import('@testing-library/react');
await build({ entryPoints: ['app.tsx'], outfile: 'dist/mobile-headers-test.mjs', bundle: true, packages: 'external',
  platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' } });
const app = await loadPluginApp(() => import('./dist/mobile-headers-test.mjs'));
await build({ entryPoints: ['mobile-stage-navigation.tsx'], outfile: 'dist/mobile-stage-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { MobileStageNavigation } = await import('./dist/mobile-stage-test.mjs');
const React = await import('react');
const stages = [
  { id: 'backlog', label: 'Бэклог', count: 0, dot: '' },
  { id: 'todo', label: 'К выполнению', count: 2, dot: '' },
  { id: 'working', label: 'В работе', count: 3, dot: '' },
  { id: 'review', label: 'На проверке', count: 1, dot: '' },
  { id: 'done', label: 'Завершён', count: 12, dot: '' },
];

function mountStages(t, initial) {
  function Controlled() {
    const [value, onChange] = React.useState(initial);
    return React.createElement(MobileStageNavigation, { stages, value, onChange });
  }
  const slot = renderSlot({ component: Controlled }, {}, {});
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  return { slot, user: userEvent.setup({ document: dom.window.document }) };
}

test('mobile stage arrows switch adjacent stages and stop at the boundaries', async t => {
  const { slot, user } = mountStages(t, 'backlog');
  assert.equal(slot.getByRole('button', { name: 'Предыдущий этап', exact: true }).disabled, true);
  await user.click(slot.getByRole('button', { name: 'Следующий этап: К выполнению' }));
  assert.ok(slot.getByRole('button', { name: 'Этап доски: К выполнению, карточек 2' }));
  await user.click(slot.getByRole('button', { name: 'Предыдущий этап: Бэклог' }));
  assert.ok(slot.getByRole('button', { name: 'Этап доски: Бэклог, карточек 0' }));
});

test('mobile stage menu shows all counts, marks the current stage and restores focus', async t => {
  const { slot, user } = mountStages(t, 'working');
  await user.click(slot.getByRole('button', { name: 'Этап доски: В работе, карточек 3' }));
  const menu = await slot.findByRole('menu');
  assert.equal(within(menu).getAllByRole('menuitemradio').length, 5);
  assert.equal(within(menu).getByRole('menuitemradio', { name: /В работе/ }).getAttribute('aria-checked'), 'true');
  assert.equal(within(menu).getByRole('menuitemradio', { name: /Бэклог/ }).textContent, 'Бэклог0');
  await user.click(within(menu).getByRole('menuitemradio', { name: /Завершён/ }));
  const trigger = slot.getByRole('button', { name: 'Этап доски: Завершён, карточек 12' });
  assert.equal(slot.queryByRole('menu'), null);
  assert.equal(slot.getByRole('button', { name: 'Следующий этап', exact: true }).disabled, true);
  await waitFor(() => assert.equal(document.activeElement, trigger));
  await user.click(trigger);
  await slot.findByRole('menu');
  await user.keyboard('{Escape}');
  await waitFor(() => assert.equal(slot.queryByRole('menu'), null));
  assert.ok(slot.getByRole('button', { name: 'Этап доски: Завершён, карточек 12' }));
});

function mount(t) {
  sessionStorage.clear(); localStorage.clear();
  const slot = renderSlot(app.navPanels[0], { subPath: '' }, {
    sidebarThreads: { status: 'ready', projects: [{ id: 'proj_qa', name: 'Test' }], threads: [] },
    rpc: { issueList: () => [], archiveParents: () => ({}), projectOrder: () => [], projectPersonalGroups: () => [],
      derivationList: () => [], worktreeStates: () => ({}) },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  return { slot, user: userEvent.setup({ document: dom.window.document }) };
}

test('mobile board actions retain view switching, selection and merge navigation', async t => {
  const { slot, user } = mount(t);
  await user.click(await slot.findByRole('button', { name: 'Действия доски · Доска' }));
  await user.click(await slot.findByRole('menuitem', { name: 'Список', exact: true }));
  assert.equal(slot.getByRole('button', { name: 'Список', exact: true }).getAttribute('aria-pressed'), 'true');
  await user.click(slot.getByRole('button', { name: 'Действия доски · Список' }));
  await user.click(await slot.findByRole('menuitem', { name: 'Выбрать задачи' }));
  assert.ok(slot.getByRole('group', { name: 'Действия с выбранными карточками' }));
  await user.click(slot.getByRole('button', { name: 'Выйти из выбора' }));
  await user.click(slot.getByRole('button', { name: 'Действия доски · Список' }));
  await user.click(await slot.findByRole('menuitem', { name: 'Слияния' }));
  assert.deepEqual(slot.inspection.navigateCalls.at(-1), { method: 'toPluginPanel', path: 'board', options: { subPath: 'merges' } });
});

test('search and active restrictions remain identifiable after closing mobile tools', async t => {
  const { slot, user } = mount(t);
  await user.click(await slot.findByRole('button', { name: 'Поиск и фильтры', exact: true }));
  await user.type(document.querySelector('.kb-mobile-search input'), 'длинное название');
  await user.selectOptions(slot.getByRole('combobox', { name: 'Приоритет', exact: true }), 'high');
  await user.click(slot.getByRole('button', { name: 'Закрыть фильтры' }));
  const trigger = slot.getByRole('button', { name: /Поиск и фильтры: Поиск: длинное название.*Приоритет/ });
  assert.match(trigger.textContent, /длинное название/);
  assert.equal(trigger.querySelector('.kb-badge').textContent, '2');
  await user.click(trigger);
  await user.click(within(document.querySelector('.kb-filter-popover')).getByRole('button', { name: 'Сбросить фильтры' }));
  await user.click(slot.getByRole('button', { name: 'Закрыть фильтры' }));
  await waitFor(() => assert.ok(slot.getByRole('button', { name: 'Поиск и фильтры', exact: true })));
});
