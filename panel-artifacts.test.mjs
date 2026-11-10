import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactStore, createNativeArtifactOwners, artifactOwner, afterArtifactClose } from './panel-artifacts.ts';

test('each main tab and replacement card keeps its own selection, including the same chat in two tabs', () => {
  const store = createArtifactStore();
  const a = artifactOwner('one', 'chat:a'), b = artifactOwner('two', 'chat:b'), copy = artifactOwner('two', 'chat:a');
  store.select(a, 'browser:existing-id'); store.select(b, 'native:file10');
  assert.equal(store.get(copy), null);
  store.select(copy, 'native:other-file');
  assert.equal(store.get(a), 'browser:existing-id');
  assert.equal(store.get(b), 'native:file10');
  store.select(a, null);
  assert.equal(store.get(b), 'native:file10');
});
test('closing active first, middle, last, background and only artifacts chooses a live neighbour or the chat', () => {
  assert.equal(afterArtifactClose(['a','b','c'], 'a', 'a'), 'b');
  assert.equal(afterArtifactClose(['a','b','c'], 'b', 'b'), 'c');
  assert.equal(afterArtifactClose(['a','b','c'], 'c', 'c'), 'b');
  assert.equal(afterArtifactClose(['a','b','c'], 'b', 'a'), 'b');
  assert.equal(afterArtifactClose(['a'], 'a', 'a'), null);
});

function storage() {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};}

test('native ownership survives panel/runtime recreation and never moves an already-open artifact to the replacement card',()=>{
  const session=storage(),a={section:'one',card:'issue:A'},b={section:'one',card:'issue:B'};
  const first=createNativeArtifactOwners(()=>session);first.set('live-browser',a);
  const recreated=createNativeArtifactOwners(()=>session);
  assert.deepEqual(recreated.get('live-browser'),a);
  recreated.set('live-browser',b);
  assert.deepEqual(recreated.get('live-browser'),a);
  recreated.set('other-browser',b);
  assert.deepEqual(recreated.get('other-browser'),b);
  recreated.delete('live-browser');
  assert.equal(recreated.has('live-browser'),false);
  recreated.set('live-browser',b);
  assert.deepEqual(recreated.get('live-browser'),b);
});

test('native ownership is window-session scoped and handles malformed or unavailable session storage',()=>{
  const first=storage(),second=storage();
  createNativeArtifactOwners(()=>first).set('same-key',{section:'one',card:'issue:A'});
  assert.equal(createNativeArtifactOwners(()=>second).has('same-key'),false);
  const broken=createNativeArtifactOwners(()=>({getItem:()=>JSON.stringify([['key',{section:123,card:'A'}]]),setItem:()=>{throw Error('unavailable')}}));
  assert.equal(broken.get('key'),undefined);
  broken.set('new',{section:'two',card:'issue:B'});
  assert.deepEqual(broken.get('new'),{section:'two',card:'issue:B'});
  broken.retain(new Set());assert.equal(broken.get('new'),undefined);
});
