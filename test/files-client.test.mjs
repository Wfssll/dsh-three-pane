import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

const plain = value => JSON.parse(JSON.stringify(value));
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const TREE = `<div data-files-state="tree" data-files-root="/ws">
  <div><button data-files-reload>reload</button></div>
  <div data-files-body><ul>
    <li data-files-entry="directory" data-files-path="/ws/data"><button>data</button><ul>
      <li data-files-entry="file" data-files-path="/ws/data/a b.txt"><button>a b.txt</button></li></ul></li>
    <li data-files-entry="file" data-files-path="/ws/readme.md"><button>readme.md</button></li>
    <li data-files-entry="file" data-files-path="/ws/legacy.md"><button data-ssh-file-drag>legacy.md</button></li>
    <li data-files-entry="other" data-files-path="/ws/socket"><span>socket</span></li>
  </ul></div></div>
  <div data-conversation-session="s1"><div data-composer-seat id="seat">composer</div></div>
  <div data-conversation-session="s2"><div data-composer-seat id="other-seat">other</div></div>`;

function mount({ session = 's1', fetchImpl, xhrImpl, showSaveFilePicker, extra = '', tabs = [], cwd = undefined } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${TREE}${extra}</div></body></html>`, { url: 'http://localhost' });
  const { window } = dom, calls = { fetch: [], xhr: [], added: [], notices: [], reloads: 0, blobs: [], clipboard: [], refreshed: 0 };
  window.document.querySelector('[data-files-reload]').addEventListener('click', () => calls.reloads++);
  class FakeXhr {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = new URL(url, 'http://localhost'); }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(file) {
      const record = { params: Object.fromEntries(this.url.searchParams), headers: this.headers, file };
      calls.xhr.push(record);
      setTimeout(() => {
        this.upload.onprogress?.({ loaded: file.size });
        const result = (xhrImpl ?? (() => ({ status: 200, body: '{"ok":true}' })))(record);
        this.status = result.status; this.responseText = result.body; this.onload();
      }, 0);
    }
  }
  const fetchFake = async (url, init) => {
    calls.fetch.push({ url: new URL(url, 'http://localhost'), init });
    return (fetchImpl ?? (() => new Response('{"ok":true}')))(calls.fetch.at(-1));
  };
  const context = {
    window, document: window.document, getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }, clearTimeout, queueMicrotask, URL: Object.assign(URL, { createObjectURL: blob => { calls.blobs.push(blob); return 'blob:x'; }, revokeObjectURL() {} }),
    URLSearchParams, Blob, Response, Event: window.Event, fetch: fetchFake, XMLHttpRequest: FakeXhr, globalThis: { crypto: { randomUUID: () => 'nonce-1' } },
    navigator: { clipboard: { writeText: text => calls.clipboard.push(text) } }, encodeURIComponent, Promise, console,
  };
  if (showSaveFilePicker) window.showSaveFilePicker = showSaveFilePicker;
  window.HTMLElement.prototype.focus = function () { Object.defineProperty(window.document, 'activeElement', { value: this, configurable: true }); };
  window.HTMLAnchorElement.prototype.click = function () { calls.download = this.download; calls.href = this.getAttribute('href'); };
  let plugin;
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(id => ({ react: React, 'react-dom': ReactDOM })[id]); } };
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  const input = { addFiles(files) { calls.added.push(...files); return true; }, notify: (...args) => calls.notices.push(args) };
  const scope = {
    sidebarRight: { mounted: { getSnapshot: () => session, subscribe: () => () => {} }, tabsIn: id => id === session ? tabs : [] },
    sessions: {
      scope: id => id === 's1' ? { id } : undefined,
      list: { getSnapshot: () => ({ byId: cwd ? { s1: { id: 's1', cwd } } : {} }) },
    },
    conversation: { input: { for: () => input } },
    inputTriggers: { sessionOf: () => ({ refreshOpenMenu: () => calls.refreshed++ }) },
  };
  const disposers = []; const injected = [];
  const ctx = {
    effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
    inject(names, callback) { injected.push(names); const dispose = callback(scope); return { dispose }; },
    slots: { inject: () => {}, entries: () => [], register: () => () => {} }, sidebarRight: scope.sidebarRight,
  };
  plugin.apply(ctx);
  const doc = window.document;
  const event = (type, target, init = {}) => {
    const created = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(created, init); target.dispatchEvent(created); return created;
  };
  const menuLabels = () => [...doc.querySelectorAll('.dsh-files-menu [role=menuitem]')].map(item => item.textContent);
  const choose = label => [...doc.querySelectorAll('.dsh-files-menu [role=menuitem]')].find(item => item.textContent.startsWith(label)).click();
  const contextMenu = target => event('contextmenu', target, { clientX: 20, clientY: 30 });
  return { window, doc, calls, event, menuLabels, choose, contextMenu, injected: () => injected,
    unmount() { for (const dispose of disposers.reverse()) dispose(); window.close(); } };
}

const transfer = (types = [], extra = {}) => {
  const store = new Map();
  return { types: [...types], effectAllowed: '', dropEffect: '', files: [], items: [], store,
    setData(key, value) { store.set(key, value); if (!this.types.includes(key)) this.types.push(key); },
    getData: key => store.get(key) ?? '', ...extra };
};

test('plugin asks the host for session, conversation, sidebar and trigger services', () => {
  const app = mount();
  assert.deepEqual(plain(app.injected()[0]), ['sessions', 'conversation', 'sidebarRight']);
  assert.deepEqual(plain(app.injected()[1]), ['inputTriggers', 'sessions']);
  app.unmount();
});

test('rows become draggable in any workspace and drop a relative @ reference into that session composer', async () => {
  const app = mount();
  await tick();
  const button = app.doc.querySelector('[data-files-path="/ws/data/a b.txt"] > button');
  assert.equal(button.getAttribute('draggable'), 'true');
  assert.equal(app.doc.querySelector('[data-files-path="/ws/legacy.md"] > button').hasAttribute('draggable'), false, 'older patch keeps its own handler');
  assert.equal(app.doc.querySelector('[data-files-path="/ws/socket"]').querySelector('[draggable]'), null);

  const dt = transfer();
  app.event('dragstart', button, { dataTransfer: dt });
  assert.equal(dt.store.get('text/plain'), '@"data/a b.txt"');
  const seat = app.doc.getElementById('seat');
  const over = app.event('dragover', seat, { dataTransfer: dt });
  assert.equal(over.defaultPrevented, true); assert.equal(dt.dropEffect, 'copy');
  assert.ok(seat.hasAttribute('data-dsh-drop-ready'));
  app.event('drop', seat, { dataTransfer: dt });
  assert.deepEqual(plain(app.calls.added), [{ source: 'reference', ref: '@"data/a b.txt"', label: 'a b.txt', appearance: 'file', clipboardText: '@"data/a b.txt"' }]);
  assert.equal(seat.hasAttribute('data-dsh-drop-ready'), false);

  const folder = transfer();
  app.event('dragstart', app.doc.querySelector('[data-files-path="/ws/data"] > button'), { dataTransfer: folder });
  app.event('drop', seat, { dataTransfer: folder });
  assert.equal(app.calls.added.at(-1).ref, '@data/'); assert.equal(app.calls.added.at(-1).appearance, 'folder');

  // A different conversation's composer is never a valid target.
  const stale = transfer();
  app.event('dragstart', button, { dataTransfer: stale });
  const wrong = app.event('dragover', app.doc.getElementById('other-seat'), { dataTransfer: stale });
  assert.equal(wrong.defaultPrevented, false);
  app.event('drop', app.doc.getElementById('other-seat'), { dataTransfer: stale });
  assert.equal(app.calls.added.length, 2);
  app.unmount();
});

test('right-click menu offers different actions for files, folders and blank space', async () => {
  const app = mount();
  const menu = target => { app.contextMenu(target); const labels = app.menuLabels(); app.doc.querySelector('.dsh-files-menu')?.remove(); return labels; };
  const file = menu(app.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  assert.deepEqual(file, ['下载', '引用到聊天', '复制相对路径', '重命名…', '删除…']);
  const folder = menu(app.doc.querySelector('[data-files-path="/ws/data"] > button'));
  assert.deepEqual(folder, ['下载（打包为 .tar）', '引用到聊天', '复制相对路径', '上传文件…', '上传文件夹…', '新建文件夹…', '重命名…', '删除…']);
  assert.deepEqual(menu(app.doc.querySelector('[data-files-body]')), ['上传文件…', '上传文件夹…', '新建文件夹…']);
  const other = app.contextMenu(app.doc.querySelector('[data-files-path="/ws/socket"] span'));
  assert.equal(other.defaultPrevented, false, 'unsupported entries keep the host menu');
  assert.equal(app.contextMenu(app.doc.querySelector('[data-files-path="/ws/readme.md"] > button')).defaultPrevented, true);
  app.doc.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(app.doc.querySelector('.dsh-files-menu'), null);
  app.unmount();
});

test('rename validates the name, calls the host once and refreshes the tree', async () => {
  const app = mount();
  app.contextMenu(app.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  app.choose('重命名');
  const input = app.doc.querySelector('.dsh-files-dialog input');
  assert.equal(input.value, 'readme.md');
  input.value = 'legacy.md'; app.event('keydown', input, { key: 'Enter' });
  assert.match(app.doc.querySelector('.dsh-files-dialog-note').textContent, /已存在/);
  input.value = 'a/b'; app.event('keydown', input, { key: 'Enter' });
  assert.match(app.doc.querySelector('.dsh-files-dialog-note').textContent, /不能包含/);
  assert.equal(app.calls.fetch.length, 0);
  input.value = 'notes 新.md'; app.event('keydown', input, { key: 'Enter' });
  await tick();
  assert.equal(app.calls.fetch.length, 1);
  const { url, init } = app.calls.fetch[0];
  assert.equal(url.pathname, '/api/dsh-files/rename');
  assert.deepEqual(Object.fromEntries(url.searchParams), { sessionId: 's1', path: '/ws/readme.md', name: 'notes 新.md' });
  assert.equal(init.method, 'POST'); assert.equal(init.headers['x-dsh-files'], '1');
  assert.equal(app.calls.reloads, 1); assert.equal(app.doc.querySelector('.dsh-files-dialog'), null);
  app.unmount();
});

test('delete asks for confirmation and reports host failures', async () => {
  const app = mount({ fetchImpl: () => new Response('{"error":"目标不存在。"}', { status: 404 }) });
  app.contextMenu(app.doc.querySelector('[data-files-path="/ws/data"] > button'));
  app.choose('删除');
  assert.match(app.doc.querySelector('.dsh-files-dialog-message').textContent, /文件夹“data”及其全部内容/);
  [...app.doc.querySelectorAll('.dsh-files-dialog button')].find(button => button.textContent === '取消').click();
  await tick(); assert.equal(app.calls.fetch.length, 0);
  app.contextMenu(app.doc.querySelector('[data-files-path="/ws/data"] > button'));
  app.choose('删除');
  [...app.doc.querySelectorAll('.dsh-files-dialog button')].find(button => button.textContent === '删除').click();
  await tick();
  assert.equal(app.calls.fetch[0].url.pathname, '/api/dsh-files/remove');
  assert.match(app.doc.querySelector('.dsh-files-task[data-state=error]').textContent, /删除失败：目标不存在/);
  assert.equal(app.calls.reloads, 0);
  app.unmount();
});

test('missing host module is explained instead of failing silently', async () => {
  const app = mount({ fetchImpl: () => new Response('Not found', { status: 404 }) });
  app.contextMenu(app.doc.querySelector('[data-files-body]'));
  app.choose('新建文件夹');
  const input = app.doc.querySelector('.dsh-files-dialog input'); input.value = 'new'; app.event('keydown', input, { key: 'Enter' });
  await tick();
  assert.match(app.doc.querySelector('.dsh-files-task[data-state=error]').textContent, /重新启动 Harness/);
  assert.equal(app.calls.fetch[0].url.searchParams.get('dir'), '/ws');
  app.unmount();
});

test('download checks the target first, streams to a chosen file, and otherwise hands off to the system download', async () => {
  const stat = { name: 'readme.md', directory: false, size: 5 };
  const serve = ({ url }) => url.pathname.endsWith('/stat') ? new Response(JSON.stringify(url.searchParams.get('path').endsWith('/data') ? { name: 'data.tar', directory: true } : stat))
    : new Response(new Blob(['hello']).stream(), { headers: { 'content-length': '5' } });
  const written = [];
  const picked = mount({ fetchImpl: serve, showSaveFilePicker: async options => ({ createWritable: async () => ({
    write: async chunk => written.push(Buffer.from(chunk).toString()), close: async () => written.push('closed') }), options }) });
  picked.contextMenu(picked.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  picked.choose('下载'); await tick(60);
  assert.deepEqual(written, ['hello', 'closed']);
  assert.deepEqual(picked.calls.fetch.map(call => call.url.pathname), ['/api/dsh-files/stat', '/api/dsh-files/download']);
  assert.match(picked.doc.querySelector('.dsh-files-task').textContent, /已保存 readme\.md/);
  picked.unmount();

  const native = mount({ fetchImpl: serve });
  native.contextMenu(native.doc.querySelector('[data-files-path="/ws/data"] > button'));
  native.choose('下载'); await tick(40);
  assert.equal(native.calls.download, 'data.tar');
  assert.match(native.calls.href, /^\/api\/dsh-files\/download\?sessionId=s1&path=%2Fws%2Fdata$/);
  assert.equal(native.calls.fetch.length, 1, 'only the preflight is fetched; the browser streams the file itself');
  assert.match(native.doc.querySelector('.dsh-files-task').textContent, /已交给系统下载：data\.tar/);
  native.unmount();

  const missing = mount({ fetchImpl: () => new Response('{"error":"目标不存在。"}', { status: 404 }) });
  missing.contextMenu(missing.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  missing.choose('下载'); await tick(40);
  assert.match(missing.doc.querySelector('.dsh-files-task[data-state=error]').textContent, /下载失败：目标不存在/);
  assert.equal(missing.calls.download, undefined);
  missing.unmount();

  const cancelled = mount({ fetchImpl: serve, showSaveFilePicker: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  cancelled.contextMenu(cancelled.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  cancelled.choose('下载'); await tick(40);
  assert.equal(cancelled.calls.fetch.length, 1); assert.equal(cancelled.doc.querySelector('.dsh-files-task'), null);
  cancelled.unmount();
});

test('file drags over the tree never start (or leave stuck) the host window overlay', async () => {
  const app = mount();
  // Stand-in for the host's bubbling document listeners that drive its full-window overlay.
  const host = { enter: 0, leave: 0, drop: 0, ended: 0 };
  app.doc.addEventListener('dragenter', () => host.enter++); app.doc.addEventListener('dragleave', () => host.leave++);
  app.doc.addEventListener('drop', () => host.drop++); app.window.addEventListener('dragend', () => host.ended++);
  const files = () => transfer(['Files'], { items: [] });
  const row = app.doc.querySelector('[data-files-path="/ws/readme.md"] > button');
  app.event('dragenter', row, { dataTransfer: files() });
  app.event('dragleave', row, { dataTransfer: files(), relatedTarget: null });
  assert.deepEqual([host.enter, host.leave], [0, 0], 'the host never sees drags that stay inside the tree');
  app.event('dragenter', app.doc.getElementById('seat'), { dataTransfer: files() });
  assert.equal(host.enter, 1, 'drags over the composer still behave as before');
  app.event('dragover', row, { dataTransfer: files() });
  const drop = app.event('drop', row, { dataTransfer: files() });
  assert.equal(drop.defaultPrevented, true); assert.equal(host.drop, 0);
  assert.equal(host.ended, 1, 'the overlay is told the drag is over');
  app.unmount();
});

test('dropping local files uploads into the folder under the pointer and handles name conflicts', async () => {
  const file = (name, size = 3) => ({ name, size });
  const entryFile = (name, size) => ({ isFile: true, isDirectory: false, name, file: ok => ok(file(name, size)) });
  const entryDir = (name, children) => { let served = false; return { isFile: false, isDirectory: true, name,
    createReader: () => ({ readEntries: ok => { const batch = served ? [] : children; served = true; ok(batch); } }) }; };
  const app = mount({ xhrImpl: request => request.params.name === 'photos/dup.txt' && request.params.replace === '0'
    ? { status: 409, body: '{"error":"同名文件或文件夹已存在。"}' } : { status: 200, body: '{"ok":true}' } });
  const folderRow = app.doc.querySelector('[data-files-path="/ws/data"] > button');
  const dt = transfer(['Files'], { items: [
    { kind: 'file', webkitGetAsEntry: () => entryFile('top.csv', 5) },
    { kind: 'file', webkitGetAsEntry: () => entryDir('photos', [entryFile('dup.txt', 2), entryFile('new.png', 4), entryDir('empty', [])]) }] });
  const over = app.event('dragover', folderRow, { dataTransfer: dt });
  assert.equal(over.defaultPrevented, true);
  assert.ok(app.doc.querySelector('[data-files-path="/ws/data"]').hasAttribute('data-dsh-drop-target'));
  app.event('drop', folderRow, { dataTransfer: dt });
  assert.equal(app.doc.querySelector('[data-files-path="/ws/data"]').hasAttribute('data-dsh-drop-target'), false);
  await tick(60);
  const dialog = app.doc.querySelector('.dsh-files-dialog');
  assert.match(dialog.textContent, /1 个文件已存在：photos\/dup\.txt/);
  [...dialog.querySelectorAll('button')].find(button => button.textContent === '覆盖').click();
  await tick(60);
  const names = app.calls.xhr.map(call => `${call.params.name}:${call.params.replace}`).sort();
  assert.deepEqual(names, ['photos/dup.txt:0', 'photos/dup.txt:1', 'photos/new.png:0', 'top.csv:0']);
  assert.ok(app.calls.xhr.every(call => call.params.dir === '/ws/data' && call.params.sessionId === 's1' && call.headers['x-dsh-files'] === '1'));
  assert.equal(app.calls.reloads, 1);
  assert.match(app.doc.querySelector('.dsh-files-task').textContent, /已上传 3 个文件.*1 个空文件夹未上传/);
  app.unmount();
});

test('dropping on a file row or blank space targets its parent folder or the root; declining keeps existing files', async () => {
  const entry = (name) => ({ isFile: true, isDirectory: false, name, file: ok => ok({ name, size: 1 }) });
  const app = mount({ xhrImpl: () => ({ status: 409, body: '{"error":"同名文件或文件夹已存在。"}' }) });
  const dt = () => transfer(['Files'], { items: [{ kind: 'file', webkitGetAsEntry: () => entry('x.txt') }] });
  app.event('drop', app.doc.querySelector('[data-files-path="/ws/data/a b.txt"] > button'), { dataTransfer: dt() });
  await tick(40);
  assert.equal(app.calls.xhr[0].params.dir, '/ws/data');
  [...app.doc.querySelectorAll('.dsh-files-dialog button')].find(button => button.textContent === '取消').click();
  await tick(40);
  assert.equal(app.calls.xhr.length, 1, 'declined overwrite sends nothing more');
  assert.match(app.doc.querySelector('.dsh-files-task').textContent, /跳过 1 个同名文件/);
  app.event('drop', app.doc.querySelector('[data-files-body]'), { dataTransfer: dt() });
  await tick(40);
  assert.equal(app.calls.xhr.at(-1).params.dir, '/ws');
  // Files dropped outside the tree are not intercepted.
  const outside = app.event('dragover', app.doc.getElementById('seat'), { dataTransfer: dt() });
  assert.equal(outside.defaultPrevented, false);
  app.unmount();
});

test('unmount removes listeners, markers, menus and cards', async () => {
  const app = mount();
  await tick();
  app.contextMenu(app.doc.querySelector('[data-files-path="/ws/readme.md"] > button'));
  app.choose('重命名');
  const doc = app.doc;
  app.unmount();
  assert.equal(doc.querySelector('[data-dsh-file-drag]'), null);
  assert.equal(doc.querySelector('[draggable]'), null);
  for (const selector of ['.dsh-files-menu', '.dsh-files-backdrop', '.dsh-files-tasks', 'style[data-plugin="dsh-three-pane"]']) assert.equal(doc.querySelector(selector), null, selector);
});

test('presented conversation cards and preview tabs download, reference and drag into the composer', async () => {
  const extra = `<div data-conversation-session="s1">
      <div data-presented-file><button class="card" title="/ws/picture/report.pdf">report.pdf</button></div>
      <div data-presented-file><button class="card" title="/fs2/home/me/legacy/picture/bias.pdf">bias.pdf</button></div>
    </div>
    <div data-sidebar-right-session="s1">
      <div data-dockkit-tab="tab3"><div data-dockkit-tab-title><span>chart.png</span></div>
        <div data-sidebar-right-tab="tab3">preview body</div></div>
    </div>`;
  const tabs = [{ id: 'tab3', kind: 'document', contentId: 'dsh-resource://file/session/s1/picture/chart.png', title: 'chart.png' }];
  const app = mount({ extra, tabs, cwd: '/ws' });
  await tick();
  const card = app.doc.querySelector('[data-presented-file]');
  const absolute = app.doc.querySelectorAll('[data-presented-file]')[1];
  assert.equal(card.getAttribute('draggable'), 'true');
  assert.ok(card.querySelector('.dsh-files-card-grip'));
  const handle = app.doc.querySelector('[data-dsh-preview-handle]');
  assert.ok(handle, 'preview tab gets a drag handle');
  const title = app.doc.querySelector('[data-dockkit-tab-title]');
  assert.equal(title.getAttribute('draggable'), 'true', 'the whole preview title is a drag source');

  const dt = transfer();
  app.event('dragstart', card.querySelector('button'), { dataTransfer: dt });
  assert.equal(dt.store.get('text/plain'), '@picture/report.pdf');
  const seat = app.doc.getElementById('seat');
  assert.equal(app.event('dragover', seat, { dataTransfer: dt }).defaultPrevented, true);
  app.event('drop', seat, { dataTransfer: dt });
  assert.equal(app.calls.added.at(-1).ref, '@picture/report.pdf');

  const absoluteTransfer = transfer();
  app.event('dragstart', absolute.querySelector('button'), { dataTransfer: absoluteTransfer });
  assert.equal(absoluteTransfer.store.get('text/plain'), '@/fs2/home/me/legacy/picture/bias.pdf');
  app.event('drop', seat, { dataTransfer: absoluteTransfer });
  assert.equal(app.calls.added.at(-1).ref, '@/fs2/home/me/legacy/picture/bias.pdf');
  app.contextMenu(absolute.querySelector('button'));
  assert.deepEqual(app.menuLabels(), ['下载', '加入对话', '复制路径']);
  app.doc.querySelector('.dsh-files-menu')?.remove();

  const preview = transfer();
  app.event('dragstart', handle, { dataTransfer: preview });
  assert.equal(preview.store.get('text/plain'), '@picture/chart.png');
  app.event('drop', seat, { dataTransfer: preview });
  assert.equal(app.calls.added.at(-1).ref, '@picture/chart.png');

  app.contextMenu(card);
  assert.deepEqual(app.menuLabels(), ['下载', '加入对话', '复制相对路径']);
  app.doc.querySelector('.dsh-files-menu')?.remove();
  app.contextMenu(handle);
  assert.deepEqual(app.menuLabels(), ['下载', '加入对话', '复制相对路径']);
  app.doc.querySelector('.dsh-files-menu')?.remove();
  const titleTransfer = transfer();
  app.event('dragstart', title, { dataTransfer: titleTransfer });
  app.event('drop', seat, { dataTransfer: titleTransfer });
  assert.equal(app.calls.added.at(-1).ref, '@picture/chart.png');
  app.contextMenu(title);
  assert.deepEqual(app.menuLabels(), ['下载', '加入对话', '复制相对路径']);
  app.doc.querySelector('.dsh-files-menu')?.remove();

  app.unmount();
  assert.equal(app.doc.querySelector('[data-dsh-preview-handle]'), null);
  assert.equal(app.doc.querySelector('[data-dsh-presented-drag]'), null);
});

test('an open @ menu is refreshed once the background remote index is ready', async () => {
  const app = mount({
    extra: '<div data-trigger-menu></div>',
    fetchImpl: ({ url }) => url.pathname === '/api/dsh-files/refsStatus'
      ? new Response(JSON.stringify({ kind: 'ssh', state: 'ready', count: 3, generation: 2 }))
      : new Response('{"ok":true}'),
  });
  await tick();
  app.doc.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await tick(40);
  assert.equal(app.calls.refreshed, 1);
  assert.equal(app.calls.fetch.at(-1).url.pathname, '/api/dsh-files/refsStatus');
  assert.equal(app.calls.fetch.at(-1).url.searchParams.get('sessionId'), 's1');
  app.unmount();
});
