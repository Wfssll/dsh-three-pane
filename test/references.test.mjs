process.env.DSH_SSH_CONTROL_DIR = '/private/tmp/dsh-3p-test-cm'; // keep tests out of ~/.ssh
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileOps, locate } from '../src/fileops.js';
import { installQuickReferences, rankEntries, rankPaths, splitQuery } from '../src/references.js';

test('splitQuery separates the typed directory from the name and refuses traversal', () => {
  assert.deepEqual(splitQuery(''), { prefix: '', typed: '' });
  assert.deepEqual(splitQuery('dat'), { prefix: '', typed: 'dat' });
  assert.deepEqual(splitQuery('data/sub/fi'), { prefix: 'data/sub/', typed: 'fi' });
  assert.deepEqual(splitQuery('./data/'), { prefix: 'data/', typed: '' });
  for (const bad of ['../x', 'a/../b', '/etc/', 'a\0b']) assert.equal(splitQuery(bad), undefined);
});

test('rankEntries orders folders first, hides dotfiles unless asked, and skips unrepresentable names', () => {
  const entries = [{ name: 'b.txt', kind: 'file' }, { name: 'data', kind: 'directory' }, { name: '.git', kind: 'directory' },
    { name: 'a "quoted".txt', kind: 'file' }, { name: 'Data2.csv', kind: 'file' }, { name: 'file10', kind: 'file' }, { name: 'file2', kind: 'file' }];
  assert.deepEqual(rankEntries(entries, '', '').map(row => row.path), ['data', 'b.txt', 'Data2.csv', 'file2', 'file10']);
  assert.deepEqual(rankEntries(entries, 'x/', 'da').map(row => `${row.path}:${row.kind}`), ['x/data:directory', 'x/Data2.csv:file']);
  assert.deepEqual(rankEntries(entries, '', '.g').map(row => row.path), ['.git']);
  assert.deepEqual(rankEntries(entries, '', 'zzz'), []);
});

async function remoteFixture() {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'dsh-refs-'))), bin = join(sandbox, 'bin'), remote = join(sandbox, 'remote');
  await mkdir(bin); await mkdir(join(remote, 'data/deep'), { recursive: true });
  await writeFile(join(remote, 'readme.md'), 'x'); await writeFile(join(remote, 'data/a b.csv'), 'x'); await writeFile(join(remote, '.hidden'), 'x');
  await mkdir(join(sandbox, 'outside')); await symlink(join(sandbox, 'outside'), join(remote, 'escape'));
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do if [ "$1" = -o ]; then shift 2; else shift; fi; done\nshift\nexec sh -c "$*"\n');
  await chmod(join(bin, 'ssh'), 0o755);
  const anchors = join(sandbox, 'anchors.json'), anchor = join(sandbox, 'anchor');
  await writeFile(anchors, JSON.stringify([{ anchorPath: anchor, alias: 'fake', remotePath: remote, uri: `ssh://fake${remote}` }]));
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  return { anchor, find: cwd => locate(cwd, anchors), done: async () => { process.env.PATH = previous; await rm(sandbox, { recursive: true }); } };
}

const agentAt = cwd => ({ session: { header: { cwd } } });

test('ops.list reads one remote directory without leaving the workspace', async () => {
  const { anchor, find, done } = await remoteFixture();
  try {
    const ops = createFileOps(), where = await find(anchor);
    const names = async dir => (await ops.list(where, dir)).map(entry => `${entry.kind[0]}:${entry.name}`).sort();
    assert.deepEqual(await names(anchor), ['d:data', 'd:escape', 'f:.hidden', 'f:readme.md']);
    assert.deepEqual(await names(`${anchor}/data`), ['d:deep', 'f:a b.csv']);
    await assert.rejects(ops.list(where, `${anchor}/escape`), error => error.status === 403);
    await assert.rejects(ops.list(where, `${anchor}/nope`), error => error.status === 404);
  } finally { await done(); }
});

test('rankPaths matches names and deep path fragments without hidden folders', () => {
  const entries = [
    { path: 'picture/bias_three_model.pdf', kind: 'file' },
    { path: 'picture/bias_three_model.png', kind: 'file' },
    { path: 'data/other.csv', kind: 'file' },
    { path: 'picture', kind: 'directory' },
    { path: '.secret/bias.txt', kind: 'file' },
  ];
  assert.deepEqual(rankPaths(entries, 'bias').map(row => row.path), ['picture/bias_three_model.pdf', 'picture/bias_three_model.png']);
  assert.deepEqual(rankPaths(entries, 'bias_three_model.png').map(row => row.path), ['picture/bias_three_model.png']);
  assert.deepEqual(rankPaths(entries, '.sec').map(row => row.path), ['.secret/bias.txt']);
  assert.deepEqual(rankPaths(entries, 'nope'), []);
});

