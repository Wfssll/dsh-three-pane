// Fast `@` completion. The SSH plugin answers `@` by building a discovery index
// of the whole remote workspace over the helper connection; until that index
// exists (and again after every invalidation) the picker waits tens of seconds
// on the older local-SSH path. This layer answers from one live directory
// listing over the same helper connection, caches it, and builds a bounded
// recursive index in the background so a bare name can match deeper paths too.

const MAX_RESULTS = 20;
const DIRECTORY_TTL_MS = 4000;
const DIRECTORY_STALE_MS = 5 * 60 * 1000;
const MAX_DIRECTORIES = 400;
const INDEX_TTL_MS = 30 * 1000;
const INDEX_MAX_ENTRIES = 20000;
const INDEX_MAX_DIRECTORIES = 600;
const INDEX_MAX_MS = 8000;
const INDEX_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo',
  '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle', '.idea', '.cache', '.DS_Store',
]);

const usable = name => name.length <= 255 && !/[\\"\u0000-\u001f\u007f-\u009f]/u.test(name);

/** Rank entries of one directory for the text typed after the last `/`. */
export function rankEntries(entries, prefix, typed) {
  const needle = typed.toLocaleLowerCase();
  const showHidden = typed.startsWith('.') || prefix.split('/').some(part => part.startsWith('.'));
  const rows = [];
  for (const entry of entries) {
    if (!usable(entry.name) || (!showHidden && entry.name.startsWith('.'))) continue;
    const name = entry.name.toLocaleLowerCase();
    let score = !needle ? 100 : name === needle ? 1000 : name.startsWith(needle) ? 900 : name.includes(needle) ? 700 : 0;
    if (!score && needle) { let at = 0; for (const ch of name) if (ch === needle[at]) at++; if (at === needle.length) score = 300; }
    if (score) rows.push({ entry, score: score + (entry.kind === 'directory' ? 25 : 0) });
  }
  rows.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: 'base' }));
  return rows.slice(0, MAX_RESULTS).map(({ entry }) => ({ path: prefix + entry.name, kind: entry.kind }));
}

/** Rank whole-workspace paths from the bounded background index. */
export function rankPaths(entries, typed, limit = MAX_RESULTS) {
  const needle = typed.toLocaleLowerCase();
  const showHidden = typed.startsWith('.') || typed.includes('/.');
  const rows = [];
  for (const entry of entries) {
    if (!showHidden && entry.path.split('/').some(part => part.startsWith('.'))) continue;
    const name = entry.path.split('/').at(-1).toLocaleLowerCase();
    let score = name === needle ? 1000 : name.startsWith(needle) ? 900 : name.includes(needle) ? 700
      : entry.path.toLocaleLowerCase().includes(needle) ? 500 : 0;
    if (!score && needle) {
      let at = 0;
      const path = entry.path.toLocaleLowerCase();
      for (const ch of path) if (ch === needle[at]) at++;
      if (at === needle.length) score = 300;
    }
    if (score) rows.push({ entry, score: score + (entry.kind === 'directory' ? 25 : 0) });
  }
  rows.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length
    || a.entry.path.localeCompare(b.entry.path, undefined, { numeric: true, sensitivity: 'base' }));
  return rows.slice(0, limit).map(({ entry }) => ({ path: entry.path, kind: entry.kind }));
}

/** Split an `@` query into the directory typed so far and the name being typed; undefined if unsafe. */
export function splitQuery(query) {
  if (typeof query !== 'string' || query.length > 4096 || query.includes('\0')) return undefined;
  const cleaned = query.replace(/^(\.\/)+/, '');
  const at = cleaned.lastIndexOf('/');
  const prefix = at < 0 ? '' : cleaned.slice(0, at + 1), typed = cleaned.slice(at + 1);
  if (prefix.startsWith('/') || prefix.split('/').some(part => part === '..')) return undefined;
  return { prefix, typed };
}

