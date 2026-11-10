import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTabLabels } from './panel-tab-labels.ts';

function fixture() {
  const dom = new JSDOM('<div data-tab-pill><button aria-pressed="true"><svg data-icon="MessageSquare"></svg><span class="truncate" title="Вкладка 6">Вкладка 6</span></button><button data-tab-pill-close aria-label="Close Вкладка 6">×</button></div>');
  const pill=dom.window.document.querySelector('[data-tab-pill]');
  return {dom,pill,button:pill.querySelector('[aria-pressed]'),close:pill.querySelector('[data-tab-pill-close]')};
}

test('a card title updates in the same native tab without replacing its nodes or handlers', () => {
  const {dom,pill,button,close}=fixture();const node=button.querySelector('span').firstChild;const icon=button.querySelector('svg');
  let clicks=0;button.addEventListener('click',()=>clicks++);
  const labels=createTabLabels(),tab={key:'tab-6',title:'Вкладка 6'};
  labels.show(pill,tab,'Первая карточка');labels.show(pill,tab,'Вторая карточка');button.click();
  assert.equal(node.data,'Вторая карточка');assert.strictEqual(button.querySelector('span').firstChild,node);
  assert.strictEqual(button.querySelector('svg'),icon);assert.equal(clicks,1);
  assert.equal(button.title,'Вторая карточка');assert.equal(close.getAttribute('aria-label'),'Close Вторая карточка');
  assert.equal(button.querySelector('span').title,'Вторая карточка');
  labels.clear();assert.equal(node.data,'Вкладка 6');assert.equal(button.hasAttribute('title'),false);
  assert.equal(button.querySelector('span').title,'Вкладка 6');
  assert.equal(close.getAttribute('aria-label'),'Close Вкладка 6');dom.window.close();
});

test('identical displayed card titles keep separate runtime tab identities', () => {
  const one=fixture(),two=fixture();const labels=createTabLabels();
  const tabs=[{key:'a',title:'Вкладка 6'},{key:'b',title:'Вкладка 7'}];
  two.button.querySelector('span').textContent='Вкладка 7';
  labels.show(one.pill,tabs[0],'Одинаковая карточка');labels.show(two.pill,tabs[1],'Одинаковая карточка');
  assert.equal(labels.resolve(one.pill,tabs,()=>null)?.key,'a');assert.equal(labels.resolve(two.pill,tabs,()=>null)?.key,'b');
  labels.retain(new Set([two.pill]));assert.equal(one.button.textContent,'Вкладка 6');
  labels.clear();one.dom.window.close();two.dom.window.close();
});

test('a native rerender can restore its original label and it is decorated again', () => {
  const {dom,pill,button}=fixture();const labels=createTabLabels(),tab={key:'a',title:'Вкладка 6'};
  labels.show(pill,tab,'Карточка');button.querySelector('span').firstChild.data='Вкладка 6';
  assert.equal(labels.resolve(pill,[tab],()=>null),tab);labels.show(pill,tab,'Новое название');
  assert.equal(button.textContent,'Новое название');labels.clear();dom.window.close();
});
