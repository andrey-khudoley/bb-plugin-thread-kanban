import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','location','navigator','HTMLElement','Element','Node','MutationObserver','Event','CustomEvent','sessionStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, cleanup, act } = await import('@testing-library/react');
await build({ stdin: { contents: `export {StatusContribution} from './status-contribution'; export {createActivityStore,activityStore} from './activity-store'; export {visibleNotificationTargets} from './notification-views';
 export {registerStatusPanel} from './status-navigation'; export {sectionStore} from './panel-context';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: 'dist/status-contribution-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { StatusContribution, createActivityStore, activityStore, visibleNotificationTargets, registerStatusPanel, sectionStore } = await import('./dist/status-contribution-test.mjs');
const selection = { source: { kind: 'thread', id: 'a' }, mode: 'single', title: 'Test A', test: true };

test('activity migration preserves Test jobs and deduplicates the former per-pane records', () => {
  sessionStorage.clear();
  const jobId = 'd4f67d49-4234-4b70-97fe-74aa38b043cf';
  for (const scope of ['board', 'issue:a']) sessionStorage.setItem(`thread-kanban:derivations:${scope}`,
    JSON.stringify({ runs: [{ key: 1, id: jobId, selection }] }));
  const store = createActivityStore(sessionStorage);
  assert.equal(store.getSnapshot().length, 1); assert.equal(store.getSnapshot()[0].selection.test, true);
  let changes = 0; const unsubscribe = store.subscribe(() => changes++);
  const one = store.add('board', selection, 'run'), two = store.add('issue:a', selection, 'run');
  assert.equal(one.created, true); assert.equal(two.created, false); assert.equal(one.key, two.key);
  store.update(one.key, { error: 'failed' }); store.dismiss(one.key); assert.equal(changes, 3);
  unsubscribe(); store.dismiss(1); assert.equal(changes, 3); sessionStorage.clear();
});

test('visible notification targets exclude mounted hidden tabs, non-chat tools and offscreen cards', t => {
 const previous=document.hasFocus;Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
 const root=document.createElement('div');document.body.append(root);
 t.after(()=>{root.remove();Object.defineProperty(document,'hasFocus',{configurable:true,value:previous});});
 const add=(kind,id,view='chat',offscreen=false)=>{
  const element=document.createElement('div');element.dataset.kanbanPanel=kind;element.dataset.kanbanId=id;element.dataset.kanbanTab=view;
  element.getClientRects=()=>[{width:100,height:100}];
  element.getBoundingClientRect=()=>({x:0,y:0,top:0,left:offscreen?100000:0,right:offscreen?100100:100,bottom:100,width:100,height:100});
  root.append(element);return element;
 };
 add('workspace','shown');add('workspace','files','changes');add('workspace','hidden').hidden=true;
 add('issue','new-card','overview');add('issue','offscreen','overview',true);
 assert.deepEqual(visibleNotificationTargets(document),{threadIds:['shown'],issueIds:['new-card']});
 Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});
 assert.deepEqual(visibleNotificationTargets(document),{threadIds:[],issueIds:[]});
});

test('opening a generated card handles its completed result, preserving other results and running jobs', async t=>{
 const previous=document.hasFocus;Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
 const store=activityStore();
 const first=store.add('board',selection,'generated-card');
 store.update(first.key,{result:{status:'done',children:[{id:'new-card',threadIds:['new-chat']}],activity:[]}});
 const second=store.add('board',{...selection,source:{kind:'thread',id:'b'}},'other-result');
 store.update(second.key,{result:{status:'done',children:[{id:'other-card',threadIds:[]}],activity:[]}});
 const working=store.add('board',selection,'still-working');
 const pane=document.createElement('div');pane.dataset.kanbanPanel='issue';pane.dataset.kanbanId='new-card';pane.dataset.kanbanTab='overview';
 pane.getClientRects=()=>[{width:100,height:100}];pane.getBoundingClientRect=()=>({top:0,left:0,right:100,bottom:100,width:100,height:100});
 document.body.append(pane);
 const slot=renderSlot({component:StatusContribution},{},{});
 t.after(()=>{slot.lifecycle.unmount();pane.remove();[first,second,working].forEach(run=>store.dismiss(run.key));cleanup();
  Object.defineProperty(document,'hasFocus',{configurable:true,value:previous});});
 await waitFor(()=>assert.equal(store.getSnapshot().find(run=>run.key===first.key).hidden,true));
 assert.ok(!store.getSnapshot().find(run=>run.key===second.key).hidden);
 assert.ok(!store.getSnapshot().find(run=>run.key===working.key).hidden);
 assert.equal(document.querySelector('[data-bb-status-contribution-count]').dataset.bbStatusContributionCount,'2');
});

test('optional contribution keeps its count without status-bar, restores its portal and cleans up on unload', async t => {
  const store = activityStore(); const run = store.add('board', selection, 'run');
  store.update(run.key, { error: 'test failure' });
  const slot = renderSlot({ component: StatusContribution }, {}, {});
  t.after(() => { slot.lifecycle.unmount(); store.dismiss(run.key); cleanup(); });
  assert.equal(document.querySelectorAll('[data-kanban-status-bar]').length, 0);
  assert.equal(document.querySelector('[data-bb-status-contribution-count]').dataset.bbStatusContributionCount, '1');
  const target = document.createElement('div'); target.setAttribute('data-bb-status-notification-contributions', '');
  document.body.append(target);
  await waitFor(() => assert.match(target.textContent, /Test A/));
  await act(async () => target.remove());
  assert.equal(document.querySelectorAll('[data-bb-status-notification-contributions]').length, 0);
  document.body.append(target); await waitFor(() => assert.match(target.textContent, /Test A/));
  slot.lifecycle.unmount(); assert.equal(target.textContent, '');
  assert.equal(document.querySelectorAll('[data-bb-status-contribution-count]').length, 0); target.remove();
});

test('a hidden running derivation stays tracked across restoration and no longer appears in the bell', () => {
 sessionStorage.clear(); const store=createActivityStore(sessionStorage);
 const {key}=store.add('board',selection,'run');
 store.update(key,{jobId:'d4f67d49-4234-4b70-97fe-74aa38b043cf'}); store.hide(key);
 const restored=createActivityStore(sessionStorage);
 assert.equal(restored.getSnapshot().length,1); assert.equal(restored.getSnapshot()[0].hidden,true);
 restored.update(key,{pollError:true}); assert.equal(restored.getSnapshot()[0].hidden,true);
 sessionStorage.clear();
});

test('clear all hides all derivations through the contribution bridge while keeping running jobs', async t => {
 const store=activityStore();
 const first=store.add('board',selection,'clear-one');
 const second=store.add('board',{...selection,title:'Test second',source:{kind:'thread',id:'b'}},'clear-two');
 store.update(first.key,{jobId:'d4f67d49-4234-4b70-97fe-74aa38b043cf'});
 const slot=renderSlot({component:StatusContribution},{},{});
 t.after(()=>{slot.lifecycle.unmount();store.dismiss(first.key);store.dismiss(second.key);cleanup();});
 await act(async()=>window.dispatchEvent(new Event('bb:clear-status-notifications')));
 assert.equal(document.querySelector('[data-bb-status-contribution-count]').dataset.bbStatusContributionCount,'0');
 assert.equal(store.getSnapshot().length,2);
 assert.ok(store.getSnapshot().every(run=>run.hidden));
 assert.equal(store.getSnapshot().find(run=>run.key===first.key).jobId,'d4f67d49-4234-4b70-97fe-74aa38b043cf');
});

test('the bell bridge opens chats and generated cards on the visible board, then the card route outside it', async t => {
 const root=document.createElement('main'), target=document.createElement('div');
 target.dataset.bbStatusNotificationContributions='';document.body.append(root,target);
 root.getClientRects=()=>[{}];root.getBoundingClientRect=()=>({top:0,left:0,right:700,bottom:500,width:700,height:500});
 const opened=[];
 const release=registerStatusPanel(root,{getTabs:()=>({open:false,tabs:[],selectedKey:null}),openTab:input=>{opened.push(input);return true;}});
 const store=activityStore(),run=store.add('board',selection,'navigate-generated');
 store.update(run.key,{result:{status:'done',children:[{id:'new-card',title:'Test созданная карточка',threadIds:['new-chat']}],activity:[]}});
 const slot=renderSlot({component:StatusContribution},{},{});
 t.after(()=>{slot.lifecycle.unmount();release();store.dismiss(run.key);root.remove();target.remove();cleanup();});
 const event=new CustomEvent('bb:focus-status-chat',{detail:{threadId:'question',title:'Чат с вопросом'},cancelable:true});
 await act(async()=>assert.equal(window.dispatchEvent(event),false));
 assert.equal(sectionStore.get(opened[0].params.sectionId).context.threadId,'question');
 await waitFor(()=>assert.ok(target.querySelector('article button.text-left')));
 await act(async()=>target.querySelector('article button.text-left').click());
 assert.equal(sectionStore.get(opened[1].params.sectionId).context.issueId,'new-card');
 assert.equal(slot.inspection.navigateCalls.length,0);
 const resultEvent=new CustomEvent('bb:focus-status-issue',{detail:{issueId:'server-card'},cancelable:true});
 await act(async()=>assert.equal(window.dispatchEvent(resultEvent),false));
 assert.equal(sectionStore.get(opened[2].params.sectionId).context.issueId,'server-card');
 root.hidden=true;
 assert.equal(window.dispatchEvent(new CustomEvent('bb:focus-status-chat',{detail:{threadId:'question'},cancelable:true})),true);
 await act(async()=>target.querySelector('article button.text-left').click());
 assert.deepEqual(slot.inspection.navigateCalls.at(-1),{method:'toPluginPanel',path:'board',options:{subPath:'issue/new-card'}});
});
