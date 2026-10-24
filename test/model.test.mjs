import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSurface, createProjection, filesWidth, paneWidths, createFilesControl } from '../src/model.js';

export function fixture() {
  return { minted: 9, history: {}, layout: {
    nodes: { pane1: { id: 'pane1', kind: 'pane', host: 'dock', tabs: ['tab2', 'tab3', 'tab4'], activeTabId: 'tab3' } },
    tabs: {
      tab2: { id: 'tab2', kind: 'files', contentId: 'page:files', title: '文件' },
      tab3: { id: 'tab3', kind: 'document', contentId: 'report.pdf', title: 'report.pdf' },
      tab4: { id: 'tab4', kind: 'terminal', contentId: 'terminal:1', title: '终端' },
    }, rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
  } };
}

test('same native tab IDs project into files left and previews right without mutating the host', () => {
  const source = fixture(), before = JSON.stringify(source);
  const left = projectSurface(source, 'files'), right = projectSurface(source, 'preview');
  assert.deepEqual(Object.keys(left.layout.tabs), ['tab2']);
  assert.deepEqual(Object.keys(right.layout.tabs), ['tab3', 'tab4']);
  assert.equal(left.layout.nodes.pane1.activeTabId, 'tab2');
  assert.equal(right.layout.nodes.pane1.activeTabId, 'tab3');
  assert.equal(left.layout.tabs.tab2, source.layout.tabs.tab2);
  assert.equal(JSON.stringify(source), before);
});

test('selecting files keeps the previously active preview selected', () => {
  const memory = new Map(), source = fixture();
  projectSurface(source, 'preview', memory);
  source.layout.nodes.pane1.activeTabId = 'tab2';
  assert.equal(projectSurface(source, 'preview', memory).layout.nodes.pane1.activeTabId, 'tab3');
});

test('closed native panel and absent Files tabs create no visible file surface', () => {
  const source = fixture(); source.layout.expanded = false;
  assert.equal(projectSurface(source, 'files').layout.expanded, false);
  source.layout.expanded = true; delete source.layout.tabs.tab2;
  source.layout.nodes.pane1.tabs = ['tab3', 'tab4'];
  const left = projectSurface(source, 'files');
  assert.equal(left.layout.expanded, false);
  assert.deepEqual(left.layout.nodes.pane1.tabs, []);
});

test('existing native split panes retain their original identities', () => {
  const source = fixture();
  source.layout.nodes.pane1.tabs = ['tab2']; source.layout.nodes.pane1.activeTabId = 'tab2';
  source.layout.nodes.pane5 = { id: 'pane5', kind: 'pane', host: 'dock', tabs: ['tab3', 'tab4'], activeTabId: 'tab3' };
  source.layout.nodes.split6 = { id: 'split6', kind: 'split', axis: 'row', children: ['pane1', 'pane5'], sizes: [.4, .6] };
  source.layout.rootId = 'split6';
  assert.equal(projectSurface(source, 'files').layout.rootId, 'pane1');
  assert.equal(projectSurface(source, 'preview').layout.rootId, 'pane5');
});

test('floating windows stay with the host and are not moved into the file pane', () => {
  const source = fixture();
  source.layout.tabs.tab7 = { id: 'tab7', kind: 'files', contentId: 'page:files', title: '文件' };
  source.layout.nodes.float8 = { id: 'float8', kind: 'pane', host: 'float', tabs: ['tab7'], activeTabId: 'tab7', rect: { x: 10, y: 10, width: 400, height: 500 } };
  source.layout.floats = ['float8'];
  assert.deepEqual(projectSurface(source, 'files').layout.floats, []);
  const right = projectSurface(source, 'preview');
  assert.equal(right.layout.nodes.float8, source.layout.nodes.float8);
  assert.equal(right.layout.tabs.tab7, source.layout.tabs.tab7);
});

test('projection references are stable for immutable host snapshots and independent by session', () => {
  const project = createProjection('files');
  const state = { bySession: { a: fixture(), b: fixture() } };
  assert.equal(project(state), project(state));
  const next = { bySession: { ...state.bySession, a: { ...state.bySession.a, layout: { ...state.bySession.a.layout, expanded: false } } } };
  assert.equal(project(next).bySession.a.layout.expanded, false);
  assert.equal(project(next).bySession.b.layout.expanded, true);
});

test('file pane dimensions preserve chat space where a track fits', () => {
  assert.equal(filesWidth(1100), 300);
  assert.equal(filesWidth(720, 450), 320);
  assert.equal(filesWidth(500), 220);
  assert.equal(filesWidth(1100, 900), 480);
});

test('files always reserve a track and preview yields to the normal chat area', () => {
  assert.deepEqual(paneWidths(1280, 280, 300, 576), { files: 300, preview: 300, chat: 400 });
  assert.deepEqual(paneWidths(1280, 0, 300, 576, true), { files: 400, preview: 480, chat: 400 });
  const narrow = paneWidths(500, 0, 300, 300);
  assert.equal(narrow.files, 220); assert.equal(narrow.chat, 400); assert.equal(narrow.preview, 0);
});

test('file projection can remain open while native preview is collapsed', () => {
  const source = fixture(); source.layout.expanded = false;
  assert.equal(projectSurface(source, 'files', new Map(), true).layout.expanded, true);
  assert.equal(projectSurface(source, 'preview').layout.expanded, false);
  assert.equal(source.layout.expanded, false);
});

test('folder controls are scoped to sessions and preserve independent visibility', () => {
  const control = createFilesControl(); let ensured = 0;
  control.ensure('a', false); control.ensure('b', true);
  const off = control.bind('a', () => { ensured++; });
  control.toggle('a'); assert.equal(control.getSnapshot().open.a, true); assert.equal(ensured, 1);
  control.toggle('a'); assert.equal(control.getSnapshot().open.a, false); assert.equal(ensured, 1);
  assert.equal(control.getSnapshot().open.b, true);
  off(); control.toggle('a'); assert.equal(control.getSnapshot().open.a, false);
});
