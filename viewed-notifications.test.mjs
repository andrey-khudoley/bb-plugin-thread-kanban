import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','navigator','HTMLElement','Element','Node','Event','CustomEvent'])
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
let focused=true, visibility='visible';
Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>focused});
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
const { render, act, waitFor, cleanup } = await import('@testing-library/react');
await build({entryPoints:['viewed-notifications.ts'],outfile:'dist/viewed-notifications-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const { useViewedNotifications } = await import('./dist/viewed-notifications-test.mjs');
function Fixture({ threadId=null, notices, view, read }) { useViewedNotifications(threadId,notices,view,read); return null; }
const notice=(id,threadId)=>({id,threadId,kind:'completed',title:id,detail:'',createdAt:1,readAt:null});

test('native navigation and newly arriving notices acknowledge only the visible chat, without a bell click', async t=>{
 t.after(cleanup); focused=true;visibility='visible';const calls=[];const view=async id=>{calls.push(id);};
 const notices=[notice('a1','a'),notice('b1','b')];
 const slot=render(createElement(Fixture,{threadId:'a',notices,view}));
 await waitFor(()=>assert.deepEqual(calls,['a']));
 slot.rerender(createElement(Fixture,{threadId:'a',notices:[...notices],view}));assert.deepEqual(calls,['a']);
 slot.rerender(createElement(Fixture,{threadId:'b',notices,view}));await waitFor(()=>assert.deepEqual(calls,['a','b']));
 slot.rerender(createElement(Fixture,{threadId:'b',notices:[...notices,notice('b2','b')],view}));
 await waitFor(()=>assert.deepEqual(calls,['a','b','b']));
});

test('Kanban view events acknowledge its chat; background windows and hidden pages do not', async t=>{
 t.after(cleanup);focused=false;visibility='visible';const calls=[];const view=async id=>{calls.push(id);};
 render(createElement(Fixture,{notices:[notice('a','a'),notice('b','b')],view}));
 await act(async()=>window.dispatchEvent(new CustomEvent('bb:notification-view',{detail:{source:'kanban',threadIds:['b'],issueIds:[]}})));
 assert.deepEqual(calls,[]);
 focused=true;await act(async()=>window.dispatchEvent(new Event('focus')));
 await waitFor(()=>assert.deepEqual(calls,['b']));
 visibility='hidden';await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
 await act(async()=>window.dispatchEvent(new CustomEvent('bb:notification-view',{detail:{source:'kanban',threadIds:['a'],issueIds:[]}})));
 assert.deepEqual(calls,['b']);
 visibility='visible';await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
 await waitFor(()=>assert.deepEqual(calls,['b','a']));
});

test('viewing a generated card acknowledges its result without reading the worker transcript', async t => {
 t.after(cleanup); focused=true;visibility='visible';const calls=[],reads=[];
 const view=async id=>calls.push(id),read=async id=>reads.push(id);
 const notices=[{...notice('result','worker'),issueId:'child',derivationId:'job'},notice('ordinary','other')];
 const slot=render(createElement(Fixture,{threadId:'worker',notices,view,read}));
 assert.deepEqual(calls,[]);assert.deepEqual(reads,[]);
 await act(async()=>window.dispatchEvent(new CustomEvent('bb:notification-view',{detail:{source:'kanban',threadIds:[],issueIds:['child']}})));
 await waitFor(()=>assert.deepEqual(reads,['result']));assert.deepEqual(calls,[]);
 slot.rerender(createElement(Fixture,{threadId:'worker',notices:[...notices],view,read}));
 assert.deepEqual(reads,['result']);
});
