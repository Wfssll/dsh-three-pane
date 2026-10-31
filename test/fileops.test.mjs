process.env.DSH_SSH_CONTROL_DIR = '/private/tmp/dsh-3p-test-cm'; // keep tests out of ~/.ssh
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileOps, confine, checkName, checkRelative, locate, shq, FileOpError } from '../src/fileops.js';
import { createHandlers, guardedStream } from '../src/index.js';

const ops = createFileOps();
const body = text => new Response(text).body;
const text = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); };
const rejects = (promise, status, pattern) => assert.rejects(promise, error => {
  assert.ok(error instanceof FileOpError, String(error)); assert.equal(error.status, status);
  if (pattern) assert.match(error.message, pattern); return true;
});

async function scratch() { return realpath(await mkdtemp(join(tmpdir(), 'dsh-files-'))); }

test('names and relative paths reject traversal and control characters', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'x'.repeat(256)]) assert.throws(() => checkName(bad), FileOpError);
  assert.equal(checkName('报告 final.pdf'), '报告 final.pdf');
  assert.deepEqual(checkRelative('a/b/c.txt'), ['a', 'b', 'c.txt']);
  for (const bad of ['', 'a//b', '../x', 'a/../b', '/abs']) assert.throws(() => checkRelative(bad), FileOpError);
  assert.deepEqual(confine('/w', '/w/a/b'), ['a', 'b']);
  assert.deepEqual(confine('/w', '/w'), []);
  assert.throws(() => confine('/w', '/w/../x'), /不在当前工作区/);
  assert.throws(() => confine('/w', '/other'), /不在当前工作区/);
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('locate maps SSH anchors to alias and remote root, otherwise local', async () => {
  const dir = await scratch(), file = join(dir, 'anchors.json');
  await writeFile(file, JSON.stringify([
    { anchorPath: '/a/legacy', alias: 'h1', remotePath: '/srv/legacy', uri: 'ssh://h1/srv/legacy' },
    { anchorPath: '/a/legacy 2', alias: 'h2', remotePath: '/home/x', uri: 'ssh://h2/home/x' },
  ]));
  assert.deepEqual(await locate('/a/legacy', file), { kind: 'ssh', alias: 'h1', anchorRoot: '/a/legacy', root: '/srv/legacy' });
  assert.deepEqual(await locate('/a/legacy/sub/dir', file), { kind: 'ssh', alias: 'h1', anchorRoot: '/a/legacy/sub/dir', root: '/srv/legacy/sub/dir' });
  assert.equal((await locate('/a/legacy 2', file)).alias, 'h2');
  assert.deepEqual(await locate('/a/legacyX', file), { kind: 'local', root: '/a/legacyX' });
  assert.deepEqual(await locate('/Users/me/Desktop', join(dir, 'missing.json')), { kind: 'local', root: '/Users/me/Desktop' });
  await rm(dir, { recursive: true });
});

test('local workspace: upload, no-clobber, download, rename, mkdir, delete', async () => {
  const root = await scratch(), where = { kind: 'local', root };
  await ops.mkdir(where, root, 'data');
  await ops.upload(where, join(root, 'data'), 'a.txt', body('alpha'));
  await rejects(ops.upload(where, join(root, 'data'), 'a.txt', body('again')), 409, /已存在/);
  assert.equal(await readFile(join(root, 'data/a.txt'), 'utf8'), 'alpha');
  await ops.upload(where, join(root, 'data'), 'a.txt', body('beta'), { replace: true });
  assert.equal(await readFile(join(root, 'data/a.txt'), 'utf8'), 'beta');
  await ops.upload(where, root, 'tree/sub/b.txt', body('nested'));
  assert.equal(await readFile(join(root, 'tree/sub/b.txt'), 'utf8'), 'nested');
  assert.deepEqual((await readdir(join(root, 'data'))).sort(), ['a.txt'], 'no temp files left behind');

  const file = await ops.download(where, join(root, 'data/a.txt'));
  assert.equal(file.name, 'a.txt'); assert.equal(file.size, 4); assert.equal(await text(file.stream), 'beta');
  const folder = await ops.download(where, join(root, 'tree'));
  assert.equal(folder.name, 'tree.tar'); assert.ok((await text(folder.stream)).includes('b.txt')); assert.equal(await folder.failure, undefined);

  await ops.rename(where, join(root, 'data/a.txt'), '重命名 文件.txt');
  assert.deepEqual(await readdir(join(root, 'data')), ['重命名 文件.txt']);
  await rejects(ops.rename(where, join(root, 'data/重命名 文件.txt'), 'x/y'), 400);
  await ops.upload(where, join(root, 'data'), 'other.txt', body('o'));
  await rejects(ops.rename(where, join(root, 'data/other.txt'), '重命名 文件.txt'), 409, /已存在/);
  await rejects(ops.mkdir(where, root, 'data'), 409);
  await rejects(ops.rename(where, root, 'x'), 403);
  await rejects(ops.remove(where, root), 403);
  await rejects(ops.remove(where, join(root, 'nope')), 404);
  await ops.remove(where, join(root, 'data'));
  assert.equal((await readdir(root)).includes('data'), false);
  await rm(root, { recursive: true });
});

