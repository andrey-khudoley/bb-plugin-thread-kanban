import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<!doctype html><body></body>', {url:'http://localhost',pretendToBeVisual:true});
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','MutationObserver','localStorage']) Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
const {renderSlot}=await import('@get-bb/plugin-sdk/testing/app');
const {fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');
await build({stdin:{contents:`export {ArtifactChrome} from './artifact-tabs'; export {sectionStore} from './panel-context'; export {artifactStore,artifactOwner} from './panel-artifacts';`,resolveDir:process.cwd(),loader:'tsx'},outfile:'dist/artifact-tabs-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic'});
const {ArtifactChrome,sectionStore,artifactStore,artifactOwner}=await import('./dist/artifact-tabs-test.mjs');
function fixture(t,count=10){
  const section=crypto.randomUUID(),mount=document.createElement('div');document.body.append(mount);
  sectionStore.replace(section,{kind:'chat',threadId:'chat-a',title:'A'});
  const native=Array.from({length:count},(_,i)=>({key:`file-${i}`,title:`Длинное название ${i}.md`,status:null,closable:true,detail:{kind:'file',path:`/docs/${i}.md`}}));
  const calls=[];let group={section,owner:artifactOwner(section,'chat:chat-a'),mainKey:'main',mount,native,selectedKey:'main'};
  const slot=renderSlot({component:ArtifactChrome},{groups:[group]},{sdk:{threads:{get:()=>({environmentId:null})}},experimental_panel:{selectTab:key=>(calls.push(['select',key]),true),closeTab:key=>(calls.push(['close',key]),true)}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();mount.remove();});
  return {slot,mount,section,native,calls,owner:artifactOwner(section,'chat:chat-a'),group};
}
test('ten long-named files remain accessible through the full-list search and select the actual native editor',async t=>{
  const f=fixture(t);
  assert.equal(f.mount.querySelectorAll('[data-artifact-key]').length,10);
  assert.equal(f.mount.querySelector('.kb-artifact-all'),null);
  fireEvent.click(f.mount.querySelector('.kb-artifact-caption'));
  assert.equal(f.mount.querySelector('.kb-artifact-caption').getAttribute('aria-expanded'),'true');
  assert.equal(f.mount.querySelector('[role=dialog]'),null);
  assert.equal(f.mount.querySelector('[role=region]').contains(f.mount.querySelector('input')),true);
  fireEvent.change(f.mount.querySelector('input'),{target:{value:'/docs/9.md'}});
  const buttons=f.mount.querySelectorAll('.kb-artifact-menu-item');assert.equal(buttons.length,1);
  fireEvent.click(buttons[0].querySelector('button'));
  assert.deepEqual(f.calls.at(-1),['select','file-9']);
  assert.equal(artifactStore.get(f.owner),'native:file-9');
  assert.equal(f.mount.querySelector('[aria-selected=true]').textContent.includes('9.md'),true);
});

test('Materials toggles the in-flow list, reports an empty search and Escape restores its trigger focus',async t=>{
  const f=fixture(t,2),trigger=f.mount.querySelector('.kb-artifact-caption');
  fireEvent.click(trigger);
  const search=f.mount.querySelector('input');
  fireEvent.change(search,{target:{value:'missing-file'}});
  assert.equal(f.mount.querySelectorAll('.kb-artifact-menu-item').length,0);
  assert.equal(f.mount.querySelector('.kb-artifact-empty').textContent,'Материалы не найдены');
  fireEvent.keyDown(search,{key:'Escape'});
  assert.equal(f.mount.querySelector('[role=region]'),null);
  assert.equal(document.activeElement,trigger);
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
});

test('wheel scrolls overflowing tabs in either direction without scrolling the chat or intercepting search, zoom and non-overflowing rows',async t=>{
  const f=fixture(t),strip=f.mount.querySelector('.kb-artifact-strip');
  Object.defineProperties(strip,{scrollWidth:{configurable:true,value:1000},clientWidth:{configurable:true,value:300},scrollLeft:{configurable:true,writable:true,value:0}});
  assert.equal(fireEvent.wheel(strip,{deltaY:100,cancelable:true}),false);
  assert.equal(strip.scrollLeft,100);
  fireEvent.wheel(f.mount.querySelector('.kb-artifact-caption'),{deltaY:-3,deltaMode:1,cancelable:true});
  assert.equal(strip.scrollLeft,52);
  fireEvent.wheel(strip,{deltaX:100,deltaY:2,cancelable:true});
  assert.equal(strip.scrollLeft,152);
  fireEvent.wheel(strip,{deltaY:3,deltaMode:2,cancelable:true});
  assert.equal(strip.scrollLeft,700);
  assert.equal(fireEvent.wheel(strip,{deltaY:100,cancelable:true}),false);
  assert.equal(strip.scrollLeft,700);
  assert.equal(fireEvent.wheel(strip,{deltaY:-100,ctrlKey:true,cancelable:true}),true);
  assert.equal(strip.scrollLeft,700);
  fireEvent.click(f.mount.querySelector('.kb-artifact-caption'));
  assert.equal(fireEvent.wheel(f.mount.querySelector('input'),{deltaY:-100,cancelable:true}),true);
  assert.equal(strip.scrollLeft,700);
  Object.defineProperty(strip,'scrollWidth',{value:300});
  assert.equal(fireEvent.wheel(strip,{deltaY:100,cancelable:true}),true);
});
test('keyboard End and Home select the last real file and return to the chat',async t=>{
  const f=fixture(t);
  const home=f.mount.querySelector('[role=tab]');
  fireEvent.keyDown(home,{key:'End'});
  assert.deepEqual(f.calls.at(-1),['select','file-9']);
  fireEvent.keyDown(f.mount.querySelector('[aria-selected=true]'),{key:'Home'});
  assert.deepEqual(f.calls.at(-1),['select','main']);assert.equal(artifactStore.get(f.owner),null);
});
test('a rejected/deferred native close keeps the active tab until the host confirms disappearance',async t=>{
  const f=fixture(t,1);
  fireEvent.click(f.mount.querySelector('[data-artifact-key]'));
  fireEvent.click(f.mount.querySelector('.kb-artifact-close'));
  assert.equal(artifactStore.get(f.owner),'native:file-0');
  assert.equal(f.mount.querySelectorAll('[data-artifact-key]').length,1);
});
test('a main tab without artifacts has no second row',t=>{
  const f=fixture(t,0);assert.equal(f.mount.querySelector('[data-kanban-artifacts]'),null);
});

test('a replacement card cannot render or adopt the previous card native snapshot before the adapter catches up',async t=>{
  const f=fixture(t,3);
  fireEvent.click(f.mount.querySelector('[data-artifact-key="native:file-2"]'));
  assert.equal(artifactStore.get(f.owner),'native:file-2');
  await act(async()=>sectionStore.replace(f.section,{kind:'chat',threadId:'chat-b',title:'B'}));
  // The group still contains A's real native tabs: no native adapter has run yet.
  assert.equal(f.group.native.length,3);
  assert.equal(f.mount.querySelectorAll('[data-artifact-key]').length,0);
  assert.equal(artifactStore.get(artifactOwner(f.section,'chat:chat-b')),null);
  await act(async()=>sectionStore.replace(f.section,{kind:'chat',threadId:'chat-a',title:'A'}));
  assert.equal(f.mount.querySelectorAll('[data-artifact-key]').length,3);
  assert.equal(f.mount.querySelector('[data-artifact-key][aria-selected=true]').dataset.artifactKey,'native:file-2');
  assert.equal(f.calls.some(([action])=>action==='close'),false);
});
test('returning to the main tab through the host restores its saved native editor',async t=>{
  const section=crypto.randomUUID(),mount=document.createElement('div');document.body.append(mount);
  sectionStore.replace(section,{kind:'chat',threadId:'restore',title:'Restore'});
  const native={key:'saved-editor',title:'10.md',status:null,closable:true,detail:{kind:'file',path:'/10.md'}};
  artifactStore.select(artifactOwner(section,'chat:restore'),'native:saved-editor');
  const calls=[];
  const slot=renderSlot({component:ArtifactChrome},{groups:[{section,owner:artifactOwner(section,'chat:restore'),mainKey:'home',mount,native:[native],selectedKey:'home'}]},
    {sdk:{threads:{get:async()=>({environmentId:null})}},experimental_panel:{
      getTabs:()=>({open:true,selectedKey:'home',tabs:[native]}),selectTab:key=>(calls.push(key),true),
    }});
  t.after(()=>{slot.lifecycle.unmount();cleanup();mount.remove();});
  await waitFor(()=>assert.ok(calls.includes('saved-editor')));
  assert.equal(artifactStore.get(artifactOwner(section,'chat:restore')),'native:saved-editor');
});