const workspaceBase = where => where.kind === 'ssh' ? where.anchorRoot : where.root;
const absoluteDirectory = (where, relative) => {
  const base = workspaceBase(where).replace(/\/+$/, '');
  return relative ? `${base}/${relative.replace(/^\/+/, '')}` : base;
};

/**
 * Wrap `service.list` through an accessor so the order in which plugins install
 * their own wrappers does not matter: whoever assigns later becomes the inner
 * function, and disposing restores whatever is innermost.
 */
export function installQuickReferences(service, { find, ops, fs, workspaceFiles, listDirectory, now = Date.now } = {}) {
  let inner = service.list;
  let disposed = false;
  const directories = new Map();
  const indexes = new Map();
  const controllers = new Set();

  const keyOf = where => `${where.kind}\0${workspaceBase(where)}`;
  const loadDirectory = async (where, relative, scope) => {
    if (typeof listDirectory === 'function') return listDirectory(where, relative);
    if (fs && where.kind === 'ssh') {
      let timedOut = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('remote directory listing timed out')); }, 3000);
        timer.unref?.();
        try {
          const target = await fs.resolve(relative || '.', { cwd: workspaceBase(where), signal: controller.signal });
          const listed = await fs.listDir(target, controller.signal);
          return listed.map(entry => ({ name: entry.name, kind: entry.type === 'directory' ? 'directory' : 'file' }));
        } finally { clearTimeout(timer); }
      } catch (error) {
        // A timeout means the helper link itself is down; the native tree uses
        // the same link, so do not make the caret wait for a second 30s timeout.
        if (timedOut) throw error;
        // The helper-routed filesystem is preferred, but the native file tree
        // service is the same seam the left panel uses; fall back to it when a
        // smaller composition has a different fs provider.
        const native = typeof workspaceFiles === 'function' ? workspaceFiles() : workspaceFiles;
        if (!native?.list) throw error;
        const listing = await native.list(scope, relative || '', undefined);
        return listing.entries.map(entry => ({ name: entry.name, kind: entry.type === 'directory' ? 'directory' : 'file' }));
      }
    }
    return ops.list(where, absoluteDirectory(where, relative));
  };

  // One live listing per directory. A hit answers synchronously; a stale hit
  // answers at once and refreshes behind the caret, so typing never queues an
  // SSH command per keystroke.
  const directory = async (where, relative, scope) => {
    const key = `${keyOf(where)}\0${relative}`;
    const cached = directories.get(key);
    if (cached) {
      cached.used = now();
      if (cached.entries && now() - cached.time < DIRECTORY_TTL_MS) return cached.entries;
      if (cached.promise) return cached.entries ?? cached.promise;
      if (cached.entries && now() - cached.time < DIRECTORY_STALE_MS) {
        cached.promise = refreshDirectory(key, where, relative, scope, cached).catch(() => cached.entries);
        return cached.entries;
      }
    }
    return (cached?.promise ?? refreshDirectory(key, where, relative, scope, cached));
  };
  const refreshDirectory = (key, where, relative, scope, previous) => {
    const promise = loadDirectory(where, relative, scope).then(entries => {
      if (disposed) return entries;
      directories.set(key, { entries, time: now(), used: now() });
      if (directories.size > MAX_DIRECTORIES) {
        const oldest = [...directories.entries()].filter(([, value]) => !value.promise).sort((a, b) => a[1].used - b[1].used)[0];
        if (oldest) directories.delete(oldest[0]);
      }
      return entries;
    }, error => {
      if (directories.get(key)?.promise === promise) directories.set(key, { ...previous, promise: undefined });
      throw error;
    });
    directories.set(key, { ...previous, entries: previous?.entries, promise, used: now() });
    return promise;
  };

  const ensureIndex = (where, scope) => {
    const key = keyOf(where);
    let entry = indexes.get(key);
    if (!entry) {
      entry = { entries: [], seen: new Set(), state: 'idle', count: 0, generation: 0, time: 0, error: undefined, building: false };
      indexes.set(key, entry);
    }
    if (entry.building || (entry.state === 'ready' && now() - entry.time < INDEX_TTL_MS)) return entry;
    entry.building = true; entry.state = 'building'; entry.error = undefined; entry.entries = []; entry.seen = new Set(); entry.count = 0;
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = now() + INDEX_MAX_MS;
    const queue = [''];
    let visited = 0;
    const run = async () => {
      while (queue.length && !controller.signal.aborted && now() < deadline) {
        if (visited >= INDEX_MAX_DIRECTORIES || entry.entries.length >= INDEX_MAX_ENTRIES) break;
        const relative = queue.shift();
        visited++;
        let listed;
        try { listed = await directory(where, relative, scope); } catch { continue; }
        for (const child of listed) {
          if (entry.entries.length >= INDEX_MAX_ENTRIES) break;
          if (!usable(child.name)) continue;
          const path = relative ? `${relative}/${child.name}` : child.name;
          if (entry.seen.has(path)) continue;
          entry.seen.add(path);
          entry.entries.push({ path, kind: child.kind });
          if (child.kind === 'directory' && !INDEX_DIRECTORIES.has(child.name)) queue.push(path);
        }
        entry.count = entry.entries.length;
      }
      entry.building = false;
      entry.state = 'ready';
      entry.time = now();
      entry.partial = visited >= INDEX_MAX_DIRECTORIES || entry.entries.length >= INDEX_MAX_ENTRIES || now() >= deadline;
      entry.generation += 1;
    };
    run().catch(error => {
      entry.building = false; entry.state = 'error'; entry.error = error instanceof Error ? error.message : String(error);
      entry.time = now(); entry.generation += 1;
    }).finally(() => { controllers.delete(controller); });
    return entry;
  };

  const quick = async (where, query, scope) => {
    const parts = splitQuery(query);
    if (!parts) return [];
    const key = keyOf(where);
    const listed = await directory(where, parts.prefix.replace(/\/+$/, ''), scope);
    const local = rankEntries(listed, parts.prefix, parts.typed);
    // The live folder always answers first. Only a bare name can use the
    // whole-workspace index, and starting that scan after the first menu is
    // visible keeps the helper connection free for what the user is looking at.
    if (parts.prefix) return local;
    let index = indexes.get(key);
    if (!index || index.state === 'idle') index = ensureIndex(where, scope);
    if (!parts.typed) return local;
    const seen = new Set(local.map(row => row.path));
    const global = rankPaths(index.entries, parts.typed).filter(row => !seen.has(row.path));
    return [...local, ...global].slice(0, MAX_RESULTS);
  };

  const list = async function (agent, query, signal) {
    const cwd = agent?.session?.header?.cwd;
    const where = cwd ? await find(cwd).catch(() => undefined) : undefined;
    if (where?.kind !== 'ssh') return inner.call(this, agent, query, signal);
    signal?.throwIfAborted();
    try {
      return await quick(where, query, { sessionId: agent?.session?.id, workspaceRoot: cwd });
    } catch (error) {
      console.warn('[dsh-three-pane] quick @ listing failed; returning no candidates', error);
      return [];
    }
  };
  Object.defineProperty(service, 'list', {
    configurable: true, enumerable: false,
    get: () => list, set: value => { inner = value; },
  });

  const status = where => {
    if (!where || where.kind !== 'ssh') return { kind: 'local', state: 'n/a', count: 0, generation: 0 };
    const entry = indexes.get(keyOf(where));
    if (!entry) return { kind: 'ssh', state: 'idle', count: 0, generation: 0 };
    return { kind: 'ssh', state: entry.state, count: entry.count, generation: entry.generation, partial: entry.partial === true, error: entry.error };
  };
  const restore = () => {
    disposed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    directories.clear();
    indexes.clear();
    Object.defineProperty(service, 'list', { configurable: true, enumerable: false, writable: true, value: inner });
  };
  restore.status = status;
  return restore;
}
