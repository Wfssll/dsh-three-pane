import * as React from 'react';
import { createPortal } from 'react-dom';
import { createProjection, filesWidth, paneWidths, createFilesControl } from './model.js';
import { mountFileTools } from './files.js';

export const name = 'dsh-three-pane-client';
export const inject = ['slots', 'sidebarRight'];
const h = React.createElement;

function findCenter() {
  let node = document.querySelector('#root [data-slot="main.conversation"], #root [data-slot="conversation"]')?.parentElement;
  while (node && getComputedStyle(node).display === 'contents') node = node.parentElement;
  return node || null;
}

function useCenter() {
  const [center, setCenter] = React.useState(findCenter);
  React.useLayoutEffect(() => {
    let frame;
    const locate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setCenter(previous => previous?.isConnected ? previous : findCenter());
      });
    };
    const observer = new MutationObserver(locate);
    observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    locate();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return center;
}

// Keep the native history/new-session buttons together. The folder icon is
// inserted immediately before the existing history toggle in either header.
function useFilesButtonHost() {
  const [target, setTarget] = React.useState(null);
  React.useLayoutEffect(() => {
    let host, markedFrame, raf;
    const labels = new Set(['打开侧边栏', '收起侧边栏', 'Open sidebar', 'Collapse sidebar', 'Toggle sidebar']);
    const locate = () => {
      const leading = document.querySelector('[data-shell-leading]');
      const sidebar = document.querySelector('[data-slot="sidebar"]');
      const scope = leading || sidebar;
      const toggle = scope && [...scope.querySelectorAll('button[aria-label]')].find(button => labels.has(button.getAttribute('aria-label')));
      if (!toggle) return;
      let anchor = toggle;
      while (anchor.parentElement?.tagName === 'SPAN' && anchor.parentElement.children.length === 1) anchor = anchor.parentElement;
      const parent = anchor.parentElement;
      if (host?.parentElement === parent && host.nextSibling === anchor) return;
      host?.remove(); markedFrame?.removeAttribute('data-dsh-files-button-frame');
      host = document.createElement('span'); host.className = 'dsh-files-button-host';
      parent.insertBefore(host, anchor);
      let column = sidebar?.parentElement;
      while (column && getComputedStyle(column).display === 'contents') column = column.parentElement;
      markedFrame = leading?.parentElement || findCenter()?.parentElement || column?.parentElement;
      markedFrame?.setAttribute('data-dsh-files-button-frame', '');
      setTarget(host);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; locate(); }); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    locate();
    return () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); host?.remove(); markedFrame?.removeAttribute('data-dsh-files-button-frame'); };
  }, []);
  return target;
}

function FilesToggle({ control, sidebar }) {
  const state = React.useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const target = useFilesButtonHost();
  const sessionId = sidebar.mounted.getSnapshot();
  const open = Boolean(state.open[sessionId]);
  const label = open ? '收起文件栏' : '展开文件栏';
  return target && createPortal(h('button', {
    type: 'button', className: 'dsh-files-toggle', 'data-dsh-files-toggle': '',
    title: label, 'aria-label': label, 'aria-expanded': open,
    disabled: !sessionId || !control.ready(sessionId),
    onClick: () => control.toggle(sessionId),
  }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }))), target);
}

function alignLeadingControls(center, pane) {
  const frame = center.parentElement;
  let raf;
  const keys = ['--dsh-files-leading-x', '--dsh-files-leading-y', '--dsh-files-leading-space'];
  const saved = new Map(keys.map(key => [key, frame.style.getPropertyValue(key)]));
  const sync = () => {
    const leading = frame.querySelector('[data-shell-leading]');
    const strip = pane.querySelector('[data-dockkit-strip]');
    if (!frame.hasAttribute('data-sidebar-collapsed') || !leading || !strip) {
      frame.removeAttribute('data-dsh-files-leading'); return;
    }
    frame.setAttribute('data-dsh-files-leading', '');
    const frameRect = frame.getBoundingClientRect(), header = strip.getBoundingClientRect();
    const buttons = leading.getBoundingClientRect();
    const right = pane.getBoundingClientRect().right;
    frame.style.setProperty('--dsh-files-leading-x', `${right - (buttons.width || 100) - 8 - frameRect.left}px`);
    frame.style.setProperty('--dsh-files-leading-y', `${header.top + (header.height - (buttons.height || 28)) / 2 - frameRect.top}px`);
    frame.style.setProperty('--dsh-files-leading-space', `${(buttons.width || 100) + 16}px`);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => {
    raf = null; sync();
    if (frame.hasAttribute('data-animating')) schedule();
  }); };
  const observer = new MutationObserver(schedule);
  observer.observe(frame, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] });
  const resize = new ResizeObserver(schedule); resize.observe(frame); resize.observe(pane); resize.observe(center);
  sync();
  return () => {
    observer.disconnect(); resize.disconnect(); if (raf) cancelAnimationFrame(raf);
    frame.removeAttribute('data-dsh-files-leading');
    for (const [key, value] of saved) value ? frame.style.setProperty(key, value) : frame.style.removeProperty(key);
  };
}

