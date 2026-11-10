import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'localStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, act, cleanup, fireEvent } = await import('@testing-library/react');
await build({ stdin: { contents: `export { PanelContextBridge } from './panel-context-ui';
  export { sectionStore } from './panel-context'; export { setContextPluginId } from './panel-context-actions';
  export { artifactStore, artifactOwner, nativeArtifactOwners } from './panel-artifacts';`,
  resolveDir: process.cwd(), loader: 'tsx' }, outfile: 'dist/panel-context-ui-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { PanelContextBridge, sectionStore, setContextPluginId, artifactStore, artifactOwner, nativeArtifactOwners } = await import('./dist/panel-context-ui-test.mjs');
setContextPluginId('thread-kanban');
test.beforeEach(()=>nativeArtifactOwners.retain(new Set()));

function fixture(t, { duplicate = false, hidden = false, desktop = false } = {}) {
  const id = crypto.randomUUID();
  const host = document.createElement('div');
  host.innerHTML = `<main data-kanban-board-surface></main><aside><div>
    <header><div data-sidebar-split-tab-group="pane-primary"><div data-tab-pill><button aria-pressed="true"><span>Прежний чат</span></button>
      <button data-tab-pill-close aria-label="Close Прежний чат"></button></div></div><button aria-label="${desktop ? 'Full Screen' : 'Maximize pane'}"></button></header>
    <div data-kanban-section="${id}"></div></div></aside>`;
  document.body.append(host);
  const pill = host.querySelector('[data-tab-pill]');
  const text = pill.querySelector('span').firstChild;
  const tab = { key: id, title: 'Прежний чат', status: null, closable: true,
    detail: { kind: 'plugin', pluginId: 'thread-kanban', tab: { id: 'context', context: { kind: 'nav-panel', panelId: 'board' } }, params: { sectionId: id } } };
  const tabs = [tab];
  if (duplicate || hidden) tabs.push({ ...tab, key: 'other', title: duplicate ? tab.title : 'Вкладка в другой секции',
    detail: { ...tab.detail, params: { sectionId: 'other' } } });
  sectionStore.replace(id, { kind: 'chat', threadId: 'thr_previous', title: 'Прежний чат' });
  const slot = renderSlot({ component: PanelContextBridge }, { surface: { current: host.querySelector('main') } }, {
    experimental_panelTabs: { open: true, selectedKey: id, tabs },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); host.remove(); });
  return { id, pill, text, slot };
}

test('a restored tab with an ambiguous old title follows its mounted card', async (t) => {
  const { id, text, pill } = fixture(t, { duplicate: true });
  await act(async () => sectionStore.replace(id, { kind: 'chat', threadId: 'thr_infrastructure', title: '4.6 этап проекта «Инфраструктура»' }));
  await waitFor(() => assert.equal(text.data, '4.6 этап проекта «Инфраструктура»'));
  assert.equal(pill.dataset.kbSection, id);
});

test('tabs outside the mounted pane do not prevent its caption from updating', async (t) => {
  const { id, text } = fixture(t, { hidden: true });
  await act(async () => sectionStore.replace(id, { kind: 'chat', threadId: 'thr_new', title: 'Другой чат' }));
  await waitFor(() => assert.equal(text.data, 'Другой чат'));
});

test('a host text-only rerender restores the current card caption without another click', async (t) => {
  const { id, text } = fixture(t);
  await act(async () => sectionStore.replace(id, { kind: 'chat', threadId: 'thr_new', title: 'Другой чат' }));
  await waitFor(() => assert.equal(text.data, 'Другой чат'));
  // Let the adapter's own observer records settle before the independent host update.
  await act(async () => new Promise(resolve => setTimeout(resolve, 70)));
  text.data = 'Прежний чат';
  await waitFor(() => assert.equal(text.data, 'Другой чат'));
});

test('the desktop sidebar updates its caption without a Maximize pane control', async (t) => {
  const { id, text } = fixture(t, { desktop: true });
  await act(async () => sectionStore.replace(id, { kind: 'chat', threadId: 'thr_new', title: 'Название открытого чата' }));
  await waitFor(() => assert.equal(text.data, 'Название открытого чата'));
});

for (const kind of ['browser','file']) test(`an active native ${kind} stays in the second row when the previous card body is still mounted`, async t=>{
  const first=crypto.randomUUID(),second=crypto.randomUUID();
  const host=document.createElement('div');
  host.innerHTML=`<main></main><aside><header data-testid="thread-secondary-panel-top-chrome"><div data-sidebar-split-tab-group="pane">
    <div data-tab-pill><button aria-pressed="false">Home A</button></div>
    <div data-tab-pill><button aria-pressed="true">Document</button></div>
    <div data-tab-pill><button aria-pressed="false">Home B</button></div>
    </div></header><div data-kanban-section="${first}"></div></aside>`;
  document.body.append(host);
  sectionStore.replace(first,{kind:'chat',threadId:'a',title:'A'});
  sectionStore.replace(second,{kind:'chat',threadId:'b',title:'B'});
  const home=(id,title)=>({key:id,title,status:null,closable:true,detail:{kind:'plugin',pluginId:'thread-kanban',
    tab:{id:'context',context:{kind:'nav-panel',panelId:'board'}},params:{sectionId:id}}});
  const documentTab={key:'document',title:'Document',status:null,closable:true,
    detail:kind==='browser'?{kind,url:'https://example.org/document'}:{kind,path:'/docs/document.md'}};
  const tabs=[home(first,'Home A'),documentTab,home(second,'Home B'),home('unmounted','Other pane')];
  const slot=renderSlot({component:PanelContextBridge},{surface:{current:host.querySelector('main')}},{
    sdk:{threads:{get:async()=>({environmentId:null})}},
    experimental_panelTabs:{open:true,selectedKey:'document',tabs},
    experimental_panel:{selectTab:()=>true},
  });
  t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  const pill=host.querySelectorAll('[data-tab-pill]')[1];
  await waitFor(()=>assert.equal(pill.dataset.kbArtifactNative,'true'));
  assert.equal(pill.hasAttribute('data-kb-card-tab'),false);
  assert.equal(pill.dataset.kbSection,first);
  assert.equal(host.querySelectorAll(`[data-kanban-artifacts="${first}"] [data-artifact-key="native:document"]`).length,1);
  await waitFor(()=>assert.equal(host.querySelector('[data-artifact-key="native:document"]').getAttribute('aria-selected'),'true'));
});

test('restored browser documents keep their adjacent main tab while another main tab is selected',async t=>{
  const first=crypto.randomUUID(),second=crypto.randomUUID(),host=document.createElement('div');
  host.innerHTML=`<main></main><aside><header data-testid="thread-secondary-panel-top-chrome"><div data-sidebar-split-tab-group="pane">
    <div data-tab-pill><button aria-pressed="false">Home A</button></div>
    <div data-tab-pill><button aria-pressed="false">Document</button></div>
    <div data-tab-pill><button aria-pressed="true">Home B</button></div>
    </div></header><div data-kanban-section="${second}"></div></aside>`;
  document.body.append(host);
  sectionStore.replace(first,{kind:'chat',threadId:'a',title:'A'});
  sectionStore.replace(second,{kind:'chat',threadId:'b',title:'B'});
  const home=(id,title)=>({key:id,title,status:null,closable:true,detail:{kind:'plugin',pluginId:'thread-kanban',
    tab:{id:'context',context:{kind:'nav-panel',panelId:'board'}},params:{sectionId:id}}});
  const tabs=[home(first,'Home A'),{key:'restored-browser',title:'Document',status:null,closable:true,detail:{kind:'browser',url:'https://example.org'}},home(second,'Home B')];
  const slot=renderSlot({component:PanelContextBridge},{surface:{current:host.querySelector('main')}},{
    sdk:{threads:{get:async()=>({environmentId:null})}},experimental_panelTabs:{open:true,selectedKey:second,tabs},
  });
  t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  const pill=host.querySelectorAll('[data-tab-pill]')[1];
  await waitFor(()=>assert.equal(pill.dataset.kbArtifactNative,'true'));
  assert.equal(pill.dataset.kbSection,first);
  assert.equal(host.querySelector('[data-artifact-key]'),null);
});

test('opening a second and third equal-title browser keeps the row, exact SDK keys, selection and independent main tabs',async t=>{
  const first=crypto.randomUUID(),second=crypto.randomUUID(),host=document.createElement('div');
  host.innerHTML=`<main></main><aside><header data-testid="thread-secondary-panel-top-chrome"><div data-sidebar-split-tab-group="pane"></div></header><div data-kanban-section="${first}"></div></aside>`;
  document.body.append(host);
  const group=host.querySelector('[data-sidebar-split-tab-group]');
  const home=(key,title)=>({key,title,status:null,closable:true,detail:{kind:'plugin',pluginId:'thread-kanban',tab:{id:'context',context:{kind:'nav-panel',panelId:'board'}},params:{sectionId:key}}});
  const browser=number=>({key:`browser-${number}`,title:'same.example',status:null,closable:true,detail:{kind:'browser',url:`https://same.example/${number}`}});
  const snapshot={open:true,selectedKey:'browser-1',tabs:[home(first,'Home A'),browser(1),home(second,'Home B')]};
  const pills=new Map(),calls=[];
  function addPill(tab){const pill=document.createElement('div');pill.setAttribute('data-tab-pill','');const button=document.createElement('button');button.textContent=tab.title;button.setAttribute('aria-pressed',String(tab.key===snapshot.selectedKey));pill.append(button);group.append(pill);pills.set(tab.key,pill);}
  snapshot.tabs.forEach(addPill);
  function select(key){if(calls.length>100)throw Error(`Unexpected selection loop at ${key}`);calls.push(['select',key]);snapshot.selectedKey=key;for(const [id,pill] of pills){const button=pill.querySelector('button'),selected=String(id===key);if(button.getAttribute('aria-pressed')!==selected)button.setAttribute('aria-pressed',selected);}return true;}
  sectionStore.replace(first,{kind:'chat',threadId:'a',title:'A'});sectionStore.replace(second,{kind:'chat',threadId:'b',title:'B'});
  // This fixture publishes the native snapshot and its corresponding DOM together,
  // as the host does; its MutationObserver drives the adapter after each publication.
  const slot=renderSlot({component:PanelContextBridge},{surface:{current:host.querySelector('main')}},{
    sdk:{threads:{get:async()=>({environmentId:null})}},experimental_panelTabs:snapshot,
    experimental_panel:{getTabs:()=>snapshot,selectTab:select,closeTab:key=>{
      calls.push(['close',key]);snapshot.tabs=snapshot.tabs.filter(tab=>tab.key!==key);pills.get(key)?.remove();pills.delete(key);if(snapshot.selectedKey===key)select(first);return true;
    }},
  });
  t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,1));
  for(const number of [2,3]){
    await act(async()=>{const tab=browser(number);snapshot.tabs.push(tab);addPill(tab);select(tab.key);});
    await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,number));
    await waitFor(()=>assert.equal(host.querySelector('[data-artifact-key][aria-selected=true]')?.dataset.artifactKey,`native:browser-${number}`));
    for(let index=1;index<=number;index++)assert.equal(pills.get(`browser-${index}`).dataset.kbArtifactNative,'true');
    assert.equal(host.querySelectorAll('[data-kb-card-tab=true]').length,2);
  }
  const captions=[...host.querySelectorAll('.kb-artifact-title')].map(e=>e.textContent);
  assert.equal(new Set(captions).size,3);
  for(const number of [1,2,3]){
    fireEvent.click(host.querySelector(`[data-artifact-key="native:browser-${number}"]`));
    assert.deepEqual(calls.at(-1),['select',`browser-${number}`]);
  }
  await act(async()=>{select(second);host.querySelector('[data-kanban-section]').dataset.kanbanSection=second;});
  await waitFor(()=>assert.equal(!!host.querySelector('[data-kanban-artifacts]'),false));
  await act(async()=>{select(first);host.querySelector('[data-kanban-section]').dataset.kanbanSection=first;});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,3));
  await waitFor(()=>assert.equal(snapshot.selectedKey,'browser-3'));
  for(const number of [3,2,1]){
    fireEvent.click(host.querySelector(`[data-artifact-key="native:browser-${number}"]`).parentElement.querySelector('.kb-artifact-close'));
    await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,number-1));
  }
  assert.equal(!!host.querySelector('[data-kanban-artifacts]'),false);
});

