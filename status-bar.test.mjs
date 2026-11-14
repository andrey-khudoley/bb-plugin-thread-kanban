import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';
import { experimental_useSidebarThreads } from '@get-bb/plugin-sdk/app';

const dom = new JSDOM('<!doctype html><body><div data-testid="app-layout-root"></div></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','location','navigator','HTMLElement','Element','Node','NodeFilter','MutationObserver','Event','CustomEvent','KeyboardEvent','getComputedStyle','localStorage','sessionStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const { renderSlot: renderBaseSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, act, cleanup, screen } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
await build({stdin: {contents: `export {GlobalStatusBar} from './status-bar'; export {statusThreads} from './status-model';
 export {mountStatusShell} from './status-shell';`,resolveDir:process.cwd(),loader:'tsx'},
 outfile:'dist/status-bar-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic',loader:{'.css':'empty'}});
const { GlobalStatusBar, statusThreads, mountStatusShell } = await import('./dist/status-bar-test.mjs');
const renderSlot=(registration,props,options={})=>renderBaseSlot(registration,props,{...options,rpc:{'notifications.list':()=>({notices:[{id:'done-a',threadId:'a',title:'Chat a',kind:'completed',detail:'Agent completed',createdAt:1,readAt:null}],unread:1,coveredThreads:['a'],hiddenLegacyThreads:[]}),'notifications.read':()=>({ok:true}),...options.rpc}});
const thread = (id, overrides={}) => ({ id, projectId:'p', displayTitle:`Чат ${id}`, updatedAt:1,
 status:'idle', runtimeStatus:'idle', queuedWork:'none', activity:{workflows:0,backgroundAgents:0,backgroundCommands:0,planMode:0},
 hasPendingInteraction:false,isArchived:false,isUnread:false,...overrides });

test('counts unique server chats and follows work → user input → completion, independent of pane copies', () => {
 const a=thread('a',{runtimeStatus:'active'}), b=thread('b',{hasPendingInteraction:true});
 let result=statusThreads([a,{...a},b,thread('archived',{runtimeStatus:'active',isArchived:true})]);
 assert.deepEqual(result.working.map(t=>t.id),['a']); assert.deepEqual(result.waiting.map(t=>t.id),['b']);
 result=statusThreads([a,{...a,updatedAt:2,hasPendingInteraction:true},b]);
 assert.equal(result.working.length,0); assert.equal(result.waiting.length,2);
 result=statusThreads([thread('a',{isUnread:true}),b]);
 assert.equal(result.working.length,0); assert.deepEqual(result.notifications.map(t=>t.id),['a']);
 assert.equal(statusThreads([thread('hidden',{isHidden:true,activity:{backgroundAgents:1}})]).working.length,1);
});

test('shell bridges host footer once, preserves its DOM and restores layout on dispose', async () => {
 const footer=document.createElement('div'); footer.dataset.sidebar='footer';
 footer.innerHTML='<button id="usage" data-sidebar="menu-button" data-testid="plugin-sidebar-footer-item-bb--provider-usage-usage" aria-label="Provider usage" aria-controls="usage-details" aria-expanded="false"></button><section id="usage-details"><button aria-label="Weekly limit: 51% used">51%</button></section>';
 document.body.append(footer); const source=footer.firstChild; let clicks=0;
 const details=footer.querySelector('section');document.body.append(details);
 source.addEventListener('click',()=>{clicks++;source.setAttribute('aria-expanded','true');});
 const snapshots=[]; const adapter=mountStatusShell(s=>snapshots.push(s));
 await new Promise(r=>setTimeout(r,20));
 assert.equal(clicks,1); assert.equal(source.parentElement,footer); assert.equal(snapshots.at(-1).items.length,1);
 assert.equal(snapshots.at(-1).usage,'51%');
 const matches=details.matches.bind(details); let showing=false;
 details.matches=selector=>selector===':popover-open'?showing:matches(selector);
 // jsdom has no top-layer rendering; make the fake opened popover focusable.
 details.showPopover=()=>{showing=true;details.removeAttribute('popover');};details.hidePopover=()=>{showing=false;};
 adapter.activate('usage'); assert.equal(document.activeElement,details.querySelector('button'));
 adapter.activate('usage');
 details.remove(); await new Promise(r=>setTimeout(r,20));
 assert.equal(snapshots.at(-1).usage,'51%'); assert.match(snapshots.at(-1).usageTitle,/Последние полученные данные/);
 const loading=document.createElement('section');loading.id='usage-details';document.body.append(loading);
 await new Promise(r=>setTimeout(r,20));assert.equal(snapshots.at(-1).usage,'51%');
 assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),true);
 adapter.dispose(); footer.remove();loading.remove();
 assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),false);
});