function NativeFilesLeft({ NativeSeat, sidebar, control, ...props }) {
  const { sessionId, active, useStore, actions, syncPresentation } = props;
  const center = useCenter();
  const [geometry, setGeometry] = React.useState({ viewport: props.viewportWidth || 1280, history: 0, macLeading: false });
  const [preferred, setPreferred] = React.useState(300);
  const fullSurface = useStore(state => state.bySession[sessionId]);
  const hasFiles = Object.values(fullSurface?.layout.tabs || {}).some(tab => tab.kind === 'files');
  const hasPreview = Object.values(fullSurface?.layout.tabs || {}).some(tab => tab.kind !== 'files');
  const controlState = React.useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const open = controlState.open[sessionId] ?? Boolean(hasFiles && fullSurface?.layout.expanded);
  const filesProjection = React.useMemo(() => createProjection('files', open), [sessionId, open]);
  const previewProjection = React.useMemo(() => createProjection('preview'), [sessionId]);
  const useFilesStore = React.useCallback(selector => useStore(state => selector(filesProjection(state))), [useStore, filesProjection]);
  const usePreviewStore = React.useCallback(selector => useStore(state => selector(previewProjection(state))), [useStore, previewProjection]);
  const surface = useFilesStore(state => state.bySession[sessionId]);
  const previewSurface = usePreviewStore(state => state.bySession[sessionId]);
  const shown = Boolean(active && center && surface?.layout.expanded);
  const dimensions = paneWidths(geometry.viewport, geometry.history, preferred,
    previewSurface?.layout.expanded ? props.width : 0, geometry.macLeading);
  const width = dimensions.files;
  const available = geometry.viewport - geometry.history;
  const paneRef = React.useRef(null);
  const runtime = React.useRef(); runtime.current = { fullSurface, hasFiles };
  React.useLayoutEffect(() => {
    control.ensure(sessionId, Boolean(runtime.current.hasFiles && runtime.current.fullSurface?.layout.expanded));
    return control.bind(sessionId, () => {
      if (sidebar.mounted.getSnapshot() !== sessionId) return false;
      if (!runtime.current.hasFiles) {
        const wasExpanded = Boolean(runtime.current.fullSurface?.layout.expanded);
        sidebar.openTab('files');
        // Opening only the explorer must not open/close the preview sidebar.
        actions.setExpanded(sessionId, wasExpanded);
      }
      return true;
    });
  }, [control, sessionId, sidebar, actions]);
  const hadFiles = React.useRef(hasFiles);
  React.useEffect(() => {
    if (hadFiles.current && !hasFiles) control.set(sessionId, false);
    hadFiles.current = hasFiles;
  }, [hasFiles, control, sessionId]);
  React.useEffect(() => {
    if (active && fullSurface?.layout.expanded && hasFiles && !hasPreview && sidebar.mounted.getSnapshot() === sessionId) {
      sidebar.openTab('guide');
    }
  }, [active, fullSurface?.layout.expanded, hasFiles, hasPreview, sidebar, sessionId]);
  const stopDrag = React.useRef(null);
  React.useEffect(() => () => stopDrag.current?.(), []);
  React.useLayoutEffect(() => {
    if (!center) return;
    const frame = center.parentElement;
    const measure = () => {
      const rect = frame.getBoundingClientRect(), column = center.getBoundingClientRect();
      const nativeHistory = frame.style.gridTemplateColumns.match(/^([\d.]+)px/);
      const next = {
        viewport: rect.width || props.viewportWidth,
        history: nativeHistory ? Number(nativeHistory[1]) : Math.max(0, (column.left || 0) - (rect.left || 0)),
        macLeading: frame.hasAttribute('data-sidebar-collapsed') && document.documentElement.dataset.platform === 'darwin'
          && !document.documentElement.hasAttribute('data-fullscreen'),
      };
      setGeometry(previous => Object.keys(next).every(key => next[key] === previous[key]) ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame); observer.observe(center);
    const mutations = new MutationObserver(measure);
    mutations.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'style'] });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fullscreen'] });
    measure();
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [center, props.viewportWidth]);
  React.useLayoutEffect(() => {
    if (!center || !shown) return;
    const previous = center.style.getPropertyValue('--dsh-native-files-width');
    center.setAttribute('data-dsh-native-files-center', '');
    center.style.setProperty('--dsh-native-files-width', `${width}px`);
    const frame = center.parentElement;
    const values = { '--dsh-files-history-track': `${geometry.history}px`, '--dsh-files-middle-min': `${width + 400}px`, '--dsh-files-preview-track': `${dimensions.preview}px` };
    const previousFrame = Object.fromEntries(Object.keys(values).map(key => [key, frame.style.getPropertyValue(key)]));
    frame.setAttribute('data-dsh-native-files-frame', '');
    for (const [key, value] of Object.entries(values)) frame.style.setProperty(key, value);
    return () => {
      center.removeAttribute('data-dsh-native-files-center');
      if (previous) center.style.setProperty('--dsh-native-files-width', previous);
      else center.style.removeProperty('--dsh-native-files-width');
      frame.removeAttribute('data-dsh-native-files-frame');
      for (const [key, value] of Object.entries(previousFrame)) value ? frame.style.setProperty(key, value) : frame.style.removeProperty(key);
    };
  }, [center, shown, width, geometry.history, dimensions.preview]);
  React.useLayoutEffect(() => {
    if (!shown || !paneRef.current) return;
    return alignLeadingControls(center, paneRef.current);
  }, [center, shown]);
  const collapseFiles = React.useCallback(() => control.set(sessionId, false), [control, sessionId]);
  const leftActions = React.useMemo(() => ({ ...actions,
    toggleExpanded: collapseFiles,
    setExpanded: (_id, value) => { if (!value) collapseFiles(); },
  }), [actions, collapseFiles]);
  const noPresentation = React.useCallback(() => {}, []);
  const previewPresentation = React.useCallback(value => {
    syncPresentation(value);
  }, [syncPresentation]);
  const resize = event => {
    if (event.button !== 0) return;
    event.preventDefault(); stopDrag.current?.();
    const origin = event.clientX, initial = width;
    const previousCursor = document.body.style.cursor, previousSelection = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    const move = event => setPreferred(filesWidth(available, initial + event.clientX - origin));
    const end = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end); window.removeEventListener('blur', end);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection;
      stopDrag.current = null;
    };
    stopDrag.current = end;
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end); window.addEventListener('blur', end);
  };
  return h(React.Fragment, null,
    h(NativeSeat, { ...props, width: shown ? dimensions.preview : props.width, useStore: usePreviewStore, syncPresentation: previewPresentation }),
    shown && createPortal(h('div', {
      ref: paneRef,
      'data-dsh-native-files-left': '',
      style: { width },
    }, h(NativeSeat, {
      ...props, width, viewportWidth: Math.max(768, props.viewportWidth), canShow: true,
      useStore: useFilesStore, actions: leftActions, syncPresentation: noPresentation,
      t: (key, ...args) => key === 'chrome.collapseAria' ? '收起文件栏' : props.t(key, ...args),
      measureRoom: noPresentation, reportAutoFullscreen: noPresentation,
      toggleFullscreen: noPresentation, closeTab: collapseFiles,
    }), h('div', {
      'data-dsh-native-files-resize': '', role: 'separator', tabIndex: 0,
      'aria-label': '调整文件栏宽度', 'aria-orientation': 'vertical', 'aria-valuenow': width,
      'aria-valuemin': 220, 'aria-valuemax': 480,
      onPointerDown: resize,
      onDoubleClick: () => setPreferred(300),
      onKeyDown: event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); setPreferred(filesWidth(available, width + (event.key === 'ArrowRight' ? 16 : -16)));
      },
    })), center));
}