test('already-open equal-title browser tabs recover without creating replacements or using their DOM order as IDs',async t=>{
  const id=crypto.randomUUID(),host=document.createElement('div');
  host.innerHTML=`<main></main><aside><header data-testid="thread-secondary-panel-top-chrome"><div data-sidebar-split-tab-group="pane">
    <div data-tab-pill><button aria-pressed="true">Home</button></div>
    <div data-tab-pill><button aria-pressed="false">same.example</button></div>
    <div data-tab-pill><button aria-pressed="false">same.example</button></div></div></header><div data-kanban-section="${id}"></div></aside>`;
  document.body.append(host);sectionStore.replace(id,{kind:'chat',threadId:'restore',title:'Restore'});
  const tabs=[{key:id,title:'Home',status:null,closable:true,detail:{kind:'plugin',pluginId:'thread-kanban',tab:{id:'context',context:{kind:'nav-panel',panelId:'board'}},params:{sectionId:id}}},
    ...['two','one'].map(key=>({key,title:'same.example',status:null,closable:true,detail:{kind:'browser',url:`https://same.example/${key}`}}))];
  const calls=[];const slot=renderSlot({component:PanelContextBridge},{surface:{current:host.querySelector('main')}},{sdk:{threads:{get:async()=>({environmentId:null})}},experimental_panelTabs:{open:true,selectedKey:id,tabs},experimental_panel:{selectTab:key=>(calls.push(key),true)}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,2));
  for(const key of ['one','two']){fireEvent.click(host.querySelector(`[data-artifact-key="native:${key}"]`));assert.equal(calls.at(-1),key);}
  assert.equal([...host.querySelectorAll('[data-tab-pill]')].slice(1).every(pill=>pill.dataset.kbArtifactNative==='true'),true);
});

