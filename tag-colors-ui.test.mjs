import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
await build({ entryPoints: ['tag-colors-ui.tsx'], outfile: 'dist/tag-colors-ui-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm' });
const { CardTagDots, TagColorsProvider, TagColorEditor } = await import('./dist/tag-colors-ui-test.mjs');
const React = await import('react');
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { act, cleanup, fireEvent, waitFor } = await import('@testing-library/react');
function Fixture({ tags = [] }) {
  return React.createElement(TagColorsProvider, null, React.createElement(CardTagDots, { tags }));
}

test('dots group tags by color, preserving all names and the first color order', async t => {
  const slot = renderSlot({ component: Fixture }, {}, { rpc: { tagColorsRead: () => [
    { tag: 'Yellow', color: '#FACC15' }, { tag: 'Orange', color: '#f97316' },
  ] } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  assert.equal(document.querySelector('.kb-card-tag-dots'), null);
  act(() => slot.lifecycle.rerender(React.createElement(Fixture, { tags: ['Test', 'Yellow', 'Orange'] })));
  await waitFor(() => {
    assert.equal(document.querySelectorAll('.kb-card-tag-dot').length, 2);
    assert.equal(document.querySelector('.kb-card-tag-dot').title, 'Test, Yellow');
  });
  const dots = [...document.querySelectorAll('.kb-card-tag-dot')];
  assert.deepEqual(dots.map(dot => dot.title), ['Test, Yellow', 'Orange']);
  assert.deepEqual(dots.map(dot => dot.getAttribute('aria-label')), ['Test, Yellow', 'Orange']);
  assert.equal(dots[0].style.backgroundColor, 'rgb(250, 204, 21)');
  act(() => slot.lifecycle.rerender(React.createElement(Fixture, { tags: ['First', 'Second'] })));
  assert.equal(document.querySelectorAll('.kb-card-tag-dot').length, 1);
  assert.equal(document.querySelector('.kb-card-tag-dot').title, 'First, Second');
  act(() => slot.lifecycle.rerender(React.createElement(Fixture)));
  assert.equal(document.querySelector('.kb-card-tag-dots'), null);
});

test('color editor saves shared colors, keeps failures retryable and updates the board', async t => {
  let saved = { Yellow: '#facc15', Orange: '#f97316' }, fail = true;
  const saves = [];
  function EditorFixture() {
    return React.createElement(React.Fragment, null,
      React.createElement(Fixture, { tags: ['Test', 'Yellow', 'Orange'] }),
      React.createElement(TagColorEditor, { tags: ['Yellow', 'Orange'] }));
  }
  const slot = renderSlot({ component: EditorFixture }, {}, { rpc: {
    tagColorsRead: () => Object.entries(saved).map(([tag, color]) => ({ tag, color })),
    tagColorsSave: changes => {
      if (fail) throw new Error('offline');
      saves.push(changes);
      saved = { ...saved, ...Object.fromEntries(changes.map(({ tag, color }) => [tag, color])) };
      return Object.entries(saved).map(([tag, color]) => ({ tag, color }));
    },
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await waitFor(() => assert.equal(slot.getByLabelText('Цвет тега Orange').disabled, false));
  const dots = () => [...document.querySelectorAll('.kb-card-tag-dot')];
  await waitFor(() => assert.equal(dots().length, 2));
  await waitFor(() => assert.equal(dots()[1].style.backgroundColor, 'rgb(249, 115, 22)'));
  assert.equal(dots()[0].title, 'Test, Yellow');
  act(() => fireEvent.change(slot.getByLabelText('Цвет тега Orange'), { target: { value: '#facc15' } }));
  await act(async () => fireEvent.click(slot.getByText('Сохранить цвета')));
  await waitFor(() => assert.match(slot.getByRole('alert').textContent, /Не удалось сохранить/));
  assert.equal(slot.getByLabelText('Цвет тега Orange').value, '#facc15');
  fail = false;
  await act(async () => fireEvent.click(slot.getByText('Сохранить цвета')));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.deepEqual(saves[0], [{ tag: 'Orange', color: '#facc15' }]);
  // A fresh board query sees the persisted value as another open board does.
  act(() => slot.lifecycle.rerender(React.createElement(EditorFixture, { key: 'fresh' })));
  await waitFor(() => assert.equal(dots().length, 1));
  assert.equal(dots()[0].title, 'Test, Yellow, Orange');
  act(() => fireEvent.change(slot.getByLabelText('Цвет тега Orange'), { target: { value: '#a855f7' } }));
  await act(async () => fireEvent.click(slot.getByText('Сохранить цвета')));
  await waitFor(() => assert.equal(saves.length, 2));
  act(() => slot.lifecycle.rerender(React.createElement(EditorFixture, { key: 'split' })));
  await waitFor(() => assert.equal(dots().length, 2));
  await waitFor(() => assert.equal(dots()[1].style.backgroundColor, 'rgb(168, 85, 247)'));
  assert.deepEqual(dots().map(dot => dot.title), ['Test, Yellow', 'Orange']);
});