test('remote @ answers from one cached live directory and never waits for the slow global index', async () => {
  const calls = [];
  let inner = 0;
  const service = { async list() { inner++; throw new Error('the slow remote index must not be on the critical path'); } };
  const where = { kind: 'ssh', anchorRoot: '/anchor', root: '/remote' };
  const listDirectory = async (_where, relative) => {
    calls.push(relative);
    if (relative === '') return [{ name: 'data', kind: 'directory' }, { name: 'readme.md', kind: 'file' }, { name: 'picture', kind: 'directory' }];
    if (relative === 'data') return [{ name: 'a b.csv', kind: 'file' }, { name: 'deep', kind: 'directory' }];
    if (relative === 'data/deep') return [{ name: 'bias_three_model.pdf', kind: 'file' }];
    return [];
  };
  const restore = installQuickReferences(service, { find: async () => where, ops: { list: async () => { throw new Error('ops should not run'); } }, listDirectory });
  const ask = query => service.list(agentAt('/anchor'), query, new AbortController().signal);
  assert.deepEqual((await ask('')).map(row => row.path), ['data', 'picture', 'readme.md']);
  assert.deepEqual((await ask('')).map(row => row.path), ['data', 'picture', 'readme.md']);
  assert.equal(calls.filter(relative => relative === '').length, 1, 'the second query is served from the directory cache');
  assert.deepEqual((await ask('data/')).map(row => row.path), ['data/deep', 'data/a b.csv']);
  assert.deepEqual((await ask('rea')).map(row => row.path), ['readme.md']);
  assert.equal(inner, 0, 'the legacy SSH index is never called');
  await delay(80);
  const status = restore.status(where);
  assert.equal(status.kind, 'ssh');
  assert.ok(['building', 'ready'].includes(status.state));
  assert.deepEqual(await ask('zzz'), []);

  // Wait for the background index, then a bare name reaches a deeper file.
  for (let i = 0; i < 40 && restore.status(where).state !== 'ready'; i++) await delay(10);
  assert.equal(restore.status(where).state, 'ready');
  assert.deepEqual((await ask('bias')).map(row => row.path), ['data/deep/bias_three_model.pdf']);
  restore();
  assert.equal(typeof service.list, 'function');
});

test('SSH uses the filesystem service when available and local workspaces keep the host implementation', async () => {
  const where = { kind: 'ssh', anchorRoot: '/anchor', root: '/remote' };
  const resolved = [], listed = [];
  const fs = {
    async resolve(path, options) { resolved.push([path, options.cwd]); return { targetKey: 'ssh://host/remote/' + path }; },
    async listDir(target) { listed.push(target.targetKey); return target.targetKey.endsWith('/data') ? [] : [{ name: 'data', type: 'directory' }, { name: 'readme.md', type: 'file' }]; },
  };
  const service = { async list() { return [{ path: 'from-index.txt', kind: 'file' }]; } };
  const restore = installQuickReferences(service, { find: async cwd => cwd === '/anchor' ? where : { kind: 'local', root: cwd }, ops: { list: async () => [] }, fs });
  assert.deepEqual((await service.list(agentAt('/anchor'), '', new AbortController().signal)).map(row => row.path), ['data', 'readme.md']);
  assert.deepEqual(resolved.filter(([path]) => path === '.'), [['.', '/anchor']]);
  assert.equal(listed.filter(key => key.endsWith('/remote/.')).length, 1);
  assert.deepEqual(restore.status(where).kind, 'ssh');

  let outerCalls = 0;
  service.list = async function () { outerCalls++; return [{ path: 'outer.txt', kind: 'file' }]; };
  assert.equal(outerCalls, 0, 'SSH completion does not defer to the outer slow index');

  // Local workspaces stay on the host's own implementation.
  assert.deepEqual((await service.list(agentAt('/Users/someone/project'), '', new AbortController().signal)).map(row => row.path), ['outer.txt']);
  restore();
});

test('quick references fall back to the SSH file operations adapter when no host filesystem is injected', async () => {
  const { anchor, find, done } = await remoteFixture();
  try {
    const ops = createFileOps();
    let inner = 0;
    const service = { async list() { inner++; throw new Error('not used'); } };
    const restore = installQuickReferences(service, { find, ops });
    const ask = query => service.list(agentAt(anchor), query, new AbortController().signal);
    assert.deepEqual((await ask('')).map(row => row.path), ['data', 'escape', 'readme.md']);
    assert.deepEqual((await ask('data/')).map(row => row.path), ['data/deep', 'data/a b.csv']);
    assert.equal(inner, 0);
    restore();
  } finally { await done(); }
});

test('remote @ falls back to the native workspaceFiles seam when the fs provider rejects the path', async () => {
  const where = { kind: 'ssh', anchorRoot: '/anchor', root: '/remote' };
  const listed = [];
  const service = { async list() { return []; } };
  const workspaceFiles = { async list(scope, path) { listed.push([scope.sessionId, path]); return { entries: [{ name: 'data', type: 'directory' }, { name: 'report.pdf', type: 'file' }] }; } };
  const restore = installQuickReferences(service, {
    find: async () => where, ops: { list: async () => [] }, fs: { async resolve() { throw new Error('no fs route'); } }, workspaceFiles,
  });
  const rows = await service.list(agentAt('/anchor'), '', new AbortController().signal);
  assert.deepEqual(rows.map(row => row.path), ['data', 'report.pdf']);
  assert.deepEqual(listed[0], [undefined, '']);
  restore();
});