test('local workspace refuses paths and symlinks that leave the workspace', async () => {
  const root = await scratch(), outside = await scratch(), where = { kind: 'local', root };
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(root, 'escape'));
  await rejects(ops.download(where, join(root, '../x')), 403);
  await rejects(ops.download(where, join(root, 'escape/secret.txt')), 403);
  await rejects(ops.upload(where, join(root, 'escape'), 'x.txt', body('x')), 403);
  await rejects(ops.upload(where, root, '../x.txt', body('x')), 400);
  await rejects(ops.rename(where, join(root, 'escape/secret.txt'), 'y'), 403);
  await rejects(ops.remove(where, join(root, 'escape/secret.txt')), 403);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
  await ops.remove(where, join(root, 'escape'));
  assert.deepEqual(await readdir(outside), ['secret.txt'], 'deleting a link never deletes its target');
  await rm(root, { recursive: true }); await rm(outside, { recursive: true });
});

// A stand-in `ssh` that runs the received command locally, so the real POSIX
// scripts are exercised without any network or credentials.
test('SSH workspace scripts: transfer, rename, delete and confinement', async () => {
  const sandbox = await scratch(), bin = join(sandbox, 'bin'), remote = join(sandbox, 'remote'), outside = join(sandbox, 'outside');
  await mkdir(bin); await mkdir(remote); await mkdir(outside);
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do if [ "$1" = -o ]; then shift 2; else shift; fi; done\nshift\nexec sh -c "$*"\n');
  await chmod(join(bin, 'ssh'), 0o755);
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const anchors = join(sandbox, 'anchors.json'), anchor = join(sandbox, 'anchor with space [1]');
    await writeFile(anchors, JSON.stringify([{ anchorPath: anchor, alias: 'fake', remotePath: remote, uri: `ssh://fake${remote}` }]));
    const where = await locate(anchor, anchors);
    assert.equal(where.kind, 'ssh');
    await ops.mkdir(where, anchor, "it's a dir");
    await rejects(ops.mkdir(where, anchor, "it's a dir"), 409, /已存在/);
    await ops.upload(where, join(anchor, "it's a dir"), '数据 1.txt', body('remote bytes'));
    await ops.upload(where, anchor, 'deep/er/c.txt', body('deeper'));
    assert.equal(await readFile(join(remote, "it's a dir/数据 1.txt"), 'utf8'), 'remote bytes');
    assert.equal(await readFile(join(remote, 'deep/er/c.txt'), 'utf8'), 'deeper');
    await rejects(ops.upload(where, join(anchor, "it's a dir"), '数据 1.txt', body('x')), 409, /已存在/);
    await ops.upload(where, join(anchor, "it's a dir"), '数据 1.txt', body('replaced'), { replace: true });
    assert.equal(await readFile(join(remote, "it's a dir/数据 1.txt"), 'utf8'), 'replaced');
    assert.deepEqual((await readdir(join(remote, "it's a dir"))), ['数据 1.txt'], 'no temp files left behind');

    const file = await ops.download(where, join(anchor, "it's a dir/数据 1.txt"));
    assert.equal(file.name, '数据 1.txt'); assert.equal(await text(file.stream), 'replaced'); assert.equal(await file.failure, undefined);
    const folder = await ops.download(where, join(anchor, 'deep'));
    assert.equal(folder.name, 'deep.tar'); assert.ok((await text(folder.stream)).includes('c.txt')); assert.equal(await folder.failure, undefined);
    await rejects(ops.download(where, join(anchor, 'missing.txt')), 404);

    await ops.rename(where, join(anchor, "it's a dir/数据 1.txt"), 'new name.txt');
    assert.deepEqual(await readdir(join(remote, "it's a dir")), ['new name.txt']);
    await ops.upload(where, join(anchor, "it's a dir"), 'other.txt', body('o'));
    await rejects(ops.rename(where, join(anchor, "it's a dir/other.txt"), 'new name.txt'), 409, /已存在/);
    await rejects(ops.rename(where, anchor, 'x'), 403);
    await rejects(ops.remove(where, anchor), 403);
    await rejects(ops.download(where, join(anchor, '../x')), 403);

    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(remote, 'escape'));
    await rejects(ops.download(where, join(anchor, 'escape/secret.txt')), 403);
    await rejects(ops.upload(where, join(anchor, 'escape'), 'x.txt', body('x')), 403);
    await rejects(ops.remove(where, join(anchor, 'escape/secret.txt')), 403);
    await rejects(ops.download(where, join(anchor, 'escape')), 403);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
    await ops.remove(where, join(anchor, 'escape'));
    assert.deepEqual(await readdir(outside), ['secret.txt']);
    await ops.remove(where, join(anchor, "it's a dir"));
    assert.equal((await readdir(remote)).includes("it's a dir"), false);
  } finally { process.env.PATH = previous; await rm(sandbox, { recursive: true }); }
});

