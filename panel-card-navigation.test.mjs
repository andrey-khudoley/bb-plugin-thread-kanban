import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createTabActivity, matchingCardTabs } from './panel-card-navigation.ts';

await build({ stdin: { contents: `export { focusOpenCard, openPanelContext, trackPanelActivity, setContextPluginId } from './panel-context-actions';
  export { sectionStore } from './panel-context'; export { openIssue } from './issue-panel';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: 'dist/panel-card-navigation-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { focusOpenCard, openPanelContext, trackPanelActivity, setContextPluginId, sectionStore, openIssue } = await import('./dist/panel-card-navigation-test.mjs');
setContextPluginId('thread-kanban');
const issue = id => ({kind:'issue', issueId:id, title:id, threadId:'thr_selected', request:17, startWithAssistant:false, view:'changes'});
const chat = id => ({kind:'chat', threadId:id, title:id, view:'plan'});
function card(context, pluginId = 'thread-kanban') {
  const sectionId = crypto.randomUUID();
  if (context) sectionStore.replace(sectionId, context); else sectionStore.clear(sectionId);
  return {key:sectionId, title:'same title', status:null, closable:true,
    detail:{kind:'plugin',pluginId,tab:{id:'context',context:{kind:'nav-panel',panelId:'board'},availability:'action'},params:{sectionId}}};
}
function panel(tabs, selectedKey = tabs.at(-1)?.key) {
  let snapshot = {open:true, tabs, selectedKey}; const selections = [], openings = [];
  return {selections, openings, getTabs:()=>snapshot,
    selectTab(key) { selections.push(key); if (!snapshot.tabs.some(tab=>tab.key===key)) return false;
      snapshot={...snapshot,selectedKey:key,open:true}; return true; },
    openTab(options) { openings.push(options); return true; },
    change(change) { snapshot={...snapshot,...change}; },
  };
}

test('clicking A from B selects A without replacing either context or opening another tab', () => {
  const a=card(issue('A')), b=card(issue('B')), p=panel([a,b]);
  const beforeA=sectionStore.get(a.key), beforeB=sectionStore.get(b.key);
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'focused');
  assert.equal(p.getTabs().selectedKey,a.key); assert.equal(p.openings.length,0); assert.equal(p.getTabs().tabs.length,2);
  assert.strictEqual(sectionStore.get(a.key),beforeA); assert.strictEqual(sectionStore.get(b.key),beforeB);
});
test('clicking the active card is a no-op and preserves its request, section and linked chat', () => {
  const a=card(issue('A')),p=panel([a]); const context=sectionStore.get(a.key).context;
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'focused');
  assert.deepEqual(p.selections,[]); assert.strictEqual(sectionStore.get(a.key).context,context);
  p.change({open:false}); assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'focused');
  assert.deepEqual(p.selections,[a.key]);
});
test('an absent or closed card follows the existing replacement path', () => {
  const a=card(issue('A')),b=card(issue('B')),p=panel([a,b]); p.change({tabs:[b]});
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'missing');
  assert.equal(openPanelContext(p,issue('C')),true);
  assert.equal(sectionStore.get(b.key).context.issueId,'C'); assert.deepEqual(p.openings,[]);
});
test('replacement in the same native tab is read from the current section, not old params or title', () => {
  const a=card(issue('A')),b=card(issue('B')),p=panel([a,b]); sectionStore.replace(a.key,issue('C'));
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'missing');
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'C'}),'focused'); assert.equal(p.getTabs().selectedKey,a.key);
});
test('type and plugin scope disambiguate equal IDs; linked chats do not identify an issue', () => {
  const a=card(issue('same')),b=card(chat('same')),foreign=card(issue('foreign'),'qa-kanban'),p=panel([a,b,foreign]);
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'same'}),'focused'); assert.equal(p.getTabs().selectedKey,a.key);
  assert.equal(focusOpenCard(p,{kind:'chat',threadId:'same'}),'focused'); assert.equal(p.getTabs().selectedKey,b.key);
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'foreign'}),'missing');
  assert.equal(focusOpenCard(p,{kind:'chat',threadId:'thr_selected'}),'missing');
});
test('native + and an explicitly empty plugin tab allow a duplicate', () => {
  const a=card(issue('A')),empty=card(null),launcher={key:'new',detail:{kind:'new-tab'}},p=panel([a,launcher]);
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'missing');
  p.change({tabs:[a,empty],selectedKey:empty.key}); assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'missing');
});
test('duplicates prefer the active tab, then MRU, then stable snapshot order', () => {
  const a=card(issue('A')),copy=card(issue('A')),b=card(issue('B')),p=panel([a,copy,b]); const activity=createTabActivity();
  for (const key of [copy.key,a.key,b.key]) { p.change({selectedKey:key}); trackPanelActivity(p.getTabs(),activity); }
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'focused'); assert.equal(p.getTabs().selectedKey,a.key);
  p.change({selectedKey:copy.key}); trackPanelActivity(p.getTabs(),activity);
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'focused'); assert.equal(p.getTabs().selectedKey,copy.key);
  const candidates=[{key:'one',cardKey:'issue:A'},{key:'two',cardKey:'issue:A'}];
  assert.equal(matchingCardTabs(candidates,'issue:A',null)[0].key,'one');
  activity.update([],null); assert.equal(activity.rank(a.key),0);
});
test('legacy params initialize identity only until a section has an authoritative context', () => {
  const id=crypto.randomUUID(),tab={key:'legacy:'+id,title:'old',detail:{kind:'plugin',pluginId:'thread-kanban',
    tab:{id:'issue',context:{kind:'nav-panel',panelId:'board'},availability:'action'},params:{issueId:id}}};
  const p=panel([tab]); assert.equal(focusOpenCard(p,{kind:'issue',issueId:id}),'focused');
  sectionStore.replace('legacy-issue:'+id+':',issue('new'));
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:id}),'missing');
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'new'}),'focused');
});
test('a disappearing tab retries the live snapshot; an unselectable match never overwrites B', () => {
  const a=card(issue('A')),b=card(issue('B')),p=panel([a,b]);
  p.selectTab=()=>{p.change({tabs:[b]});return false;};
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'missing');
  p.change({tabs:[a,b]}); p.selectTab=()=>false;
  assert.equal(focusOpenCard(p,{kind:'issue',issueId:'A'}),'failed'); assert.equal(sectionStore.get(b.key).context.issueId,'B');
});
test('normal task clicks preserve openRequest; an explicit linked chat updates only the selected issue, even before native publication', () => {
  const a=card(issue('A')),b=card(issue('B')),p=panel([a,b]);
  const model={id:'A',title:'A',threadIds:['thr_other','thr_selected']};
  openIssue(p,model,{reuse:true}); assert.equal(sectionStore.get(a.key).context.request,17);
  p.change({selectedKey:b.key}); p.selectTab=()=>true;
  openIssue(p,model,{reuse:true,threadId:'thr_other'});
  assert.equal(sectionStore.get(a.key).context.threadId,'thr_other'); assert.equal(sectionStore.get(a.key).context.view,'chat');
  assert.equal(sectionStore.get(b.key).context.issueId,'B'); assert.equal(sectionStore.get(b.key).context.request,17);
});
