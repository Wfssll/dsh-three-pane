// Host half. The client half (lib/client.js) is discovered through package.json's
// dsh.client and the ./client export. File tree operations run here, on the host,
// because the renderer cannot write files; workspaces resolve through the host's
// own workspaceFileScope lookup so every request is bound to one session root.
import { createFileOps, locate, FileOpError } from './fileops.js';
import { installQuickReferences } from './references.js';

export const name = 'dsh-three-pane';
export const PREFIX = '/api/dsh-files';

const headers = { 'cache-control': 'no-store' };
const json = (value, status = 200) => Response.json(value, { status, headers });

function disposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Web stream over a Node stream that errors, instead of ending cleanly, when the producer failed. */
export function guardedStream(stream, failure) {
  return new ReadableStream({
    start(controller) {
      stream.on('data', chunk => { controller.enqueue(new Uint8Array(chunk)); if (controller.desiredSize <= 0) stream.pause(); });
      stream.on('end', async () => { const error = await failure; if (error) controller.error(error); else controller.close(); });
      stream.on('error', error => controller.error(error));
    },
    pull() { stream.resume(); },
    cancel() { stream.destroy(); },
  });
}

export function createHandlers({ resolveScope, ops = createFileOps(), find = locate, references = () => undefined }) {
  const workspace = async url => {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) throw new FileOpError('需要会话身份。', 400);
    const scope = await resolveScope(sessionId);
    if (!scope?.workspaceRoot) throw new FileOpError('会话不存在或不可访问。', 404);
    return find(scope.workspaceRoot);
  };
  const param = (url, key) => {
    const value = url.searchParams.get(key);
    if (value === null) throw new FileOpError(`缺少参数 ${key}。`, 400);
    return value;
  };
  const guarded = (method, handle) => async request => {
    try {
      if (request.method !== method) throw new FileOpError('请求方法不支持。', 405);
      if (method === 'POST' && request.headers.get('x-dsh-files') !== '1') throw new FileOpError('缺少请求标记。', 403);
      return await handle(request, new URL(request.url), await workspace(new URL(request.url)));
    } catch (error) {
      if (request.signal?.aborted) return new Response(null, { status: 499 });
      return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof FileOpError ? error.status : 500);
    }
  };
  return {
    stat: guarded('GET', async (_request, url, where) => json(await ops.stat(where, param(url, 'path')))),
    download: guarded('GET', async (request, url, where) => {
      const file = await ops.download(where, param(url, 'path'), request.signal);
      const responseHeaders = { ...headers, 'content-type': 'application/octet-stream', 'content-disposition': disposition(file.name),
        ...(file.size === undefined || file.directory ? {} : { 'content-length': String(file.size) }) };
      if (file.bytes) return new Response(file.bytes, { headers: responseHeaders });
      return new Response(guardedStream(file.stream, file.failure), { headers: responseHeaders });
    }),
    upload: guarded('POST', async (request, url, where) => json({ ok: true, ...await ops.upload(where, url.searchParams.get('dir') ?? '',
      param(url, 'name'), request.body, { replace: url.searchParams.get('replace') === '1', signal: request.signal }) })),
    rename: guarded('POST', async (_request, url, where) => { await ops.rename(where, param(url, 'path'), param(url, 'name')); return json({ ok: true }); }),
    remove: guarded('POST', async (_request, url, where) => { await ops.remove(where, param(url, 'path')); return json({ ok: true }); }),
    mkdir: guarded('POST', async (_request, url, where) => { await ops.mkdir(where, url.searchParams.get('dir') ?? '', param(url, 'name')); return json({ ok: true }); }),
    ping: guarded('GET', async (_request, _url, where) => json({ ok: true, kind: where.kind })),
    refsStatus: guarded('GET', async (_request, _url, where) => json({ ok: true, ...references()?.status?.(where) })),
  };
}

export function apply(ctx) {
  // Keep the file API optional when a smaller host build has no `fs`, while
  // still handing it to operations when the native filesystem service exists.
  let hostFs, hostWorkspaceFiles;
  const fsFiber = ctx.inject?.(['fs'], scope => {
    hostFs = scope.fs;
    return () => { if (hostFs === scope.fs) hostFs = undefined; };
  });
  const workspaceFilesFiber = ctx.inject?.(['workspaceFiles'], scope => {
    hostWorkspaceFiles = scope.workspaceFiles;
    return () => { if (hostWorkspaceFiles === scope.workspaceFiles) hostWorkspaceFiles = undefined; };
  });
  let references;
  const referencesFiber = ctx.inject?.(['fileReferences', 'fs'], scope => {
    references = installQuickReferences(scope.fileReferences, {
      find: locate, ops: createFileOps({ fs: scope.fs }), fs: scope.fs, workspaceFiles: () => hostWorkspaceFiles,
    });
    return references;
  });
  // `inject` only runs while the host services exist, so a smaller host build
  // still loads the client half without file operations.
  const fiber = ctx.inject?.(['connection', 'typert'], scope => {
    const handlers = createHandlers({
      resolveScope: sessionId => scope.typert.lookups.get('workspaceFileScope')?.resolve(sessionId),
      ops: createFileOps({ fs: () => hostFs }),
      references: () => references,
    });
    const disposers = Object.entries(handlers).map(([op, fetch]) => scope.connection.fetch.register({
      path: `${PREFIX}/${op}`, methods: ['upload', 'rename', 'remove', 'mkdir'].includes(op) ? ['POST'] : ['GET'],
      requestBody: op === 'upload' ? 'streaming' : 'buffered', fetch,
    }));
    return async () => { await Promise.all(disposers.map(dispose => dispose?.())); };
  });
  return async () => { await Promise.all([fiber?.dispose(), fsFiber?.dispose(), workspaceFilesFiber?.dispose(), referencesFiber?.dispose()]); };
}
