import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';

function surface() {
  return { minted: 4, history: {}, layout: {
    nodes: { pane1: { id: 'pane1', kind: 'pane', host: 'dock', tabs: ['tab2', 'tab3'], activeTabId: 'tab3' } },
    tabs: { tab2: { id: 'tab2', kind: 'files', contentId: 'files', title: '文件' }, tab3: { id: 'tab3', kind: 'document', contentId: 'report.pdf', title: 'report.pdf' } },
    rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
  } };
}

test('independent folder toggle survives history collapse and never changes preview visibility', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"><div data-slot="sidebar" style="display:contents"><nav id="history"><button aria-label="收起侧边栏">原生会话开关</button></nav></div><main id="center"><div data-slot="main.conversation" style="display:contents"><div id="chat">原有聊天</div></div></main><section id="preview"></section></div></body></html>', { url: 'http://localhost' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const center = document.getElementById('center'), history = document.getElementById('history'), chat = document.getElementById('chat');
  const frame = center.parentElement;
  frame.getBoundingClientRect = () => ({ width: 1800, left: 0, top: 0 });
  center.getBoundingClientRect = () => ({ width: 1100 });
  class ResizeObserver { observe() {} disconnect() {} }
  let plugin;
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(id => ({ react: React, 'react-dom': ReactDOM })[id]); } };
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document, getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver,
    MutationObserver: window.MutationObserver, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  });
  let state = { bySession: { first: surface() } }; const listeners = new Set();
  const update = callback => { state = callback(state); for (const listener of listeners) listener(); };
  const useStore = selector => selector(React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state));
  const actions = {
    setExpanded(id, expanded) { update(previous => ({ bySession: { [id]: { ...previous.bySession[id], layout: { ...previous.bySession[id].layout, expanded } } } })); },
    toggleExpanded(id) { this.setExpanded(id, !state.bySession[id].layout.expanded); },
  };
  function NativeSeat(props) {
    const value = props.useStore(current => current.bySession[props.sessionId]);
    if (!props.active || !value.layout.expanded) return null;
    return React.createElement('section', { className: 'host-native-panel' },
      React.createElement('nav', { className: 'host-native-tabstrip', 'data-dockkit-strip': 'pane1' },
        Object.values(value.layout.tabs).map(tab => React.createElement('span', { className: 'host-native-tab', key: tab.id }, tab.title)),
        React.createElement('button', { 'data-dockkit-add-tab': 'pane1' }, '+'),
        React.createElement('span', null, React.createElement('button', { 'data-dockkit-split-button': 'pane1' }, '原生分栏')),
        React.createElement('div', { 'data-dockkit-strip-chrome': '' },
          React.createElement('button', { 'data-sidebar-right-mode': 'fullscreen' }, '原生全屏'),
          React.createElement('button', { 'data-sidebar-right-toggle': '', onClick: () => props.actions.toggleExpanded(props.sessionId) }, '原生侧栏收起'))),
      React.createElement('div', { className: 'host-native-content' }, '原生面板内容'));
  }
  const entry = { id: 'native', component: NativeSeat, priority: 0, children: { 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' } } };
  const disposers = []; let overlay, openedFiles = 0;
  const ctx = {
    effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
    slots: {
      inject(_key, callback) { return callback(); }, entries(key) { return key === 'rightbar.session' ? [entry] : []; },
      register(options, component) { assert.equal(options.children, undefined); if (options.name === 'shell.overlay') overlay = { options, component }; return () => {}; },
    },
    sidebarRight: {
      mounted: { getSnapshot: () => 'first', subscribe: () => () => {} },
      openTab(kind) {
        assert.equal(kind, 'files'); openedFiles++;
        update(previous => {
          const next = structuredClone(previous), layout = next.bySession.first.layout;
          layout.tabs.tab2 = { id: 'tab2', kind: 'files', contentId: 'files', title: '文件' };
          layout.nodes.pane1.tabs.unshift('tab2'); layout.expanded = true; return next;
        });
      },
    },
  };
  plugin.apply(ctx);
  const root = createRoot(document.getElementById('preview'));
  const props = { sessionId: 'first', active: true, useStore, actions, width: 500, viewportWidth: 1800,
    syncPresentation() {}, measureRoom() {}, reportAutoFullscreen() {}, t: key => key };
  await React.act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(entry.component, props), React.createElement(overlay.component, overlay.options.inject()))));
  const button = () => document.querySelector('[data-dsh-files-toggle]');
  const click = element => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const left = document.querySelector('[data-dsh-native-files-left]');
  assert.ok(left); assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(button().parentElement.nextSibling, history.querySelector('[aria-label="收起侧边栏"]'));
  assert.equal(window.getComputedStyle(left.querySelector('[data-dockkit-split-button]')).display, 'none');
  assert.equal(window.getComputedStyle(left.querySelector('[data-dockkit-strip-chrome]')).display, 'none');
  assert.equal(window.getComputedStyle(left.querySelector('[data-dockkit-add-tab]')).display, 'none');
  assert.notEqual(window.getComputedStyle(document.querySelector('#preview [data-dockkit-strip-chrome]')).display, 'none');
  assert.equal(document.getElementById('history'), history); assert.equal(document.getElementById('chat'), chat);

  await React.act(async () => click(document.querySelector('#preview [data-sidebar-right-toggle]')));
  assert.equal(state.bySession.first.layout.expanded, false);
  assert.ok(document.querySelector('[data-dsh-native-files-left]'), 'closing preview must not close files');
  await React.act(async () => click(button()));
  assert.equal(document.querySelector('[data-dsh-native-files-left]'), null);
  assert.equal(center.style.getPropertyValue('--dsh-native-files-width'), '');
  assert.ok(state.bySession.first.layout.tabs.tab2, 'hiding files retains its native tab and tree state');
  await React.act(async () => click(button()));
  assert.ok(document.querySelector('[data-dsh-native-files-left]'));
  assert.equal(state.bySession.first.layout.expanded, false, 'opening files must not open preview');
  assert.equal(openedFiles, 0, 'existing file tabs must be reused');

  // Missing native file tab: seed it, then restore the previous preview state.
  await React.act(async () => update(previous => {
    const next = structuredClone(previous); delete next.bySession.first.layout.tabs.tab2;
    next.bySession.first.layout.nodes.pane1.tabs = ['tab3']; return next;
  }));
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  await React.act(async () => click(button()));
  assert.equal(openedFiles, 1); assert.equal(state.bySession.first.layout.expanded, false);
  assert.ok(document.querySelector('[data-dsh-native-files-left]'));

  document.documentElement.dataset.platform = 'darwin';
  const leading = document.createElement('div'); leading.setAttribute('data-shell-leading', '');
  const controls = document.createElement('div'); leading.append(controls);
  const openHistory = document.createElement('button'), newSession = document.createElement('button');
  openHistory.setAttribute('aria-label', '打开侧边栏'); newSession.setAttribute('aria-label', '新建会话');
  controls.append(openHistory, newSession);
  leading.getBoundingClientRect = () => ({ width: 100, height: 28 });
  const pane = document.querySelector('[data-dsh-native-files-left]');
  pane.getBoundingClientRect = () => ({ right: 400, left: 0, width: 400 });
  pane.querySelector('[data-dockkit-strip]').getBoundingClientRect = () => ({ top: 0, height: 48 });
  await React.act(async () => {
    frame.append(leading); frame.setAttribute('data-sidebar-collapsed', '');
    frame.style.gridTemplateColumns = '0px minmax(400px, 1fr) minmax(0px, 500px)';
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(controls.firstElementChild, button().parentElement);
  assert.equal(button().parentElement.nextSibling, openHistory);
  assert.equal(frame.style.getPropertyValue('--dsh-files-leading-x'), '292px');
  await React.act(async () => click(button()));
  assert.equal(document.querySelector('[data-dsh-native-files-left]'), null);
  assert.ok(button().isConnected, 'file toggle remains available with both panes hidden');
  await React.act(async () => click(button()));
  assert.ok(document.querySelector('[data-dsh-native-files-left]'));
  assert.equal(state.bySession.first.layout.expanded, false);

  await React.act(async () => root.unmount());
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(entry.component, NativeSeat);
  assert.equal(document.querySelector('[data-dsh-files-toggle]'), null);
  assert.equal(frame.hasAttribute('data-dsh-native-files-frame'), false);
  assert.equal(frame.hasAttribute('data-dsh-files-button-frame'), false);
  assert.equal(document.querySelector('style[data-plugin="dsh-three-pane"]'), null);
  assert.equal(listeners.size, 0); dom.window.close();
});