test('SSH connection failure is reported, not hidden', async () => {
  const sandbox = await scratch(), bin = join(sandbox, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho "ssh: connect to host x port 22: Operation timed out" >&2\nexit 255\n');
  await chmod(join(bin, 'ssh'), 0o755);
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const where = { kind: 'ssh', alias: 'x', anchorRoot: '/anchor', root: '/remote' };
    await rejects(ops.rename(where, '/anchor/a', 'b'), 502, /SSH 连接失败.*timed out/);
    await rejects(ops.upload(where, '/anchor', 'a.txt', body('x')), 502, /SSH 连接失败/);
  } finally { process.env.PATH = previous; await rm(sandbox, { recursive: true }); }
});

test('HTTP handlers bind to the session workspace and require the request marker', async () => {
  const root = await scratch(), seen = [];
  const handlers = createHandlers({ resolveScope: async id => { seen.push(id); return id === 'live' ? { workspaceRoot: root } : undefined; } });
  const url = (op, query) => `http://host/api/dsh-files/${op}?${new URLSearchParams(query)}`;
  const post = (op, query, init = {}) => handlers[op](new Request(url(op, query), { method: 'POST', headers: { 'x-dsh-files': '1' }, ...init }));

  assert.equal((await post('mkdir', { sessionId: 'live', dir: root, name: 'docs' })).status, 200);
  const upload = await post('upload', { sessionId: 'live', dir: join(root, 'docs'), name: 'n.txt' }, { body: 'hello', duplex: 'half' });
  assert.equal(upload.status, 200);
  const dup = await post('upload', { sessionId: 'live', dir: join(root, 'docs'), name: 'n.txt' }, { body: 'x', duplex: 'half' });
  assert.equal(dup.status, 409); assert.match((await dup.json()).error, /已存在/);

  const download = await handlers.download(new Request(url('download', { sessionId: 'live', path: join(root, 'docs/n.txt') })));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''n\.txt/);
  assert.equal(await download.text(), 'hello');
  const missing = await handlers.download(new Request(url('download', { sessionId: 'live', path: join(root, 'docs/zzz') })));
  assert.equal(missing.status, 404);

  assert.equal((await handlers.download(new Request(url('download', { sessionId: 'gone', path: root })))).status, 404);
  assert.equal((await handlers.download(new Request(url('download', { path: root })))).status, 400);
  assert.equal((await handlers.remove(new Request(url('remove', { sessionId: 'live', path: join(root, 'docs') }), { method: 'POST' }))).status, 403,
    'a mutation without the x-dsh-files header is refused');
  assert.equal((await handlers.remove(new Request(url('remove', { sessionId: 'live', path: join(root, 'docs') })))).status, 405);
  assert.equal((await post('rename', { sessionId: 'live', path: join(root, 'docs'), name: '../escape' })).status, 400);
  assert.equal((await post('rename', { sessionId: 'live', path: join(root, 'docs'), name: 'docs2' })).status, 200);
  assert.equal((await post('remove', { sessionId: 'live', path: join(root, 'docs2') })).status, 200);
  assert.equal((await post('remove', { sessionId: 'live', path: join('/etc', 'hosts') })).status, 403);
  assert.equal((await (await handlers.ping(new Request(url('ping', { sessionId: 'live' })))).json()).kind, 'local');
  await rm(root, { recursive: true });
});

