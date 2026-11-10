import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom=new JSDOM('<!doctype html><body></body>',{url:'http://localhost',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage']) Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
globalThis.innerWidth=1280;globalThis.innerHeight=720;
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
dom.window.HTMLElement.prototype.getClientRects=function(){return [{x:0,y:0,width:640,height:400}]};
dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:90,left:0,top:90,right:640,bottom:490,width:640,height:400}};
const {renderSlot}=await import('@get-bb/plugin-sdk/testing/app');
const {waitFor,cleanup,act,fireEvent}=await import('@testing-library/react');
await build({stdin:{contents:`import {useState} from 'react'; import {useBrowserArtifacts} from './browser-artifacts'; export {BrowserArtifactContent} from './browser-artifacts'; export function Probe(){const result=useBrowserArtifacts('thread');return <pre>{JSON.stringify(result)}</pre>;} export function SwitchingProbe(){const [thread,setThread]=useState('thread');const result=useBrowserArtifacts(thread);return <><button onClick={()=>setThread('other')}>Switch</button><pre>{JSON.stringify(result)}</pre></>;}`,
  resolveDir:process.cwd(),loader:'tsx'},outfile:'dist/browser-artifacts-test.mjs',bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic'});
const {BrowserArtifactContent,Probe,SwitchingProbe}=await import('./dist/browser-artifacts-test.mjs');
const scope={hostId:'local',instanceId:'window',generation:'generation'};
const tab={key:'browser:window:existing',tabId:'existing',threadId:'thread',title:'Page',url:'https://example.org',scope,controlled:false};

test('a hidden browser attaches by its existing ID, displays real native bounds and hides without detaching on unmount',async t=>{
  const calls=[];window.bbDesktop={browser:{getTarget:async()=>scope,onState:()=>()=>calls.push(['unsubscribe']),
    attach:input=>calls.push(['attach',input]),setBounds:input=>calls.push(['bounds',input]),setVisible:input=>calls.push(['visible',input]),setVisibleWithoutFocus:input=>calls.push(['no-focus',input])}};
  const slot=renderSlot({component:BrowserArtifactContent},{tab});
  t.after(()=>{cleanup();delete window.bbDesktop;});
  await waitFor(()=>assert.equal(calls.some(([kind])=>kind==='no-focus'),true));
  const input=calls.find(([kind])=>kind==='attach')[1];
  assert.equal(input.tabId,'existing');assert.equal(input.threadId,'thread');assert.equal(input.existingOnly,true);
  assert.deepEqual(input.bounds,{x:0,y:90,width:640,height:400});
  const menu=document.createElement('div');menu.setAttribute('role','dialog');document.body.append(menu);
  await waitFor(()=>assert.equal(calls.some(([kind,input])=>kind==='visible'&&input.visible===false),true));
  menu.remove();
  await waitFor(()=>assert.equal(calls.filter(([kind])=>kind==='no-focus').length,2));
  slot.lifecycle.unmount();
  assert.equal(calls.at(-1)[1].visible,false);
  assert.equal(calls.some(([kind])=>kind==='detach'),false);
});
test('a browser from another desktop window never attaches or creates a replacement',async t=>{
  let attached=false;window.bbDesktop={browser:{getTarget:async()=>({...scope,instanceId:'another'}),onState:()=>()=>{},attach:()=>{attached=true},setBounds:()=>{},setVisible:()=>{}}};
  const slot=renderSlot({component:BrowserArtifactContent},{tab});
  t.after(()=>{slot.lifecycle.unmount();cleanup();delete window.bbDesktop;});
  await waitFor(()=>assert.match(slot.container.textContent,/другом окне/));assert.equal(attached,false);
});
test('discovery includes hidden agent sessions on both the desktop and execution host, filters the thread and disposes subscriptions',async t=>{
  window.bbDesktop={browser:{getTarget:async()=>scope,attach(){},setBounds(){},setVisible(){},onState:()=>()=>{}}};
  const watched=[],disposed=[];
  const slot=renderSlot({component:Probe},{},{sdk:{threads:{get:async()=>({environmentId:'env'})},environments:{get:async()=>({hostId:'remote'})},
    experimental_desktopBrowsers:{listInstances:async({hostId})=>({instances:[{instanceId:hostId,generation:'g'}]}),subscribe:input=>{
      watched.push(input);queueMicrotask(()=>input.onChange({tabs:[{tabId:input.hostId,threadId:'thread',title:'Hidden',url:'https://example.org',presentation:'hidden',control:null},{tabId:'foreign',threadId:'other',title:'Other',url:'https://example.com',control:null}]}));
      return {dispose(){disposed.push(input.hostId)}};
    }}}});
  t.after(()=>{slot.lifecycle.unmount();cleanup();delete window.bbDesktop;});
  await waitFor(()=>assert.equal(JSON.parse(slot.container.textContent).tabs.length,2));
  assert.deepEqual(new Set(watched.map(input=>input.hostId)),new Set(['local','remote']));
  assert.equal(JSON.parse(slot.container.textContent).tabs.some(tab=>tab.tabId==='foreign'),false);
  slot.lifecycle.unmount();assert.deepEqual(new Set(disposed),new Set(['local','remote']));
});
test('failed discovery for a replacement chat never relabels the previous chat browsers as its own',async t=>{
  delete window.bbDesktop;
  const slot=renderSlot({component:SwitchingProbe},{},{sdk:{
    threads:{get:async({threadId})=>{if(threadId==='other')throw Error('unavailable');return {environmentId:'env'}}},
    environments:{get:async()=>({hostId:'remote'})},experimental_desktopBrowsers:{
      listInstances:async()=>({instances:[{instanceId:'remote',generation:'g'}]}),
      subscribe:input=>{queueMicrotask(()=>input.onChange({tabs:[{tabId:'a',threadId:'thread',title:'A',url:'https://example.org',control:null}]}));return {dispose(){}}},
    },
  }});
  t.after(()=>{slot.lifecycle.unmount();cleanup();});
  const read=()=>JSON.parse(slot.container.querySelector('pre').textContent);
  await waitFor(()=>assert.equal(read().tabs.length,1));
  fireEvent.click(slot.getByRole('button',{name:'Switch'}));
  await waitFor(()=>assert.equal(read().error,'unavailable'));
  assert.equal(read().threadId,'other');assert.deepEqual(read().tabs,[]);
});
