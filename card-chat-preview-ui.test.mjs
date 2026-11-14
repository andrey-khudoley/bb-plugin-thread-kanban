import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'KeyboardEvent'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.assign(globalThis, { innerWidth: 900, innerHeight: 700, ResizeObserver: class { observe() {} disconnect() {} } });
await build({ stdin: { contents: `export { useCardTags } from './card-tags'; export { CardChatPreview } from './card-chat-preview-ui';`,
  resolveDir: process.cwd(), loader: 'ts' }, outfile: 'dist/card-chat-preview-ui-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm' });
const { useCardTags } = await import('./dist/card-chat-preview-ui-test.mjs');
const React = await import('react');
const { createPortal } = await import('react-dom');
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { act, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function Card({ tags = [], threadId = 'chat' }) {
  const hover = useCardTags(tags, threadId, 'Чат 2 из 2');
  return React.createElement('article', { ...hover.bindings, 'data-testid': 'card' }, 'Название', hover.tooltip);
}

function MenuCard({ alwaysPortal = false }) {
  const hover=useCardTags([], 'chat');
  const [open,setOpen]=React.useState(false);
  return React.createElement('article',{...hover.bindings,'data-testid':'card'},
    React.createElement('button',{'data-testid':'menu-trigger','aria-haspopup':'menu','aria-expanded':open,
      onClick:()=>{hover.onMenuOpenChange(!open);setOpen(!open);}},'…'),
    (open||alwaysPortal)&&createPortal(React.createElement('div',{role:'menu'},
      React.createElement('button',{role:'menuitem'},'Открыть карточку'),
      React.createElement('button',{role:'menuitem'},'Открыть ветку')),document.body),hover.tooltip);
}

test('a chat without tags fetches only after dwell; eight lines remain open under the pointer and close on Escape', async t => {
  let reads = 0;
  const slot = renderSlot({ component: Card }, {}, { rpc: { cardChatPreview: () => {
    reads++; return { threadId: 'chat', lines: Array.from({length:8},(_,i)=>({key:String(i),role:'assistant',text:`Строка ${i+1}`})) };
  } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  assert.equal(reads,0);
  await act(async()=>{fireEvent.pointerEnter(slot.getByTestId('card'));await sleep(350);});
  assert.equal(reads,0); assert.equal(document.querySelector('[role="tooltip"]'),null);
  await act(async()=>{await sleep(320);});
  await waitFor(()=>assert.equal(document.querySelectorAll('.kb-card-chat-line').length,8));
  assert.equal(reads,1); assert.match(document.querySelector('.kb-card-chat-heading').textContent,/Чат 2 из 2/);
  const popup=document.querySelector('[role="tooltip"]');
  await act(async()=>{fireEvent.pointerLeave(slot.getByTestId('card'),{relatedTarget:popup});fireEvent.pointerEnter(popup);await sleep(200);});
  assert.ok(document.querySelector('[role="tooltip"]'));
  act(()=>fireEvent.pointerDown(popup)); assert.ok(document.querySelector('[role="tooltip"]'));
  act(()=>fireEvent.keyDown(window,{key:'Escape'}));
  assert.equal(document.querySelector('[role="tooltip"]'),null);
});

test('chatless cards keep tags available and never request a transcript', async t => {
  let reads=0;
  const slot = renderSlot({ component: Card }, { tags:['Test'],threadId:null }, { rpc:{ cardChatPreview:()=>{reads++;throw new Error('Unexpected');} } });
  t.after(()=>{slot.lifecycle.unmount();cleanup();});
  await act(async()=>{fireEvent.pointerEnter(slot.getByTestId('card'));await sleep(670);});
  assert.equal(document.querySelector('.kb-card-tags-items').textContent,'Test');
  assert.equal(document.querySelector('.kb-card-chat-preview'),null);assert.equal(reads,0);
});

test('keyboard focus opens after automatic scrolling settles, without the hover dwell', async t => {
  const slot=renderSlot({component:Card},{},{rpc:{cardChatPreview:()=>({threadId:'chat',lines:[{key:'one',role:'assistant',text:'Ответ'}]})}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();});
  act(()=>{slot.getByTestId('card').focus();document.dispatchEvent(new dom.window.Event('scroll'));});
  await waitFor(()=>assert.equal(document.querySelector('.kb-card-chat-text')?.textContent,'Ответ'),{timeout:500});
});

test('focus from a menu portal outside the card DOM never starts a preview', async t => {
  let reads=0;
  const slot=renderSlot({component:MenuCard},{alwaysPortal:true},{rpc:{cardChatPreview:()=>{reads++;return{threadId:'chat',lines:[]};}}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();});
  for(const item of document.querySelectorAll('[role="menuitem"]')) {
    act(()=>item.focus()); await act(async()=>{await sleep(90);});
  }
  assert.equal(document.querySelector('.kb-card-tags'),null);assert.equal(reads,0);
});

test('opening a menu cancels pending hover and suppresses item focus, card hover and focus restoration', async t => {
  let reads=0;
  const slot=renderSlot({component:MenuCard},{},{rpc:{cardChatPreview:()=>{reads++;return{threadId:'chat',lines:[]};}}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();});
  const card=slot.getByTestId('card'),trigger=slot.getByTestId('menu-trigger');
  await act(async()=>{fireEvent.pointerEnter(card);await sleep(150);});
  act(()=>fireEvent.click(trigger));
  for(const item of document.querySelectorAll('[role="menuitem"]')) act(()=>item.focus());
  await act(async()=>{fireEvent.pointerEnter(card);await sleep(700);});
  assert.equal(document.querySelector('.kb-card-tags'),null);assert.equal(reads,0);
  act(()=>{fireEvent.click(trigger);trigger.focus();});
  await act(async()=>{await sleep(90);});
  assert.equal(document.querySelector('.kb-card-tags'),null);assert.equal(reads,0);
  await act(async()=>{fireEvent.pointerLeave(card);fireEvent.pointerEnter(card);await sleep(670);});
  assert.ok(document.querySelector('.kb-card-chat-preview'));assert.equal(reads,1);
  act(()=>fireEvent.click(trigger));assert.equal(document.querySelector('.kb-card-tags'),null);
});
