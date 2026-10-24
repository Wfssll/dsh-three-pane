/** Project the host's own layout into files and preview views without changing
 * its committed tabs, IDs, navigation, draft buffers, or persistence. */
export function projectSurface(surface, side, remembered = new Map(), expanded) {
  if (!surface) return undefined;
  const original = surface.layout;
  const nodes = {}, tabs = {};
  const accepts = tab => side === 'files' ? tab.kind === 'files' : tab.kind !== 'files';
  const visit = id => {
    const node = original.nodes[id];
    if (!node) return undefined;
    if (node.kind === 'pane') {
      const ids = node.tabs.filter(id => original.tabs[id] && accepts(original.tabs[id]));
      if (!ids.length) return undefined;
      const active = ids.includes(node.activeTabId) ? node.activeTabId
        : ids.includes(remembered.get(id)) ? remembered.get(id) : ids[ids.length - 1];
      remembered.set(id, active);
      nodes[id] = { ...node, tabs: ids, activeTabId: active };
      for (const id of ids) tabs[id] = original.tabs[id];
      return id;
    }
    const children = node.children.map(visit).filter(Boolean);
    if (children.length === 0) return undefined;
    if (children.length === 1) return children[0];
    const weights = children.map(id => node.sizes[node.children.indexOf(id)] || 1);
    const total = weights.reduce((a, b) => a + b, 0);
    nodes[id] = { ...node, children, sizes: weights.map(value => value / total) };
    return id;
  };
  let rootId = visit(original.rootId);
  const hasDockedTabs = rootId !== undefined;
  // Floating windows remain on the host preview surface; no window is moved.
  const floats = side === 'preview' ? original.floats.filter(id => {
    const pane = original.nodes[id];
    if (!pane) return false;
    nodes[id] = pane;
    for (const tabId of pane.tabs) tabs[tabId] = original.tabs[tabId];
    return true;
  }) : [];
  if (!rootId) {
    const empty = Object.values(original.nodes).find(node => node.kind === 'pane' && node.host === 'dock');
    if (!empty) return undefined;
    rootId = empty.id;
    nodes[rootId] = { ...empty, tabs: [], activeTabId: undefined };
  }
  const panes = Object.values(nodes).filter(node => node.kind === 'pane');
  const activePaneId = panes.some(node => node.id === original.activePaneId)
    ? original.activePaneId : panes.find(node => node.host === 'dock')?.id ?? panes[0].id;
  return { ...surface, layout: { ...original, nodes, tabs, rootId, floats, activePaneId,
    expanded: (expanded ?? original.expanded) && hasDockedTabs,
    ...(side === 'files' ? { mode: 'push' } : {}),
  } };
}

/** Cache projections by immutable host snapshot; selectors keep stable identity. */
export function createProjection(side, expanded) {
  const snapshots = new WeakMap();
  const remembered = new Map();
  return state => {
    let cached = snapshots.get(state);
    if (cached) return cached;
    const bySession = {};
    for (const [id, surface] of Object.entries(state.bySession)) {
      let memory = remembered.get(id);
      if (!memory) { memory = new Map(); remembered.set(id, memory); }
      bySession[id] = projectSurface(surface, side, memory, expanded);
    }
    cached = { ...state, bySession };
    snapshots.set(state, cached);
    return cached;
  };
}

/** File visibility belongs to this plugin, never to the right sidebar. */
export function createFilesControl() {
  let state = { open: {}, revision: 0 };
  const listeners = new Set(), bindings = new Map();
  const publish = open => {
    state = { open, revision: state.revision + 1 };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    pulse: () => publish(state.open),
    ensure(id, initial) { if (!(id in state.open)) publish({ ...state.open, [id]: initial }); },
    set(id, open) { if (state.open[id] !== open) publish({ ...state.open, [id]: open }); },
    bind(id, ensureFiles) {
      bindings.set(id, ensureFiles); publish(state.open);
      return () => { if (bindings.get(id) === ensureFiles) { bindings.delete(id); publish(state.open); } };
    },
    ready: id => bindings.has(id),
    toggle(id) {
      const ensureFiles = bindings.get(id);
      if (!ensureFiles) return;
      const next = !state.open[id];
      if (next && ensureFiles() === false) return;
      publish({ ...state.open, [id]: next });
    },
  };
}

export function filesWidth(available, preferred = 300) {
  return Math.min(Math.max(220, preferred), 480, Math.max(220, available - 400));
}

/** Reserve separate files/chat/preview tracks. Preview yields space first. */
export function paneWidths(viewport, history, preferred, preview, macLeading = false) {
  const workspace = Math.max(0, viewport - history);
  const files = filesWidth(workspace, Math.max(preferred, macLeading ? 400 : 220));
  const right = Math.max(0, Math.min(preview, workspace - files - 400));
  return { files, preview: right, chat: Math.max(400, workspace - files - right) };
}
