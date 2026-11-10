import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<!doctype html><body></body>', {url:'http://localhost'});
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver'])
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
await build({stdin:{contents:`export { usePanelState, usePanelScroll, forgetPanelState } from './panel-view-state';
  export { SectionContext } from './panel-section-ui';`,resolveDir:process.cwd(),loader:'ts'},
  outfile:'dist/panel-view-state-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const {usePanelState,usePanelScroll,forgetPanelState,SectionContext}=await import('./dist/panel-view-state-test.mjs');
const React=await import('react'); const {render,act,cleanup}=await import('@testing-library/react');
const h=React.createElement;

test('native tab remount restores each section independently, including Map state; closing releases it', () => {
  let update;
  function View() {
    const [value,setValue]=usePanelState('view',()=>({tab:'chat',comments:new Map()})); update=setValue;
    return h('output',null,value.tab+':'+value.comments.size);
  }
  const mount=id=>render(h(SectionContext.Provider,{value:id},h(View)));
  const a=crypto.randomUUID(),b=crypto.randomUUID();
  let screen=mount(a); act(()=>update({tab:'changes',comments:new Map([['file','draft']])})); screen.unmount();
  screen=mount(b); assert.equal(screen.container.textContent,'chat:0'); screen.unmount();
  screen=mount(a); assert.equal(screen.container.textContent,'changes:1'); screen.unmount();
  forgetPanelState(a); screen=mount(a); assert.equal(screen.container.textContent,'chat:0'); cleanup();
});
test('plugin-owned scroll returns after unmount and waits for loading content instead of losing its offset', async () => {
  const scope=crypto.randomUUID(); let limit=1000;
  function View() {
    const root=React.useRef(null); usePanelScroll(root,scope);
    return h('div',{ref:root},h('div',{'data-kanban-scroll':'content',ref:element=>{
      if (!element) return;
      let top=0; Object.defineProperty(element,'scrollTop',{configurable:true,get:()=>top,set:value=>{top=Math.min(value,limit);}});
    }}));
  }
  let screen=render(h(View)),element=screen.container.querySelector('[data-kanban-scroll]');
  element.scrollTop=350; element.dispatchEvent(new dom.window.Event('scroll')); screen.unmount();
  limit=10; screen=render(h(View)); element=screen.container.querySelector('[data-kanban-scroll]');
  assert.equal(element.scrollTop,10);
  limit=1000;
  await act(async()=>{element.append(document.createElement('span'));});
  assert.equal(element.scrollTop,350); cleanup();
});
