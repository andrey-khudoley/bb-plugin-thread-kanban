import assert from 'node:assert/strict';
import test from 'node:test';
import { replacementTabKey } from './panel-tab-selection.ts';

const tabs = [
  {key:'first',contextId:'a',kind:'plugin'},
  {key:'second',contextId:'b',kind:'plugin'},
  {key:'file',contextId:null,kind:'file'},
];
const owners = new Map([['file','b']]);
const groups = new Map();

test('an explicit empty tab is filled while the previously opened tab stays intact', () => {
  assert.equal(replacementTabKey(tabs,'first','b',owners,groups),'second');
  assert.equal(tabs.length,3);
});
test('without a new tab each next card replaces the active tab', () => {
  assert.equal(replacementTabKey(tabs,'first','a',owners,groups),'first');
  assert.equal(replacementTabKey(tabs,'second','b',owners,groups),'second');
});
test('a selected file resolves to its card tab and a closed focused tab is ignored', () => {
  assert.equal(replacementTabKey(tabs,'file','closed',owners,groups),'second');
});
test('a native new-tab launcher creates another card tab', () => {
  assert.equal(replacementTabKey([...tabs,{key:'new',contextId:null,kind:'new-tab'}],'new','a',owners,groups),null);
});
