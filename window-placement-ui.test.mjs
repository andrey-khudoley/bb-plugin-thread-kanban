import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><body></body>', {url:'http://localhost',pretendToBeVisual:true});
for (const key of ['window','document','navigator','HTMLElement','Element','Node','localStorage']) {
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
}
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, act, cleanup } = await import('@testing-library/react');
await build({stdin:{contents:`export { WindowPlacementBridge } from './window-placement-ui';
  export { prepareKanbanPanel } from './window-placement';`,resolveDir:process.cwd(),loader:'tsx'},
  outfile:'dist/window-placement-ui-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic'});
const {WindowPlacementBridge,prepareKanbanPanel} = await import('./dist/window-placement-ui-test.mjs');

test('a server selection applies on the next opening, including with another controller wrapper and the same selected tab', async t => {
  const host=document.createElement('div');
  host.innerHTML=`<div data-panel-group><div data-panel-id="plugin-panel-main-pane-1"><main></main></div>
    <div role="separator" data-panel-resize-handle-id="native"></div><div data-panel-id="thread-detail-secondary-panel"></div></div>`;
  document.body.append(host);
  const root=host.querySelector('main'), group=host.firstElementChild;
  const tabs={open:true,selectedKey:'tab',tabs:[{key:'tab',title:'Chat',status:null,closable:true,detail:{kind:'new-tab'}}]};
  let saved='below';
  const slot=renderSlot({component:WindowPlacementBridge},{surface:{current:root}}, {
    experimental_panelTabs:tabs,
    rpc:{readPaneHeaders:()=>({top:false,bottom:true}),readWindowPlacement:()=>saved},
  });
  t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  await waitFor(()=>assert.equal(group.dataset.kanbanWindowPlacement,'below'));
  saved='above';
  await act(async()=>new Promise(r=>setTimeout(r,50)));
  assert.equal(group.dataset.kanbanWindowPlacement,'below','saving alone must not rearrange');
  await act(async()=>prepareKanbanPanel({getTabs:()=>tabs}));
  await waitFor(()=>assert.equal(group.dataset.kanbanWindowPlacement,'above'));
  saved='right';
  await act(async()=>prepareKanbanPanel({getTabs:()=>tabs}));
  await waitFor(()=>assert.equal(group.dataset.kanbanWindowPlacement,'right'));
  slot.lifecycle.unmount();
  assert.equal(group.hasAttribute('data-kanban-window-placement'),false);
});
