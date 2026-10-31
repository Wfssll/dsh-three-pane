import { fileReference, relativeReference, absoluteReference, parseFileAddress, parentPath, baseName, joinPath, nameProblem, formatBytes, dropDirectory } from './model.js';

// Client half of the file tree tools: drag rows into the composer, a right-click
// menu (download / rename / delete / new folder / upload) and drop-to-upload.
// Everything reads the host's native tree DOM, so it works in every workspace.
const FILES_API = '/api/dsh-files';
const FILES_MIME = 'application/x-dsh-three-pane-reference';
const TREE = '[data-files-state="tree"]';
const ROW = '[data-files-entry][data-files-path]';
const UPLOAD_LIMIT = 10000;

class FilesError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child !== undefined && child !== null && child !== false));
  return node;
}

async function failureMessage(status, text) {
  try { const body = JSON.parse(text); if (body?.error) return body.error; } catch { /* not JSON */ }
  return status === 404 ? '宿主没有加载文件操作模块，请完全退出并重新启动 Harness。' : `请求失败（${status}）`;
}

async function filesRequest(op, params, init = {}) {
  const response = await fetch(`${FILES_API}/${op}?${new URLSearchParams(params)}`, {
    credentials: 'same-origin', ...init, headers: { 'x-dsh-files': '1', ...init.headers } });
  if (!response.ok) throw new FilesError(await failureMessage(response.status, await response.text().catch(() => '')), response.status);
  return response;
}

