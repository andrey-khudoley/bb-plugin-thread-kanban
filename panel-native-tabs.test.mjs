import assert from "node:assert/strict";
import test from "node:test";
import { nativeTabCandidates, nativeTabGroup, resolveMountedTab, resolveNativeTab } from "./panel-native-tabs.ts";
import { JSDOM } from 'jsdom';

test("matches native panes with interleaved file tabs after split and drag", () => {
  const tabs = ['Секция 1','Секция 2','a.md','b.md'].map((title,key)=>({title,key,status:null}));
  const nativeOrder = ['Секция 1','a.md','Секция 2','b.md'];
  assert.deepEqual(nativeOrder.map(label=>resolveNativeTab(tabs,label)?.key),[0,2,1,3]);
});
test("a caption alone does not identify equal names; candidate keys remain distinct for pane grouping", () => {
  const tabs = [{title:'file.md',status:null,key:'one'},{title:'file.md',status:null,key:'two'}];
  assert.equal(resolveNativeTab(tabs,'file.md'),null);
  assert.equal(resolveNativeTab(tabs,'unknown'),null);
  assert.deepEqual(nativeTabCandidates(tabs,'file.md').map(tab=>tab.key),['one','two']);
});

test('native terminal status labels resolve with the host parentheses',()=>{
  const tab={title:'Shell',status:'0',key:'terminal'};
  assert.equal(resolveNativeTab([tab],'Shell(0)'),tab);
  assert.equal(resolveNativeTab([tab],'Shell (0)'),tab);
});

test('selected captions resolve to their own mounted pane and ignore neighbouring file panes and inactive tabs', () => {
  const dom = new JSDOM(`<aside><div><header><div data-tab-pill><button aria-pressed="true"></button></div></header>
    <div data-kanban-section="one"></div></div><div><header>
    <div data-tab-pill><button aria-pressed="true"></button></div></header><div data-kanban-section="two"></div></div>
    <div><div data-tab-pill><button aria-pressed="true"></button></div><div>Native file</div></div></aside>`);
  const tabs = [{id:'one'},{id:'two'}], getId = tab => tab.id;
  const [outer, inner, file] = dom.window.document.querySelectorAll('[data-tab-pill]');
  assert.equal(resolveMountedTab(outer,tabs,getId),tabs[0]);
  assert.equal(resolveMountedTab(inner,tabs,getId),tabs[1]);
  assert.equal(resolveMountedTab(file,tabs,getId),null);
  outer.querySelector('button').setAttribute('aria-pressed','false');
  assert.equal(resolveMountedTab(outer,tabs,getId),null);
  dom.window.close();
});

test('desktop and split tab toolbars group independently without depending on maximize labels', () => {
  const dom = new JSDOM(`<aside><div role="toolbar" aria-label="Right panel views"><div data-tab-pill></div></div>
    <button aria-label="Full Screen"></button></aside><div data-sidebar-split-tab-group="one"><div data-tab-pill></div></div>
    <div data-sidebar-split-tab-group="two"><div data-tab-pill></div></div>`);
  const pills = [...dom.window.document.querySelectorAll('[data-tab-pill]')];
  assert.equal(nativeTabGroup(pills[0]),pills[0].parentElement);
  assert.equal(nativeTabGroup(pills[1]),pills[1].parentElement);
  assert.equal(nativeTabGroup(pills[2]),pills[2].parentElement);
  assert.notEqual(nativeTabGroup(pills[1]),nativeTabGroup(pills[2]));
  dom.window.close();
});