// The remote @ index is built below the caret. Once it settles, re-run the
// open menu so deeper matches appear without closing and reopening @.
function mountReferenceRefresh(scope, sidebar) {
  let polling = false, handled = false, timer;
  const menuOpen = () => document.querySelector('[data-trigger-menu]');
  const sessionId = () => sidebar.mounted.getSnapshot();
  const controllerFor = id => {
    try {
      const actx = scope.sessions?.scope?.(id);
      return actx ? scope.inputTriggers?.sessionOf?.(actx) : undefined;
    } catch { return undefined; }
  };
  const refresh = id => { try { controllerFor(id)?.refreshOpenMenu?.(); } catch { /* menu already gone */ } };
  const status = async id => {
    const response = await fetch(`/api/dsh-files/refsStatus?${new URLSearchParams({ sessionId: id })}`, { credentials: 'same-origin' });
    if (!response.ok) return undefined;
    return response.json();
  };
  const poll = async id => {
    if (polling) return;
    polling = true;
    let attempts = 0;
    const tick = async () => {
      if (!menuOpen()) { polling = false; return; }
      let current;
      try { current = await status(id); } catch { current = undefined; }
      if (!current || current.kind !== 'ssh') { polling = false; return; }
      if (current.state === 'ready' || current.state === 'error' || attempts >= 20) {
        if (current.count > 0) refresh(id);
        polling = false; return;
      }
      attempts += 1;
      timer = setTimeout(tick, attempts < 4 ? 250 : 500);
    };
    tick();
  };
  const kick = () => {
    if (!menuOpen()) { handled = false; return; }
    if (handled) return;
    const id = sessionId();
    if (!id) return;
    handled = true;
    poll(id);
  };
  const onInput = () => { handled = false; kick(); };
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusin', kick, true);
  document.addEventListener('keydown', kick, true);
  // The menu can mount after the input event; watch for it so the first @ in a
  // remote workspace still gets the refresh when its index settles.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!menuOpen()) { handled = false; return; }
    if (!handled) kick();
  }) : undefined;
  observer?.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer?.disconnect();
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('focusin', kick, true);
    document.removeEventListener('keydown', kick, true);
    clearTimeout(timer);
    polling = false;
  };
}