test('guardedStream errors a truncated download instead of closing it cleanly', async () => {
  const { Readable } = await import('node:stream');
  const ok = new Response(guardedStream(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), Promise.resolve()));
  assert.equal(await ok.text(), 'abcd');
  const bad = new Response(guardedStream(Readable.from([Buffer.from('ab')]), Promise.resolve(new Error('ssh died'))));
  await assert.rejects(bad.text(), /ssh died/);
});

test('SSH operations use the host filesystem service for fast stat and small downloads', async () => {
  const seen = [];
  const where = { kind: 'ssh', alias: 'fake', anchorRoot: '/anchor', root: '/remote' };
  const fake = {
    async resolve(path, { cwd }) { seen.push(['resolve', path, cwd]); const remote = path.startsWith('/remote') ? path : path.startsWith('/anchor') ? path.replace('/anchor', '/remote') : `/remote/${path}`; return { targetKey: `ssh://fake${remote}` }; },
    processPath(target) { return target.targetKey.replace('ssh://fake', ''); },
    async stat() { return { type: 'file', size: 5 }; },
    async readBytes(target, signal, max) { seen.push(['readBytes', target.targetKey, max]); return new Uint8Array(Buffer.from('hello')); },
  };
  const fast = createFileOps({ fs: fake });
  const info = await fast.stat(where, 'report.pdf');
  assert.deepEqual(info, { name: 'report.pdf', directory: false, size: 5 });
  const file = await fast.download(where, '/anchor/report.pdf');
  assert.equal(file.name, 'report.pdf'); assert.equal(file.size, 5);
  assert.equal(Buffer.from(file.bytes).toString(), 'hello');
  assert.equal(file.stream, undefined);
  assert.deepEqual(seen[0], ['resolve', '/remote/report.pdf', '/anchor']);
  const remote = await fast.stat(where, '/remote/sub/文件.pdf');
  assert.deepEqual(remote, { name: '文件.pdf', directory: false, size: 5 });
  const hybrid = await fast.stat(where, '/anchor/remote/sub/文件.pdf');
  assert.deepEqual(hybrid, { name: '文件.pdf', directory: false, size: 5 });
  assert.ok(seen.some(entry => entry[1] === '/remote/sub/文件.pdf'));

  const outside = {
    async resolve() { return { targetKey: 'ssh://fake/srv/outside.pdf' }; },
    processPath(target) { return target.targetKey.replace('ssh://fake', ''); },
    async stat() { return { type: 'file', size: 1 }; },
  };
  await rejects(createFileOps({ fs: outside }).download(where, '/anchor/escape.pdf'), 403, /工作区/);
});

test('download responses carry helper-read bytes without building a stream', async () => {
  const root = await scratch();
  const handlers = createHandlers({
    resolveScope: async () => ({ workspaceRoot: root }),
    ops: { download: async () => ({ name: 'report.pdf', directory: false, size: 5, bytes: Buffer.from('hello'), failure: Promise.resolve() }) },
  });
  const response = await handlers.download(new Request(`http://host/api/dsh-files/download?${new URLSearchParams({ sessionId: 's', path: 'report.pdf' })}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal(await response.text(), 'hello');
  await rm(root, { recursive: true });
});
