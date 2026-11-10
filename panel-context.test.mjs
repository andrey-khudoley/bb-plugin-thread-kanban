import assert from "node:assert/strict";
import test from "node:test";
import { createSectionStore, contextKey, contextThreadId } from "./panel-context.ts";

function storage() {
  const values = new Map();
  return {get length(){return values.size},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
const chat = id => ({kind:'chat',threadId:id,title:id});
const issue = {kind:'issue',issueId:'issue',title:'Карточка',threadId:null,startWithAssistant:false,request:1};

test("one current context per section; replacing it preserves other sections and file history", () => {
  const sections = createSectionStore(storage);
  sections.replace('left',chat('a')); sections.remember('left','a.txt');
  sections.replace('right',chat('c')); sections.remember('right','c.txt');
  sections.replace('left',chat('b')); sections.remember('left','b.txt');
  assert.equal(sections.hasFile('left','a.txt'),false);
  assert.equal(sections.hasFile('left','b.txt'),true);
  assert.equal(sections.hasFile('right','c.txt'),true);
  assert.equal(sections.hasFile('right','b.txt'),false);
  sections.replace('left',chat('a'));
  assert.equal(sections.hasFile('left','a.txt'),true);
  assert.equal(sections.hasFile('left','b.txt'),false);
  sections.replace('left',issue);
  assert.equal(sections.hasFile('left','a.txt'),false);
});

test("the same card restores its files in another tab, including after restart", () => {
  const browser = storage();
  const sections = createSectionStore(()=>browser);
  sections.replace('left',chat('a')); sections.remember('left','left.txt');
  sections.replace('right',chat('a')); sections.remember('right','right.txt');
  const restored = createSectionStore(()=>browser);
  assert.equal(restored.get('left').context.threadId,'a');
  assert.equal(restored.hasFile('left','left.txt'),true);
  assert.equal(restored.hasFile('left','right.txt'),true);
  assert.equal(restored.hasFile('right','right.txt'),true);
  assert.equal(restored.hasFile('right','left.txt'),true);
});

test("card file ownership stays the same in settings and different linked chats", () => {
  assert.equal(contextKey({...issue,threadId:'a'}),contextKey(issue));
  assert.equal(contextKey({...issue,threadId:'b'}),contextKey(issue));
  assert.notEqual(contextKey(issue),contextKey(chat('a')));
  assert.equal(contextThreadId({...issue,threadId:'a',view:'chat'}),'a');
  assert.equal(contextThreadId({...issue,threadId:'a',view:'overview'}),null);
  assert.equal(contextThreadId(chat('a')),'a'); // Native file selection does not change the section's context.
});

test('switching card A to B hides A files and returning restores them, including card settings', () => {
  const sections = createSectionStore(storage);
  sections.replace('tab',{...issue,threadId:'a',view:'chat'}); sections.remember('tab','a.md');
  sections.replace('tab',{...issue,threadId:null,view:'overview'});
  assert.equal(sections.hasFile('tab','a.md'),true);
  sections.replace('tab',{...issue,issueId:'second',threadId:'a'});
  assert.equal(sections.hasFile('tab','a.md'),false);
  sections.remember('tab','b.md');
  sections.replace('tab',issue);
  assert.equal(sections.hasFile('tab','a.md'),true);
  assert.equal(sections.hasFile('tab','b.md'),false);
});

test('legacy linked-chat file history migrates to its card once and does not resurrect closed files', () => {
  const browser = storage();
  browser.setItem('thread-kanban:section:v1:old',JSON.stringify({context:{...issue,threadId:'a'},files:{'chat:a':['legacy.md']}}));
  const sections = createSectionStore(()=>browser);
  assert.equal(sections.hasFile('old','legacy.md'),true);
  sections.forget('old','legacy.md');
  const restored=createSectionStore(()=>browser);
  assert.equal(restored.hasFile('old','legacy.md'),false);
});

test('restored native files of a closed card are not assigned to the currently active card', () => {
  const browser=storage();
  const original=createSectionStore(()=>browser);
  original.replace('old',issue);original.remember('old','old-card.md');original.clear('old');
  const restored=createSectionStore(()=>browser);
  restored.replace('new',{...issue,issueId:'new'});
  assert.equal(restored.isKnownFile('old-card.md'),true);
  assert.equal(restored.hasFile('new','old-card.md'),false);
});

test("migration absorbs file history without replacing the chosen context", () => {
  const sections = createSectionStore(storage);
  sections.replace('old',chat('a')); sections.remember('old','a.txt');
  sections.replace('current',chat('b')); sections.remember('current','b.txt');
  sections.absorb('current','old');
  assert.equal(sections.get('current').context.threadId,'b');
  assert.equal(sections.hasFile('current','a.txt'),false);
  sections.replace('current',chat('a'));
  assert.equal(sections.hasFile('current','a.txt'),true);
});

test("closing an editor removes it from all histories; old snapshots stay immutable", () => {
  const sections = createSectionStore(storage);
  sections.replace('left',chat('a')); sections.remember('left','shared.txt');
  sections.replace('left',chat('b')); sections.remember('left','shared.txt');
  const before = sections.get('left');
  sections.forget('left','shared.txt');
  assert.deepEqual(sections.get('left').files,{'chat:a':[],'chat:b':[]});
  assert.deepEqual(before.files['chat:a'],['shared.txt']);
});

test("malformed persisted data and unavailable storage leave a usable empty section", () => {
  const broken = createSectionStore(()=>({getItem:()=>'{broken',setItem:()=>{throw new Error('full')}}));
  assert.equal(broken.get('section').context,null);
  broken.replace('section',chat('a'));
  assert.equal(broken.get('section').context.threadId,'a');
});

test("closing a context preserves file history and stays closed after reload", () => {
  const browser = storage();
  const sections = createSectionStore(()=>browser);
  sections.replace('section',chat('a')); sections.remember('section','a.md');
  sections.clear('section');
  const restored = createSectionStore(()=>browser);
  assert.equal(restored.get('section').context,null);
  assert.equal(restored.get('section').initialized,true);
  assert.equal(restored.hasFile('section','a.md'),false);
  restored.replace('section',chat('a'));
  assert.equal(restored.hasFile('section','a.md'),true);
});