function sendFile(params, file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${FILES_API}/upload?${new URLSearchParams(params)}`);
    request.setRequestHeader('x-dsh-files', '1');
    request.upload.onprogress = event => onProgress(event.loaded);
    request.onerror = () => reject(new FilesError('网络错误，上传中断。', 0));
    request.onload = async () => request.status >= 200 && request.status < 300 ? resolve()
      : reject(new FilesError(await failureMessage(request.status, request.responseText), request.status));
    request.send(file);
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = el('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Read every file below dropped entries. Entries must be captured synchronously in the drop event. */
async function walkEntries(roots, fallback) {
  const files = []; let emptyFolders = 0;
  const readAll = reader => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries(batch => batch.length ? (all.push(...batch), next()) : resolve(all), reject);
    next();
  });
  const visit = async (entry, prefix) => {
    if (files.length > UPLOAD_LIMIT) return;
    if (entry.isFile) { files.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path: prefix + entry.name }); return; }
    const children = await readAll(entry.createReader());
    if (!children.length) emptyFolders++;
    for (const child of children) await visit(child, `${prefix}${entry.name}/`);
  };
  if (roots.length) for (const entry of roots) await visit(entry, '');
  else for (const file of fallback) files.push({ file, path: file.name });
  return { files, emptyFolders };
}

export function mountFileTools(scope) {
  const sessionId = () => scope.sidebarRight.mounted.getSnapshot();
  const cleanups = [];
  const style = (target, items) => { for (const [key, value] of Object.entries(items)) target.style[key] = value; };

  // ---- Task cards -----------------------------------------------------------
  const taskHost = el('div', { class: 'dsh-files-tasks', 'aria-live': 'polite' });
  document.body.append(taskHost); cleanups.push(() => taskHost.remove());
  function addTask(title) {
    const bar = el('div', { class: 'dsh-files-task-bar' }), detail = el('div', { class: 'dsh-files-task-detail' });
    const card = el('div', { class: 'dsh-files-task', role: 'status' }, el('div', { class: 'dsh-files-task-title' }, title), detail, bar);
    const close = el('button', { type: 'button', class: 'dsh-files-task-close', 'aria-label': '关闭', onclick: () => card.remove() }, '×');
    card.prepend(close); taskHost.append(card);
    let timer;
    const finish = (state, message) => {
      card.setAttribute('data-state', state); detail.textContent = message; bar.style.display = 'none';
      if (state === 'ok') timer = setTimeout(() => card.remove(), 4000);
    };
    return {
      title(text) { card.querySelector('.dsh-files-task-title').textContent = text; },
      update(message, progress) { detail.textContent = message; bar.style.setProperty('--progress', progress === undefined ? '0%' : `${Math.round(progress * 100)}%`); },
      done: message => finish('ok', message), fail: message => finish('error', message),
      remove() { clearTimeout(timer); card.remove(); },
    };
  }

  // ---- Dialogs --------------------------------------------------------------
  function dialog(title, body, actions, { onKey } = {}) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const close = value => { backdrop.remove(); previous?.focus?.(); resolve(value); };
      const buttons = actions.map(action => el('button', { type: 'button', class: `dsh-files-button${action.primary ? ' primary' : ''}${action.danger ? ' danger' : ''}`,
        onclick: () => action.run(close) }, action.label));
      const panel = el('div', { class: 'dsh-files-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'dsh-files-dialog-title' }, title), body, el('div', { class: 'dsh-files-dialog-actions' }, ...buttons));
      const backdrop = el('div', { class: 'dsh-files-backdrop', onmousedown: event => { if (event.target === backdrop) close(undefined); } }, panel);
      backdrop.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(undefined); }
        else onKey?.(event, close);
      });
      document.body.append(backdrop);
      (panel.querySelector('input') || buttons.at(-1)).focus();
      panel.querySelector('input')?.select?.();
    });
  }

  function promptName({ title, value = '', siblings = [], confirm = '确定' }) {
    const input = el('input', { type: 'text', class: 'dsh-files-input', value, spellcheck: 'false', 'aria-label': title });
    const note = el('div', { class: 'dsh-files-dialog-note', role: 'alert' });
    const submit = close => {
      const name = input.value.trim(), problem = nameProblem(name, siblings.filter(sibling => sibling !== value));
      if (problem) { note.textContent = problem; input.focus(); return; }
      close(name);
    };
    queueMicrotask(() => { const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); });
    return dialog(title, el('div', {}, input, note), [
      { label: '取消', run: close => close(undefined) }, { label: confirm, primary: true, run: submit }],
    { onKey: (event, close) => { if (event.key === 'Enter' && event.target === input) { event.preventDefault(); submit(close); } } });
  }

  const confirmDialog = ({ title, message, confirm, danger }) => dialog(title, el('div', { class: 'dsh-files-dialog-message' }, message), [
    { label: '取消', run: close => close(false) }, { label: confirm, primary: !danger, danger, run: close => close(true) }]).then(Boolean);

  // ---- Tree helpers ---------------------------------------------------------
  const rowOf = target => {
    const item = target?.closest?.(ROW), tree = item?.closest(TREE);
    const kind = item?.getAttribute('data-files-entry');
    if (!item || !tree || (kind !== 'file' && kind !== 'directory')) return undefined;
    return { item, tree, kind, path: item.getAttribute('data-files-path'), root: tree.getAttribute('data-files-root') };
  };
  const bodyOf = target => {
    const body = target?.closest?.('[data-files-body]'), tree = body?.closest(TREE);
    return body && tree ? { body, tree, root: tree.getAttribute('data-files-root') } : undefined;
  };
  const siblingNames = row => [...row.item.parentElement.children].filter(item => item.hasAttribute('data-files-path'))
    .map(item => baseName(item.getAttribute('data-files-path')));
  const dirNames = (tree, directory) => {
    if (directory === tree.getAttribute('data-files-root')) return [...tree.querySelectorAll('[data-files-body] > ul > li[data-files-path]')].map(item => baseName(item.getAttribute('data-files-path')));
    const item = [...tree.querySelectorAll(ROW)].find(candidate => candidate.getAttribute('data-files-path') === directory);
    return [...(item?.querySelectorAll(':scope > ul > li[data-files-path]') ?? [])].map(child => baseName(child.getAttribute('data-files-path')));
  };
  const refresh = root => {
    const trees = [...document.querySelectorAll(TREE)], tree = trees.find(candidate => candidate.getAttribute('data-files-root') === root) || trees[0];
    tree?.querySelector('[data-files-reload]')?.click();
  };

  // ---- Conversation and preview sources ------------------------------------
  // Both surfaces already know the session and the file they show: a presented
  // card carries the resolved path in its title, and a preview tab carries the
  // native resource address. Resolving at gesture time keeps this correct while
  // tabs are renamed, moved between panes, or reused for another file.
  const cwdOf = id => {
    try { const cwd = scope.sessions?.list?.getSnapshot?.()?.byId?.[id]?.cwd; if (cwd) return cwd; } catch { /* no session list */ }
    try { return scope.sessions?.scope?.(id)?.session?.header?.cwd; } catch { return undefined; }
  };
  const tabsIn = id => {
    try { return scope.sidebarRight?.tabsIn?.(id) ?? []; } catch { return []; }
  };
  const infoFromAddress = (address, fallbackSession) => {
    const parsed = parseFileAddress(address);
    if (!parsed) return undefined;
    const sessionId = parsed.sessionId || fallbackSession;
    if (!sessionId || !parsed.path) return undefined;
    const cwd = cwdOf(sessionId);
    const ref = parsed.path.startsWith('/')
      ? (cwd ? fileReference(cwd, parsed.path, 'file') : undefined) ?? absoluteReference(parsed.path)
      : relativeReference(parsed.path, 'file');
    return { sessionId, path: parsed.path, ref, hostPath: ref?.relative ?? parsed.path };
  };
  const presentedInfo = target => {
    const card = target?.closest?.('[data-presented-file]');
    if (!card) return undefined;
    const id = card.closest('[data-conversation-session]')?.getAttribute('data-conversation-session');
    const path = card.querySelector('button[title]')?.getAttribute('title') || card.querySelector('[title]')?.getAttribute('title');
    if (!id || !path) return undefined;
    const cwd = cwdOf(id);
    // Presented files are recorded as absolute paths. In an SSH workspace the
    // card's title can be that remote absolute path while the Session cwd is the
    // local anchor; keep an absolute @ reference instead of dropping the card.
    const ref = path.startsWith('/')
      ? (cwd ? fileReference(cwd, path, 'file') : undefined) ?? absoluteReference(path)
      : relativeReference(path, 'file');
    return { sessionId: id, path, absolute: path.startsWith('/') ? path : undefined, ref, hostPath: ref?.relative ?? path };
  };
  const previewInfo = target => {
    const owner = target?.closest?.('[data-sidebar-right-session]');
    const tabNode = target?.closest?.('[data-sidebar-right-tab], [data-dockkit-tab]');
    const id = owner?.getAttribute('data-sidebar-right-session');
    const tabId = tabNode?.getAttribute('data-sidebar-right-tab') || tabNode?.getAttribute('data-dockkit-tab');
    if (!id || !tabId) return undefined;
    const tab = tabsIn(id).find(candidate => candidate?.id === tabId);
    const fromTab = infoFromAddress(tab?.contentId, id);
    if (fromTab) return { ...fromTab, tab };
    const url = target?.closest?.('[data-textpreview-url]')?.getAttribute('data-textpreview-url');
    return url ? { ...infoFromAddress(url, id), tab } : undefined;
  };
  const sourceInfo = target => {
    const row = rowOf(target);
    if (row) {
      const ref = fileReference(row.root, row.path, row.kind);
      return { sessionId: sessionId(), path: row.path, ref, hostPath: ref?.relative ?? row.path, kind: row.kind, source: 'tree' };
    }
    const presented = presentedInfo(target);
    if (presented) return { ...presented, kind: 'file', source: 'presented' };
    const preview = previewInfo(target);
    return preview ? { ...preview, kind: 'file', source: 'preview' } : undefined;
  };
  function sourceMenu(info, x, y) {
    const target = info.hostPath ?? info.ref?.relative ?? info.path;
    const absolute = info.ref?.relative.startsWith('/') === true;
    openMenu(x, y, [
      { label: '下载', run: () => download(info.sessionId, target) },
      ...(info.ref ? ['-', { label: '加入对话', run: () => addReference(info.sessionId, info.ref) },
        { label: absolute ? '复制路径' : '复制相对路径', run: () => navigator.clipboard?.writeText(info.ref.relative) }] : []),
    ]);
  }

  // ---- Operations -----------------------------------------------------------
  async function download(id, path) {
    const task = addTask(`下载 ${baseName(path)}`);
    let info;
    try { info = await (await filesRequest('stat', { sessionId: id, path })).json(); }
    catch (error) { task.fail(`下载失败：${error.message}`); return; }
    const name = info.name, total = info.size;
    task.title(`下载 ${name}`);
    let writable;
    if (typeof window.showSaveFilePicker === 'function') {
      try { writable = await (await window.showSaveFilePicker({ suggestedName: name })).createWritable(); }
      catch (error) { if (error?.name === 'AbortError') { task.remove(); return; } writable = undefined; }
    }
    if (!writable) {
      // No save dialog available: let the browser stream it to disk with its own download manager.
      const link = el('a', { href: `${FILES_API}/download?${new URLSearchParams({ sessionId: id, path })}`, download: name });
      document.body.append(link); link.click(); link.remove();
      task.done(`已交给系统下载：${name}${total === undefined ? '' : `（${formatBytes(total)}）`}`);
      return;
    }
    try {
      task.update('正在连接…');
      const response = await filesRequest('download', { sessionId: id, path });
      const reader = response.body.getReader();
      let received = 0, shown = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        await writable.write(value);
        const now = Date.now();
        if (now - shown > 120) { shown = now; task.update(total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received), total ? received / total : undefined); }
      }
      await writable.close();
      task.done(`已保存 ${name}（${formatBytes(received)}）`);
    } catch (error) {
      await writable.abort?.().catch(() => {});
      task.fail(`下载失败：${error.message}`);
    }
  }

  async function uploadBatch(id, root, directory, items, extra = '', task = addTask('上传')) {
    if (!items.length) { task.remove(); return; }
    if (items.length > UPLOAD_LIMIT) { task.fail(`一次最多上传 ${UPLOAD_LIMIT} 个文件。`); return; }
    task.title(`上传 ${items.length} 个文件到 ${baseName(directory) || directory}`);
    const total = items.reduce((sum, item) => sum + item.file.size, 0) || 1, sent = new Map(), conflicts = [], failures = [];
    let finished = 0, skipped = 0, queue = [...items];
    const report = () => {
      const bytes = [...sent.values()].reduce((sum, value) => sum + value, 0);
      task.update(`${finished}/${items.length} · ${formatBytes(bytes)} / ${formatBytes(total)}`, bytes / total);
    };
    const run = async (list, replace, onConflict) => {
      queue = [...list];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          try {
            await sendFile({ sessionId: id, dir: directory, name: item.path, replace: replace ? '1' : '0' }, item.file, loaded => { sent.set(item, loaded); report(); });
            sent.set(item, item.file.size);
          } catch (error) {
            sent.delete(item);
            if (error.status === 409 && /已存在/.test(error.message) && onConflict) onConflict(item); else failures.push(`${item.path}：${error.message}`);
          }
          finished++; report();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    };
    try {
      await run(items, false, item => conflicts.push(item));
      if (conflicts.length) {
        finished -= conflicts.length; report();
        const names = conflicts.slice(0, 5).map(item => item.path).join('、') + (conflicts.length > 5 ? ' 等' : '');
        if (await confirmDialog({ title: '同名文件已存在', message: `${conflicts.length} 个文件已存在：${names}。是否覆盖？`, confirm: '覆盖', danger: true })) await run(conflicts, true);
        else { finished += conflicts.length; skipped = conflicts.length; }
      }
    } finally { refresh(root); }
    const note = extra ? `（${extra}）` : '';
    if (failures.length) task.fail(`${failures.length} 个文件失败：${failures.slice(0, 3).join('；')}${note}`);
    else task.done(`已上传 ${items.length - skipped} 个文件${skipped ? `，跳过 ${skipped} 个同名文件` : ''}${note}`);
  }

  async function mutate(label, op, params, root) {
    try { await filesRequest(op, params, { method: 'POST' }); refresh(root); }
    catch (error) { addTask(label).fail(`${label}失败：${error.message}`); }
  }

  function pickFiles() {
    return new Promise(resolve => {
      const input = el('input', { type: 'file', multiple: true, hidden: true, onchange: () => { resolve([...input.files].map(file => ({ file, path: file.name }))); input.remove(); } });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      document.body.append(input); input.click();
    });
  }
  function pickFolder() {
    return new Promise(resolve => {
      const input = el('input', { type: 'file', webkitdirectory: true, hidden: true, onchange: () => { resolve([...input.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))); input.remove(); } });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      document.body.append(input); input.click();
    });
  }

  // ---- Composer references --------------------------------------------------
  function addReference(id, ref) {
    const actx = scope.sessions.scope(id);
    if (!actx) return false;
    const input = scope.conversation.input.for(actx);
    try {
      const accepted = input.addFiles([{ source: 'reference', ref: ref.mention, label: ref.label,
        appearance: ref.kind === 'directory' ? 'folder' : 'file', clipboardText: ref.mention }], []);
      if (!accepted) input.notify('error', '当前消息正在提交，请稍后重新拖入文件。');
      return accepted;
    } catch (error) { input.notify('error', `文件引用添加失败：${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  // ---- Right-click menu -----------------------------------------------------
  let closeMenu = () => {};
  function openMenu(x, y, items) {
    closeMenu();
    const menu = el('div', { class: 'dsh-files-menu', role: 'menu' });
    const buttons = [];
    for (const item of items) {
      if (item === '-') { menu.append(el('div', { class: 'dsh-files-menu-separator', role: 'separator' })); continue; }
      const button = el('button', { type: 'button', role: 'menuitem', class: item.danger ? 'danger' : '', onclick: () => { closeMenu(); item.run(); } }, item.label);
      buttons.push(button); menu.append(button);
    }
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    style(menu, { left: `${Math.max(4, Math.min(x, window.innerWidth - (box.width || 180) - 4))}px`, top: `${Math.max(4, Math.min(y, window.innerHeight - (box.height || 200) - 4))}px` });
    const away = event => { if (!menu.contains(event.target)) closeMenu(); };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const at = buttons.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true);
    window.addEventListener('blur', closeMenu); window.addEventListener('resize', closeMenu); document.addEventListener('scroll', closeMenu, true);
    closeMenu = () => {
      menu.remove(); closeMenu = () => {};
      document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', closeMenu); window.removeEventListener('resize', closeMenu); document.removeEventListener('scroll', closeMenu, true);
    };
    buttons[0]?.focus();
  }

  function directoryItems(id, tree, root, directory) {
    return [
      { label: '上传文件…', run: async () => uploadBatch(id, root, directory, await pickFiles()) },
      { label: '上传文件夹…', run: async () => {
        const items = await pickFolder(); await uploadBatch(id, root, directory, items); } },
      { label: '新建文件夹…', run: async () => {
        const name = await promptName({ title: '新建文件夹', siblings: dirNames(tree, directory), confirm: '创建' });
        if (name) await mutate('新建文件夹', 'mkdir', { sessionId: id, dir: directory, name }, root); } },
    ];
  }

  function onContextMenu(event) {
    if (event.target.closest?.('input,textarea')) return;
    const row = rowOf(event.target);
    if (!row) {
      const presented = presentedInfo(event.target);
      if (presented) {
        event.preventDefault(); event.stopPropagation();
        sourceMenu(presented, event.clientX, event.clientY); return;
      }
      const tabNode = event.target.closest?.('[data-dockkit-tab]');
      const tabInfo = tabNode && previewInfo(tabNode);
      if (tabInfo?.ref) {
        event.preventDefault(); event.stopPropagation();
        sourceMenu(tabInfo, event.clientX, event.clientY); return;
      }
      const previewTarget = event.target.closest?.('[data-dsh-preview-handle], [data-textpreview-path]');
      const preview = previewTarget && previewInfo(previewTarget);
      if (preview) {
        event.preventDefault(); event.stopPropagation();
        sourceMenu(preview, event.clientX, event.clientY); return;
      }
    }
    const id = sessionId(), blank = row || event.target.closest?.(ROW) ? undefined : bodyOf(event.target);
    if (!id || (!row && !blank)) return;
    event.preventDefault(); event.stopPropagation();
    if (blank) { openMenu(event.clientX, event.clientY, directoryItems(id, blank.tree, blank.root, blank.root)); return; }
    const ref = fileReference(row.root, row.path, row.kind);
    const items = [
      { label: row.kind === 'directory' ? '下载（打包为 .tar）' : '下载', run: () => download(id, row.path) },
      ...(ref ? [{ label: '引用到聊天', run: () => addReference(id, ref) }, { label: '复制相对路径', run: () => navigator.clipboard?.writeText(ref.relative) }] : []),
      '-',
      ...(row.kind === 'directory' ? [...directoryItems(id, row.tree, row.root, row.path), '-'] : []),
      { label: '重命名…', run: async () => {
        const current = baseName(row.path), name = await promptName({ title: '重命名', value: current, siblings: siblingNames(row), confirm: '重命名' });
        if (name && name !== current) await mutate('重命名', 'rename', { sessionId: id, path: row.path, name }, row.root); } },
      { label: '删除…', danger: true, run: async () => {
        const name = baseName(row.path);
        if (await confirmDialog({ title: '删除', message: row.kind === 'directory' ? `确定删除文件夹“${name}”及其全部内容吗？此操作无法撤销。` : `确定删除“${name}”吗？此操作无法撤销。`, confirm: '删除', danger: true }))
          await mutate('删除', 'remove', { sessionId: id, path: row.path }, row.root); } },
    ];
    openMenu(event.clientX, event.clientY, items);
  }

  // ---- Drag rows into the composer -----------------------------------------
  const marked = new Set();
  let drag, highlighted, queued = false, stopped = false;
  const clearHighlight = () => { highlighted?.removeAttribute('data-dsh-drop-ready'); highlighted = undefined; };
  function syncRows() {
    queued = false;
    if (stopped) return;
    for (const button of marked) if (!button.isConnected) marked.delete(button);
    for (const button of document.querySelectorAll(`${TREE} ${ROW} > button:not([data-dsh-file-drag])`)) {
      // A button the older dsh-ssh-remote patch already made draggable keeps its own handler.
      if (button.hasAttribute('data-ssh-file-drag')) continue;
      const row = rowOf(button);
      if (!row) continue;
      button.setAttribute('draggable', 'true'); button.setAttribute('data-dsh-file-drag', ''); marked.add(button);
      button.setAttribute('title', `${row.path}\n拖到聊天框引用此${row.kind === 'directory' ? '文件夹' : '文件'}，右键可下载、重命名`);
    }
    syncPresentedCards();
    syncPreviewSources();
  }
  const gripIcon = () => el('span', { class: 'dsh-files-grip-glyph', 'aria-hidden': 'true' }, '⠿');
  function syncPresentedCards() {
    for (const card of document.querySelectorAll('[data-presented-file]')) {
      const ref = presentedInfo(card)?.ref;
      if (!ref) {
        card.removeAttribute('data-dsh-presented-drag'); card.removeAttribute('data-dsh-file-drag'); card.removeAttribute('draggable');
        card.querySelector(':scope > .dsh-files-card-grip')?.remove();
        for (const handle of card.querySelectorAll('[data-dsh-presented-handle]')) {
          handle.removeAttribute('data-dsh-presented-handle'); handle.removeAttribute('data-dsh-file-drag'); handle.removeAttribute('draggable');
        }
        continue;
      }
      if (!card.hasAttribute('data-dsh-presented-drag')) {
        card.setAttribute('data-dsh-presented-drag', '');
        card.setAttribute('data-dsh-file-drag', '');
        card.setAttribute('draggable', 'true');
      }
      if (!card.querySelector(':scope > .dsh-files-card-grip')) {
        card.append(el('span', { class: 'dsh-files-card-grip', 'aria-hidden': 'true' }, gripIcon()));
      }
      const handle = card.querySelector('button[title]');
      if (handle && !handle.hasAttribute('data-dsh-presented-handle')) {
        handle.setAttribute('data-dsh-presented-handle', ''); handle.setAttribute('data-dsh-file-drag', ''); handle.setAttribute('draggable', 'true');
      }
    }
  }
  function syncPreviewSources() {
    for (const sessionNode of document.querySelectorAll('[data-sidebar-right-session]')) {
      const id = sessionNode.getAttribute('data-sidebar-right-session');
      const tabs = tabsIn(id), byId = new Map(tabs.map(tab => [tab.id, tab]));
      for (const tabNode of sessionNode.querySelectorAll('[data-dockkit-tab]')) {
        const tabId = tabNode.getAttribute('data-dockkit-tab');
        const title = tabNode.querySelector('[data-dockkit-tab-title]');
        const file = parseFileAddress(byId.get(tabId)?.contentId ?? '');
        const existing = title?.querySelector('[data-dsh-preview-handle]');
        if (!title) { existing?.remove(); continue; }
        if (!file) existing?.remove();
        else if (!existing) {
          const handle = el('span', {
            class: 'dsh-files-preview-drag', 'data-dsh-preview-handle': '', 'data-dsh-file-drag': '', draggable: 'true',
            role: 'button', tabindex: '0', title: '拖到聊天框引用此文件', 'aria-label': '拖到聊天框引用此文件',
          }, gripIcon());
          for (const type of ['pointerdown', 'mousedown', 'click']) handle.addEventListener(type, event => event.stopPropagation());
          title.append(handle);
        }
        // The whole title is a drag source too, so the tab itself can be dragged
        // without finding the small grip first.
        if (!title.hasAttribute('data-dsh-preview-title')) {
          title.setAttribute('data-dsh-preview-title', '');
          title.setAttribute('data-dsh-file-drag', '');
          title.setAttribute('draggable', 'true');
          if (file) title.setAttribute('title', '拖到聊天框引用此文件，或右键加入对话');
        }
      }
    }
    for (const path of document.querySelectorAll('[data-textpreview-path]')) {
      if (!previewInfo(path)?.ref) {
        path.removeAttribute('data-dsh-file-drag'); path.removeAttribute('draggable');
        path.removeAttribute('data-dsh-preview-path'); path.removeAttribute('title');
        continue;
      }
      if (path.hasAttribute('data-dsh-file-drag')) continue;
      path.setAttribute('data-dsh-file-drag', ''); path.setAttribute('draggable', 'true');
      path.setAttribute('data-dsh-preview-path', ''); path.setAttribute('title', '拖到聊天框引用此文件');
    }
  }
  const scheduleSync = () => { if (!queued && !stopped) { queued = true; queueMicrotask(syncRows); } };
  const seatFor = event => {
    const seat = event.target?.closest?.('[data-composer-seat]');
    if (!seat || !drag || sessionId() !== drag.sessionId) return undefined;
    return seat.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') === drag.sessionId ? seat : undefined;
  };
  function onDragStart(event) {
    drag = undefined; clearHighlight();
    const handle = event.target?.closest?.('[data-dsh-file-drag]');
    const info = handle && sourceInfo(handle);
    if (!info?.ref || !info.sessionId || !event.dataTransfer) return;
    drag = { sessionId: info.sessionId, ref: info.ref, nonce: globalThis.crypto.randomUUID() };
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(FILES_MIME, drag.nonce); event.dataTransfer.setData('text/plain', info.ref.mention);
  }

  // ---- Drop local files onto the tree --------------------------------------
  let dropMark;
  const clearDrop = () => { dropMark?.removeAttribute('data-dsh-drop-target'); dropMark = undefined; };
  const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
  function dropTarget(event) {
    const row = rowOf(event.target), blank = row ? undefined : bodyOf(event.target);
    if (!row && !blank) return undefined;
    const root = (row || blank).root, directory = dropDirectory(root, row);
    const mark = row ? (row.kind === 'directory' ? row.item : row.item.parentElement.closest('[data-files-entry="directory"]') || blank?.body || row.tree.querySelector('[data-files-body]')) : blank.body;
    return { root, directory, mark };
  }
  const inTree = event => Boolean(event.target?.closest?.(TREE));
  // The host dims the whole window while a file drag is active and only clears it from its own
  // drop/dragend listeners. Files meant for the tree never reach those listeners (the host would
  // attach them to the message), so keep the overlay from starting over the tree, and always end
  // it ourselves after a drop.
  function onDragEnter(event) {
    if (!hasFiles(event) || !inTree(event)) return;
    event.preventDefault(); event.stopPropagation();
  }
  function onDragOver(event) {
    if (drag && [...(event.dataTransfer?.types ?? [])].includes(FILES_MIME)) {
      const seat = seatFor(event);
      if (!seat) { clearHighlight(); return; }
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      clearHighlight(); highlighted = seat; seat.setAttribute('data-dsh-drop-ready', ''); return;
    }
    if (!hasFiles(event)) return;
    const target = dropTarget(event);
    if (!target) { clearDrop(); return; }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    if (dropMark !== target.mark) { clearDrop(); dropMark = target.mark; dropMark?.setAttribute('data-dsh-drop-target', ''); }
  }
  function onDrop(event) {
    const types = [...(event.dataTransfer?.types ?? [])];
    if (types.includes(FILES_MIME)) {
      event.preventDefault(); event.stopPropagation();
      const seat = seatFor(event), source = drag; drag = undefined; clearHighlight();
      if (seat && source && event.dataTransfer.getData(FILES_MIME) === source.nonce) addReference(source.sessionId, source.ref);
      return;
    }
    if (!hasFiles(event)) return;
    const target = dropTarget(event); clearDrop();
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    window.dispatchEvent(new Event('dragend'));
    const id = sessionId();
    if (!id) return;
    const transfer = event.dataTransfer, task = addTask(`上传到 ${baseName(target.directory) || target.directory}`);
    task.update('正在读取文件…');
    const roots = [...(transfer.items ?? [])].filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    const loose = [...(transfer.files ?? [])];
    walkEntries(roots, loose).then(({ files, emptyFolders }) => uploadBatch(id, target.root, target.directory, files, emptyFolders ? `${emptyFolders} 个空文件夹未上传` : '', task),
      error => task.fail(`无法读取拖入的文件：${error.message}`));
  }
  function onDragLeave(event) {
    if (hasFiles(event) && inTree(event)) event.stopPropagation();
    if (!event.relatedTarget || !event.relatedTarget.closest?.(TREE)) clearDrop();
  }
  function onDragEnd() { drag = undefined; clearHighlight(); clearDrop(); }

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true });
  const listeners = [['contextmenu', onContextMenu], ['dragstart', onDragStart], ['dragenter', onDragEnter], ['dragover', onDragOver], ['drop', onDrop], ['dragleave', onDragLeave], ['dragend', onDragEnd]];
  for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
  syncRows();
  return () => {
    stopped = true; observer.disconnect(); closeMenu(); onDragEnd();
    for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
    for (const button of marked) { button.removeAttribute('draggable'); button.removeAttribute('data-dsh-file-drag'); button.removeAttribute('title'); }
    marked.clear();
    for (const card of document.querySelectorAll('[data-dsh-presented-drag]')) {
      card.removeAttribute('data-dsh-presented-drag'); card.removeAttribute('data-dsh-file-drag');
      card.removeAttribute('draggable'); card.querySelector(':scope > .dsh-files-card-grip')?.remove();
      for (const handle of card.querySelectorAll('[data-dsh-presented-handle]')) {
        handle.removeAttribute('data-dsh-presented-handle'); handle.removeAttribute('data-dsh-file-drag'); handle.removeAttribute('draggable');
      }
    }
    for (const handle of document.querySelectorAll('[data-dsh-preview-handle]')) handle.remove();
    for (const title of document.querySelectorAll('[data-dsh-preview-title]')) {
      title.removeAttribute('data-dsh-preview-title'); title.removeAttribute('data-dsh-file-drag');
      title.removeAttribute('draggable'); title.removeAttribute('title');
    }
    for (const path of document.querySelectorAll('[data-dsh-preview-path]')) {
      path.removeAttribute('data-dsh-preview-path'); path.removeAttribute('data-dsh-file-drag');
      path.removeAttribute('draggable'); path.removeAttribute('title');
    }
    for (const dispose of cleanups) dispose();
    document.querySelectorAll('.dsh-files-backdrop').forEach(node => node.remove());
  };
}
