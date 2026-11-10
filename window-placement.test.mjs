import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
await build({stdin:{contents:`export { createWindowPlacementLayout } from './window-placement-layout';
  export { onKanbanPanelOpen, prepareKanbanPanel } from './window-placement';`,resolveDir:process.cwd(),loader:'ts'},
  outfile:'dist/window-placement-layout-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const { createWindowPlacementLayout, onKanbanPanelOpen, prepareKanbanPanel } = await import('./dist/window-placement-layout-test.mjs');

test('opening applies only to its owning Kanban surface and unsubscribes on navigation', () => {
  const snapshot = key => ({selectedKey:key,tabs:[{key}]});
  const boardA = {getTabs:()=>snapshot('a')}, boardB = {getTabs:()=>snapshot('b')}, outside = {getTabs:()=>snapshot('outside')};
  let a=0,b=0;
  const closeA = onKanbanPanelOpen(boardA,()=>a++);
  const closeB = onKanbanPanelOpen(boardB,()=>b++);
  // Another hook instance for the same native panel must also match.
  prepareKanbanPanel({getTabs:()=>snapshot('a')});
  assert.deepEqual([a,b],[1,0]);
  prepareKanbanPanel(outside);
  assert.deepEqual([a,b],[1,0]);
  closeA(); prepareKanbanPanel(boardA);
  prepareKanbanPanel(boardB);
  assert.deepEqual([a,b],[1,1]); closeB();
});

function fixture(t) {
  const dom = new JSDOM(`<div data-panel-group>
    <div data-panel-id="plugin-panel-main-pane-1"><div><header>Board header</header><div data-pane-content><main data-kanban-board-surface></main><footer class="kb-activity-bar">Board activity</footer></div></div></div>
    <div role="separator" aria-label="Resize thread and right panel" tabindex="-1" data-panel-resize-handle-id="native"></div>
    <div data-panel-id="thread-detail-secondary-panel"><aside><div><div><div data-testid="thread-secondary-panel-top-chrome">Native tabs</div></div><div><section class="kb-detail"><header>Card header</header><div data-panel-group><div data-tab-pill>Existing tab</div></div><footer class="kb-activity-bar">Chat activity</footer></section></div></div></aside></div>
    </div>`, { url: 'http://localhost' });
  for (const key of ['document','HTMLElement','Element','localStorage']) Object.defineProperty(globalThis, key, {configurable:true,value:dom.window[key]});
  const surface = document.querySelector('main');
  const group = surface.closest('[data-panel-group]');
  const handle = group.children[1];
  const tab = group.querySelector('[data-tab-pill]');
  const adapter = createWindowPlacementLayout(surface);
  t.after(() => { adapter?.dispose(); dom.window.close(); });
  return {dom,group,handle,tab,adapter};
}

test('all placements reuse the same native panels and tabs, then restore native chrome', t => {
  const {group,handle,tab,adapter} = fixture(t);
  const panels = [...group.children];
  for (const mode of ['right','below','above','below','right']) {
    adapter.apply(mode, true);
    assert.equal(group.dataset.kanbanWindowPlacement, mode);
    assert.deepEqual([...group.children], panels);
    assert.equal(group.querySelector('[data-tab-pill]'), tab);
    assert.equal(group.querySelectorAll('[data-panel-group]').length, 1);
    assert.equal(group.querySelector('[data-panel-group]').hasAttribute('data-kanban-window-placement'), false);
  }
  assert.equal(handle.getAttribute('tabindex'), '-1');
  assert.equal(handle.getAttribute('aria-orientation'), null);
  adapter.dispose();
  assert.equal(group.hasAttribute('data-kanban-window-placement'),false);
  assert.equal(handle.getAttribute('aria-label'),'Resize thread and right panel');
});

test('vertical resizing uses the vertical axis, keyboard and persistence; right stays native', t => {
  const {dom,group,handle,adapter} = fixture(t);
  group.getBoundingClientRect = () => ({top:100,height:600});
  adapter.apply('below',true);
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  assert.equal(handle.getAttribute('aria-valuenow'),'55');
  adapter.apply('above',true);
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  assert.equal(handle.getAttribute('aria-valuenow'),'50');
  const pointer = (type, y) => {
    const e = new dom.window.MouseEvent(type,{button:0,clientY:y,bubbles:true,cancelable:true});
    Object.defineProperty(e,'pointerId',{value:1}); return e;
  };
  const nativeCapture = event => event.stopImmediatePropagation();
  document.addEventListener('pointerdown',nativeCapture,true);
  document.addEventListener('pointermove',nativeCapture,true);
  document.addEventListener('pointerup',nativeCapture,true);
  handle.dispatchEvent(pointer('pointerdown',400));
  document.dispatchEvent(pointer('pointermove',250));
  document.dispatchEvent(pointer('pointerup',250));
  assert.equal(handle.getAttribute('aria-valuenow'),'75');
  assert.equal(localStorage.getItem('thread-kanban:vertical-panel-share'),'75');
  document.removeEventListener('pointerdown',nativeCapture,true);
  document.removeEventListener('pointermove',nativeCapture,true);
  document.removeEventListener('pointerup',nativeCapture,true);
  adapter.dispose();
  const reopened = createWindowPlacementLayout(group.querySelector('main'));
  reopened.apply('below',true);
  assert.equal(handle.getAttribute('aria-valuenow'),'75');
  reopened.apply('right',true);
  const nativeKey = new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});
  handle.dispatchEvent(nativeKey);
  assert.equal(nativeKey.defaultPrevented,false);
  reopened.dispose();
});