test('replacing a card in the same main tab hides its browser bundle and restores it after a panel remount',async t=>{
  const id=crypto.randomUUID(),host=document.createElement('div');
  host.innerHTML=`<main></main><aside><header data-testid="thread-secondary-panel-top-chrome"><div data-sidebar-split-tab-group="pane"><div data-tab-pill><button aria-pressed="true">Home</button></div></div></header><div data-kanban-section="${id}"></div></aside>`;
  document.body.append(host);
  const card=key=>({kind:'issue',issueId:key,title:`Card ${key}`,threadId:`thread-${key}`,request:0,startWithAssistant:false});
  sectionStore.replace(id,card('A'));
  const home={key:id,title:'Home',status:null,closable:true,detail:{kind:'plugin',pluginId:'thread-kanban',tab:{id:'context',context:{kind:'nav-panel',panelId:'board'}},params:{sectionId:id}}};
  const browsers=Array.from({length:4},(_,index)=>({key:`${id}:browser-${index}`,title:'same.example',status:null,closable:true,detail:{kind:'browser',url:`https://same.example/${index}`}}));
  const snapshot={open:true,selectedKey:id,tabs:[home,...browsers]},pills=new Map([[id,host.querySelector('[data-tab-pill]')]]),calls=[];
  for(const tab of browsers){const pill=document.createElement('div');pill.setAttribute('data-tab-pill','');pill.innerHTML='<button aria-pressed="false">same.example</button>';host.querySelector('[data-sidebar-split-tab-group]').append(pill);pills.set(tab.key,pill);}
  const selectTab=key=>{calls.push(key);snapshot.selectedKey=key;for(const [id,pill] of pills){const button=pill.querySelector('button'),value=String(id===key);if(button.getAttribute('aria-pressed')!==value)button.setAttribute('aria-pressed',value);}return true;};
  const surface={current:host.querySelector('main')};
  const mount=()=>renderSlot({component:PanelContextBridge},{surface},{sdk:{threads:{get:async()=>({environmentId:null})}},experimental_panelTabs:snapshot,experimental_panel:{getTabs:()=>snapshot,selectTab}});
  let slot=mount();t.after(()=>{slot.lifecycle.unmount();cleanup();host.remove();});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,4));
  fireEvent.click(host.querySelector(`[data-artifact-key="native:${browsers[2].key}"]`));
  assert.equal(artifactStore.get(artifactOwner(id,'issue:A')),`native:${browsers[2].key}`);
  await act(async()=>{sectionStore.replace(id,card('B'));selectTab(id);});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,0));
  assert.equal(artifactStore.get(artifactOwner(id,'issue:B')),null);
  await act(async()=>{slot.lifecycle.unmount();});
  slot=mount();
  await waitFor(()=>assert.equal(!!host.querySelector('.kb-artifact-mount'),true));
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,0));
  const bTab={key:`${id}:B-browser`,title:'B.example',status:null,closable:true,detail:{kind:'browser',url:'https://B.example/own'}};
  await act(async()=>{
    snapshot.tabs.push(bTab);const pill=document.createElement('div');pill.setAttribute('data-tab-pill','');pill.innerHTML='<button aria-pressed="false">B.example</button>';
    host.querySelector('[data-sidebar-split-tab-group]').append(pill);pills.set(bTab.key,pill);selectTab(bTab.key);
  });
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,1));
  await waitFor(()=>assert.equal(artifactStore.get(artifactOwner(id,'issue:B')),`native:${bTab.key}`));
  await act(async()=>{sectionStore.replace(id,card('A'));selectTab(id);});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,4));
  await waitFor(()=>assert.equal(snapshot.selectedKey,browsers[2].key));
  assert.equal(!!host.querySelector(`[data-artifact-key="native:${bTab.key}"]`),false);
  await act(async()=>{sectionStore.replace(id,card('B'));selectTab(id);});
  await waitFor(()=>assert.equal(host.querySelectorAll('[data-artifact-key]').length,1));
  await waitFor(()=>assert.equal(snapshot.selectedKey,bTab.key));
  assert.equal(host.querySelectorAll('[data-tab-pill][data-kb-artifact-native=true]').length,5);
});