export function apply(ctx) {
  const control = createFilesControl();
  ctx.effect(() => ctx.sidebarRight.mounted.subscribe(control.pulse));
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-three-pane.files-toggle', inject: () => ({ control, sidebar: ctx.sidebarRight }),
  }, FilesToggle)));
  // File tree tools need the session and composer services; without them the layout still works.
  ctx.effect(() => {
    const fiber = ctx.inject?.(['sessions', 'conversation', 'sidebarRight'], scope => mountFileTools(scope));
    return () => fiber?.dispose?.();
  });
  // Optional: refresh an open @ menu when the background remote index settles.
  ctx.effect(() => {
    const fiber = ctx.inject?.(['inputTriggers', 'sessions'], scope => mountReferenceRefresh(scope, ctx.sidebarRight));
    return () => fiber?.dispose?.();
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-three-pane'; style.textContent = CSS;
    document.head.append(style); return () => style.remove();
  });
  ctx.effect(() => ctx.slots.inject('rightbar.session', () => {
    const original = ctx.slots.entries('rightbar.session').find(entry => entry.component && entry.id !== 'dsh-three-pane.native-pulse');
    if (!original) return;
    const NativeSeat = original.component;
    const Adapter = props => h(NativeFilesLeft, { ...props, NativeSeat, sidebar: ctx.sidebarRight, control });
    // Keep the native registration itself as the child-slot owner. Re-declaring
    // its children in a replacement entry is forbidden by the host framework.
    // The scoped decorator preserves its store, injected services, and original
    // renderSlot authorization; disposal restores the exact native component.
    let refresh;
    try {
      original.component = Adapter;
      refresh = ctx.slots.register({
        name: 'rightbar.session', id: 'dsh-three-pane.native-pulse', priority: (original.priority || 0) + 1000,
      }, () => null);
    } catch (error) {
      if (original.component === Adapter) original.component = NativeSeat;
      console.error('[dsh-three-pane] Native panel adapter unavailable', error);
      return;
    }
    return () => {
      if (original.component === Adapter) original.component = NativeSeat;
      refresh?.();
    };
  }));
}