test('other application surfaces and unrecognised markup are left intact', t => {
  const {group} = fixture(t);
  group.firstElementChild.dataset.panelId = 'thread-main';
  assert.equal(createWindowPlacementLayout(group.querySelector('main')),null);
  assert.equal(group.hasAttribute('data-kanban-window-placement'),false);
});

test('top and bottom headers toggle independently by pointer and keyboard and survive orientation changes and reopening', t => {
  const {group,tab,adapter,dom} = fixture(t);
  adapter.apply('below',true);
  const top=group.children[0], bottom=group.children[2];
  const upper=group.parentElement.querySelector('[data-kanban-chrome-toggle="top"]');
  const lower=group.parentElement.querySelector('[data-kanban-chrome-toggle="bottom"]');
  assert.equal(group.children[1].querySelector('button'),null,'controls must be outside the presentational separator');
  assert.equal(top.dataset.kanbanPanePosition,'top');
  assert.equal(bottom.dataset.kanbanPanePosition,'bottom');
  assert.equal(top.dataset.kanbanHeaderSide,'top');
  assert.equal(bottom.dataset.kanbanHeaderSide,'right');
  assert.equal(upper.getAttribute('aria-pressed'),'false');
  const nativePointerCapture = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  document.addEventListener('pointerdown',nativePointerCapture,true);
  upper.dispatchEvent(new dom.window.MouseEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(top.dataset.kanbanPaneCompact,'true');
  assert.equal(bottom.dataset.kanbanPaneCompact,'false');
  upper.dispatchEvent(new dom.window.MouseEvent('click',{button:0,detail:1,bubbles:true}));
  assert.equal(top.dataset.kanbanPaneCompact,'true','compatibility click must not toggle twice');
  upper.dispatchEvent(new dom.window.MouseEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));
  assert.equal(top.dataset.kanbanPaneCompact,'false');
  document.removeEventListener('pointerdown',nativePointerCapture,true);
  const nativeKeyCapture = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  document.addEventListener('keydown',nativeKeyCapture,true);
  lower.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.equal(bottom.dataset.kanbanPaneCompact,'true');
  assert.equal(top.dataset.kanbanPaneCompact,'false');
  assert.equal(lower.textContent,'Нижняя: показать');
  assert.equal(group.querySelector('[data-tab-pill]'),tab);
  lower.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
  assert.equal(bottom.dataset.kanbanPaneCompact,'false');
  document.removeEventListener('keydown',nativeKeyCapture,true);
  lower.click();
  adapter.apply('above',true);
  assert.equal(top.dataset.kanbanPanePosition,'bottom');
  assert.equal(top.dataset.kanbanPaneCompact,'true');
  assert.equal(bottom.dataset.kanbanPanePosition,'top');
  assert.equal(bottom.dataset.kanbanPaneCompact,'false');
  adapter.apply('right',true);
  assert.equal(top.hasAttribute('data-kanban-pane-position'),false);
  assert.equal(bottom.hasAttribute('data-kanban-pane-position'),false);
  adapter.dispose();
  assert.equal(group.parentElement.querySelector('[data-kanban-split-controls]'),null);
  assert.equal(group.querySelector('[data-kanban-service-chrome]'),null);
  const reopened=createWindowPlacementLayout(group.querySelector('main'));
  reopened.apply('below',true,{top:true,bottom:false});
  assert.equal(top.dataset.kanbanPaneCompact,'false');
  assert.equal(bottom.dataset.kanbanPaneCompact,'true');
  assert.equal(top.dataset.kanbanHeaderSide,'right');
  assert.equal(bottom.dataset.kanbanHeaderSide,'top');
  reopened.dispose();
});

test('the previous combined preference migrates to both physical panes', t => {
  const {group,adapter}=fixture(t); adapter.dispose();
  localStorage.setItem('thread-kanban:compact-split-chrome','true');
  const reopened=createWindowPlacementLayout(group.querySelector('main')); reopened.apply('above',true);
  assert.equal(group.children[0].dataset.kanbanPaneCompact,'true');
  assert.equal(group.children[2].dataset.kanbanPaneCompact,'true');
  group.parentElement.querySelector('[data-kanban-chrome-toggle="top"]').click();
  assert.deepEqual(JSON.parse(localStorage.getItem('thread-kanban:split-pane-chrome:v2')),{top:false,bottom:true});
  reopened.dispose();
});