test('disposing a parallel adapter preserves the remaining status row reservation in either order', () => {
 for (const order of [[0,1],[1,0]]) {
  const adapters=[mountStatusShell(()=>{}),mountStatusShell(()=>{})];
  assert.equal(document.head.querySelectorAll('style[data-kanban-status-shell-owner]').length,2);
  adapters[order[0]].dispose(); adapters[order[0]].dispose();
  assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),true);
  assert.equal(document.head.querySelectorAll('style[data-kanban-status-shell-owner]').length,1);
  adapters[order[1]].dispose();
  assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),false);
 }
});

test('a surviving adapter restores reservation after cleanup from an older plugin copy', async () => {
 const adapter=mountStatusShell(()=>{});
 try {
  document.documentElement.removeAttribute('data-kanban-status-shell');
  await waitFor(()=>assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),true));
 } finally { adapter.dispose(); }
 assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),false);
});

test('one app overlay stays outside all split containers; lists are accessible and focus native open chats', async t => {
 const host=document.querySelector('[data-testid="app-layout-root"]');
 host.innerHTML='<div data-panel-group><main>First pane</main><aside>Second pane</aside></div>';
 const a=thread('a',{runtimeStatus:'active'}), b=thread('b',{hasPendingInteraction:true});
 const live={status:'ready',projects:[{id:'p',name:'Очень длинное название активного проекта'}],threads:[a,a,b]};
 let fixture;
 function LiveFixture() { fixture=experimental_useSidebarThreads(); return createElement(GlobalStatusBar); }
 const slot=renderSlot({component:LiveFixture},{},{context:{projectId:'p',threadId:'a'},
  sidebarThreads:live,
  sidebarSplitLayout:{panes:[{paneId:'one',threadId:'a',isFocused:true,rect:{x:0,y:0,width:500,height:500}}]},
 });
 t.after(()=>{slot.lifecycle.unmount();cleanup();host.innerHTML='';});
 await waitFor(()=>assert.equal(document.querySelectorAll('[data-kanban-status-bar]').length,1));
 const bar=document.querySelector('[data-kanban-status-bar]');
 assert.equal(bar.closest('[data-panel-group]'),null); assert.equal(document.querySelectorAll('.kb-activity-bar').length,0);
 const user=userEvent.setup({document});
 await user.click(screen.getByRole('button',{name:'Работающие чаты: 1'}));
 assert.equal(document.querySelectorAll('[data-status-thread="a"]').length,1);
 await user.click(document.querySelector('[data-status-thread="a"]'));
 assert.equal(slot.inspection.navigateCalls.at(-1).method,'toThread');
 assert.deepEqual(slot.inspection.navigateCalls.at(-1),{method:'toThread',threadId:'a',options:{split:true}});
 for(const direction of ['column','row','column']) { host.firstChild.style.flexDirection=direction; assert.equal(document.querySelectorAll('[data-kanban-status-bar]').length,1); }
 host.innerHTML='<main>Single pane</main>'; assert.equal(document.querySelectorAll('[data-kanban-status-bar]').length,1);
 fixture.threads=[a,{...a,updatedAt:2,hasPendingInteraction:true},b,thread('c',{runtimeStatus:'active'}),thread('d',{runtimeStatus:'active'})];
 await act(async()=>slot.rerender(createElement(LiveFixture)));
 assert.ok(screen.getByRole('button',{name:'Работающие чаты: 2'}));
 assert.ok(screen.getByRole('button',{name:'Ожидают пользователя: 2'}));
 fixture.threads=[thread('a',{isUnread:true}),b];
 await act(async()=>slot.rerender(createElement(LiveFixture)));
 assert.ok(screen.getByRole('button',{name:'Работающие чаты: 0'}));
 assert.ok(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 assert.match(screen.getByRole('dialog').textContent,/Работа завершена/);
 slot.lifecycle.unmount();
 assert.equal(document.querySelectorAll('[data-kanban-status-host]').length,0);
 assert.equal(document.documentElement.hasAttribute('data-kanban-status-shell'),false);
});

test('restores the project context when a saved pane mounts after the global overlay', async t => {
 const slot=renderSlot({component:GlobalStatusBar},{},{context:{projectId:'default'},sidebarThreads:{projects:[
  {id:'p',name:'Восстановленный проект'},{id:'default',name:'Проект композера по умолчанию'}]}});
 const pane=document.createElement('div'); pane.dataset.kanbanPanel='issue'; pane.dataset.kanbanProject='p';
 pane.getClientRects=()=>[{width:100,height:100}];
 t.after(()=>{slot.lifecycle.unmount();pane.remove();cleanup();});
 await act(async()=>document.querySelector('[data-testid="app-layout-root"]').append(pane));
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Восстановленный проект'})));
});

test('bell close hides a record and updates the count without navigating or marking read', async t => {
 let hidden=false;
 const slot=renderSlot({component:GlobalStatusBar},{},{rpc:{
  'notifications.list':()=>({notices:hidden?[]:[{id:'dismiss-test',threadId:'t',title:'Test hidden',kind:'question',detail:'Question',createdAt:1,readAt:null}],unread:hidden?0:1,coveredThreads:[],hiddenLegacyThreads:[]}),
  'notifications.dismiss':()=>{hidden=true;return {ok:true};},
 }});
 t.after(()=>{slot.lifecycle.unmount();cleanup();});
 const user=userEvent.setup({document});
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 1'})));
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(screen.getByRole('button',{name:'Скрыть уведомление: Test hidden'}));
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 0'})));
 assert.equal(slot.inspection.navigateCalls.length,0);
 assert.equal(slot.inspection.rpcCalls.filter(call=>call.method==='notifications.read').length,0);
 assert.equal(document.querySelectorAll('[data-notification-id="dismiss-test"]').length,0);
});

test('a generated-task bell entry opens its card route instead of the hidden worker chat', async t => {
 const id='19a1433b-e3f4-4730-8f6b-a555805d7ce4';
 const slot=renderSlot({component:GlobalStatusBar},{},{rpc:{
  'notifications.list':()=>({notices:[{id:'result',threadId:'worker',issueId:id,derivationId:'job',label:'Задача создана',
   title:'Test · Созданная задача',kind:'completed',detail:'Откройте карточку',createdAt:1,readAt:null}],unread:1,coveredThreads:['worker'],hiddenLegacyThreads:['worker']}),
 }});
 t.after(()=>{slot.lifecycle.unmount();cleanup();});
 const user=userEvent.setup({document});
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 1'})));
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(document.querySelector('[data-notification-id="result"]'));
 assert.deepEqual(slot.inspection.navigateCalls.at(-1),{method:'toPluginPanel',path:'board',options:{subPath:`issue/${id}`}});
 assert.equal(slot.inspection.navigateCalls.some(call=>call.method==='toThread'),false);
 assert.ok(slot.inspection.rpcCalls.some(call=>call.method==='notifications.read'&&call.input.id==='result'));
});

test('clear all empties the bell without navigation or reading and disables itself when empty', async t => {
 let hidden=false, clearedContributions=0;
 const onClear=()=>clearedContributions++;
 window.addEventListener('bb:clear-status-notifications',onClear);
 const slot=renderSlot({component:GlobalStatusBar},{},{rpc:{
  'notifications.list':()=>({notices:hidden?[]:[{id:'all-1',threadId:'t',title:'Test all',kind:'question',detail:'Question',createdAt:1,readAt:null}],
    unread:hidden?0:1,coveredThreads:[],hiddenLegacyThreads:[]}),
  'notifications.dismissAll':()=>{hidden=true;return {ok:true};},
 }});
 t.after(()=>{slot.lifecycle.unmount();cleanup();window.removeEventListener('bb:clear-status-notifications',onClear);});
 const user=userEvent.setup({document});
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 1'})));
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(screen.getByRole('button',{name:'Очистить все'}));
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 0'})));
 assert.equal(screen.getByRole('button',{name:'Очистить все'}).disabled,true);
 assert.equal(clearedContributions,1);
 assert.equal(slot.inspection.navigateCalls.length,0);
 assert.equal(slot.inspection.rpcCalls.filter(call=>call.method==='notifications.read').length,0);
});

test('bell navigation delegates to the current board and uses native chat navigation when it declines', async t => {
 let onBoard=true; const requests=[];
 const focus=event=>{requests.push(event.detail);if(onBoard)event.preventDefault();};
 window.addEventListener('bb:focus-status-chat',focus);
 const slot=renderSlot({component:GlobalStatusBar},{},{});
 t.after(()=>{slot.lifecycle.unmount();cleanup();window.removeEventListener('bb:focus-status-chat',focus);});
 const user=userEvent.setup({document});
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Уведомления: 1'})));
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(document.querySelector('[data-notification-id="done-a"]'));
 assert.deepEqual(requests.at(-1),{threadId:'a',title:'Chat a'});
 assert.equal(slot.inspection.navigateCalls.length,0);
 await waitFor(()=>assert.equal(slot.inspection.rpcCalls.filter(call=>call.method==='notifications.read').length,1));
 onBoard=false;
 await user.click(screen.getByRole('button',{name:'Уведомления: 1'}));
 await user.click(document.querySelector('[data-notification-id="done-a"]'));
 assert.deepEqual(slot.inspection.navigateCalls.at(-1),{method:'toThread',threadId:'a'});
});
