// Host-side file operations for the native file tree: download, upload, rename,
// delete and mkdir. Local workspaces use node:fs; SSH workspaces (identified
// through dsh-ssh-remote's anchor registry) run short POSIX scripts over the
// system OpenSSH client, so no host internals are touched.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export class FileOpError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

const NAME_LIMIT = 255;

/** One path component: never empty, `.`/`..`, a separator or a control character. */
export function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/u.test(name)
    || Buffer.byteLength(name) > NAME_LIMIT) throw new FileOpError('名称无效：不能为空，不能包含 / \\ 或控制字符。', 400);
  return name;
}

/** Relative upload path such as `dir/sub/file.txt`, each segment validated. */
export function checkRelative(path) {
  if (typeof path !== 'string' || !path || path.length > 4096) throw new FileOpError('路径无效。', 400);
  return path.split('/').map(checkName);
}

/** Lexically confine `path` to `root`; returns the non-empty-or-empty segment list below it. */
export function confine(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new FileOpError('路径无效。', 400);
  const absolute = resolve(root, path), below = relative(root, absolute);
  if (below === '..' || below.startsWith(`..${sep}`) || resolve(below) === below) throw new FileOpError('路径不在当前工作区内。', 403);
  return below ? below.split(sep) : [];
}

export const shq = value => `'${String(value).replaceAll("'", `'\\''`)}'`;

export function dshHome(env = process.env) { return env.DSH_HOME || join(homedir(), '.dsh'); }

/** Map a session workspace root to a local directory or an SSH host + remote path. */
export async function locate(workspaceRoot, anchorFile = join(dshHome(), 'ssh-workspace-anchors.json')) {
  let anchors = [];
  try { anchors = JSON.parse(await readFile(anchorFile, 'utf8')); } catch { /* no SSH workspaces */ }
  const root = resolve(workspaceRoot);
  const match = (Array.isArray(anchors) ? anchors : [])
    .filter(anchor => typeof anchor?.anchorPath === 'string' && typeof anchor.alias === 'string' && typeof anchor.remotePath === 'string'
      && (root === anchor.anchorPath || root.startsWith(`${anchor.anchorPath}${sep}`)))
    .sort((a, b) => b.anchorPath.length - a.anchorPath.length)[0];
  if (!match) return { kind: 'local', root };
  const rest = relative(match.anchorPath, root).split(sep).filter(Boolean);
  return { kind: 'ssh', alias: match.alias, anchorRoot: root, root: posix.join(match.remotePath, ...rest) };
}

const SSH_ERRORS = new Map([
  [21, ['工作区目录不存在或无法访问。', 404]], [22, ['目标目录不存在。', 404]], [23, ['路径不在当前工作区内。', 403]],
  [24, ['目标是指向工作区外的符号链接。', 403]], [25, ['目标不存在。', 404]], [26, ['目标不是文件或文件夹。', 409]],
  [30, ['同名文件或文件夹已存在。', 409]], [31, ['不能操作工作区根目录。', 403]],
]);

function sshFailure(code, stderr) {
  const known = SSH_ERRORS.get(code);
  if (known) return new FileOpError(known[0], known[1]);
  const detail = String(stderr).trim().split('\n').at(-1) || `退出码 ${code}`;
  return new FileOpError(code === 255 ? `SSH 连接失败：${detail}` : `远程命令失败：${detail}`, code === 255 ? 502 : 500);
}

// `$1` workspace root, `$2` directory that must stay inside it. `cd -P` resolves symlinks.
const PRELUDE = 'R=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 21\nP=$(cd -P -- "$2" 2>/dev/null && pwd -P) || exit 22\n'
  + 'case "$P" in "$R"|"$R"/*) ;; *) exit 23;; esac\n';
// Reject a symlink whose real target leaves the workspace (best effort where readlink -f exists).
const LINK_GUARD = 'if [ -L "$F" ]; then T=$(readlink -f -- "$F" 2>/dev/null || true); '
  + 'if [ -n "$T" ]; then case "$T" in "$R"|"$R"/*) ;; *) exit 24;; esac; fi; fi\n';

const SCRIPTS = {
  info: `${PRELUDE}F="$P/$3"\n${LINK_GUARD}if [ -d "$F" ]; then echo d; elif [ -f "$F" ]; then echo "f $(wc -c < "$F" | tr -d ' ')"; elif [ -e "$F" ]; then exit 26; else exit 25; fi`,
  // Directory entries as NUL-separated `d<name>` / `f<name>`, capped so a huge folder cannot stall the menu.
  list: `${PRELUDE}n=0\nfor f in "$P"/* "$P"/.[!.]* "$P"/..?*; do\n  [ -e "$f" ] || [ -L "$f" ] || continue\n`
    + `  if [ -d "$f" ]; then printf 'd%s\\0' "\${f##*/}"; else printf 'f%s\\0' "\${f##*/}"; fi\n  n=$((n+1)); [ "$n" -lt 5000 ] || break\ndone`,
  file: `${PRELUDE}F="$P/$3"\n${LINK_GUARD}[ -f "$F" ] || exit 25\nexec cat -- "$F"`,
  folder: `${PRELUDE}F="$P/$3"\n${LINK_GUARD}[ -d "$F" ] || exit 25\ncd -- "$P" && exec tar -cf - -- "$3"`,
  mkdir: `${PRELUDE}[ ! -e "$P/$3" ] && [ ! -L "$P/$3" ] || exit 30\nmkdir -- "$P/$3"`,
  rename: `${PRELUDE}F="$P/$3"\n[ -e "$F" ] || [ -L "$F" ] || exit 25\n[ ! -e "$P/$4" ] && [ ! -L "$P/$4" ] || exit 30\nmv -- "$F" "$P/$4"`,
  remove: `${PRELUDE}F="$P/$3"\n[ "$P/$3" != "$R" ] || exit 31\n[ -e "$F" ] || [ -L "$F" ] || exit 25\nexec rm -rf -- "$F"`,
  // $3 sub-directories to create (may be empty), $4 file name, $5 replace flag. The temp file is removed on any failure.
  upload: `${PRELUDE}D="$P"\nif [ -n "$3" ]; then mkdir -p -- "$P/$3" || exit 22; D=$(cd -P -- "$P/$3" && pwd -P) || exit 22\n`
    + 'case "$D" in "$R"|"$R"/*) ;; *) exit 23;; esac; fi\n'
    + 'T="$D/.$4.dsh-upload.$$"\ntrap \'rm -f -- "$T"\' EXIT HUP INT TERM\ncat > "$T" || exit 1\n'
    + 'if [ "$5" = 1 ]; then mv -f -- "$T" "$D/$4"\n'
    + 'elif ln -- "$T" "$D/$4" 2>/dev/null; then :\n'
    + 'elif [ -e "$D/$4" ] || [ -L "$D/$4" ]; then exit 30\n'
    + 'else mv -n -- "$T" "$D/$4"; fi',
};

// One master connection per host is reused for 2 minutes, so a batch of small
// files pays the SSH handshake once instead of once per file. Falls back to a
// plain connection when the socket directory cannot be created.
let controlOptions;
export function sshOptions(env = process.env) {
  if (controlOptions) return controlOptions;
  const base = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  const directory = env.DSH_SSH_CONTROL_DIR || join(homedir(), '.ssh', 'dsh-three-pane');
  try {
    // %C is a 40-character hash; unix socket paths are limited to about 104 bytes.
    if (directory.length + 41 > 100) throw new Error('control path too long');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    controlOptions = [...base, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', `ControlPath=${directory}/%C`];
  } catch { controlOptions = base; }
  return controlOptions;
}

function runSsh(target, script, args, { stdin, signal } = {}) {
  const command = `sh -c ${shq(script)} sh ${[target.root, ...args].map(shq).join(' ')}`;
  const child = spawn('ssh', [...sshOptions(), target.alias, command], { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', error => reject(error.name === 'AbortError' ? error : new FileOpError(`无法启动 ssh：${error.message}`, 500)));
    child.once('close', code => resolveDone({ code, stderr }));
  });
  return { child, done };
}

async function sshCollect(target, op, args, { raw = false } = {}) {
  const { child, done } = runSsh(target, SCRIPTS[op], args);
  let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  const { code, stderr } = await done;
  if (code !== 0) throw sshFailure(code, stderr);
  return raw ? stdout : stdout.trim();
}

function sshStream(target, op, args, signal) {
  const { child, done } = runSsh(target, SCRIPTS[op], args, { signal });
  const failure = done.then(({ code, stderr }) => code === 0 ? undefined : sshFailure(code, stderr), error => error);
  return { stream: child.stdout, failure };
}

async function localInside(root, path, { follow }) {
  const realRoot = await realpath(root).catch(() => { throw new FileOpError('工作区目录不存在或无法访问。', 404); });
  const probe = follow ? path : dirname(path);
  const real = await realpath(probe).catch(() => { throw new FileOpError('目标不存在。', 404); });
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) throw new FileOpError('路径不在当前工作区内。', 403);
}

const exists = path => lstat(path).then(() => true, () => false);

const FS_DOWNLOAD_LIMIT = 32 * 1024 * 1024;

/** Create the file-operation API over one resolved workspace. `where` comes from {@link locate}. */
export function createFileOps({ fs } = {}) {
  const hostFs = () => typeof fs === 'function' ? fs() : fs;
  const remoteTarget = async (where, path, signal) => {
    // Resolve below the workspace first, then hand the canonical remote path to
    // the filesystem. This accepts a workspace-relative path, the remote
    // absolute path a presented card records, and the anchor+remote hybrid a
    // host path helper can produce.
    const absolute = posix.join(where.root, ...resolveBelow(where, path));
    const target = await hostFs().resolve(absolute, { cwd: where.anchorRoot, signal });
    const resolved = typeof hostFs().processPath === 'function' ? hostFs().processPath(target) : undefined;
    const root = where.root.replace(/\/+$/, '');
    if (typeof resolved !== 'string' || (resolved !== root && !resolved.startsWith(`${root}/`))) throw new FileOpError('路径不在当前工作区内。', 403);
    return target;
  };
  const remoteStat = async (where, path, signal) => {
    const { name } = remoteParts(where, path);
    if (!name) throw new FileOpError('请选择要下载的文件或文件夹。', 400);
    const target = await remoteTarget(where, path, signal);
    const info = await hostFs().stat(target, signal);
    if (!info) throw new FileOpError('目标不存在。', 404);
    if (info.type !== 'file' && info.type !== 'directory') throw new FileOpError('只能下载文件或文件夹。', 409);
    return { name: info.type === 'directory' ? `${name}.tar` : name, directory: info.type === 'directory', size: info.type === 'file' ? info.size : undefined, target };
  };
  const resolveBelow = (where, path) => {
    const base = where.kind === 'ssh' ? where.anchorRoot : where.root;
    if (where.kind === 'ssh' && typeof path === 'string' && path.startsWith('/')) {
      const remoteRoot = posix.normalize(where.root);
      const root = remoteRoot === '/' ? '/' : remoteRoot.replace(/\/+$/, '');
      const absolute = posix.normalize(path);
      if (root === '/') return absolute.slice(1).split('/').filter(Boolean);
      if (absolute === root) return [];
      if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1).split('/').filter(Boolean);
      // A presented card can concatenate the local anchor and a remote absolute
      // path; strip both so the very same download works from the card.
      const anchor = base.replace(/\/+$/, '');
      const prefix = `${anchor}${root}/`;
      if (absolute.startsWith(prefix)) return absolute.slice(prefix.length).split('/').filter(Boolean);
    }
    return confine(base, path);
  };
  const remoteParts = (where, path) => {
    const parts = resolveBelow(where, path);
    return { parts, name: parts.at(-1), parent: posix.join(where.root, ...parts.slice(0, -1)) };
  };
  const localPath = (where, path) => { const parts = resolveBelow(where, path); return { parts, full: join(where.root, ...parts) }; };

  const remoteInfo = async (where, path) => {
    const { name, parent } = remoteParts(where, path);
    if (!name) throw new FileOpError('请选择要下载的文件或文件夹。', 400);
    const [kind, size] = (await sshCollect(where, 'info', [parent, name])).split(' ');
    return { name, parent, directory: kind === 'd', size: kind === 'f' ? Number(size) : undefined };
  };

  return {
    /** Name, kind and size of what a download would deliver; cheap enough to run before every download. */
    async stat(where, path) {
      if (where.kind === 'ssh') {
        if (hostFs()) {
          const info = await remoteStat(where, path);
          return { name: info.name, directory: info.directory, size: info.size };
        }
        const { name, directory, size } = await remoteInfo(where, path);
        return { name: directory ? `${name}.tar` : name, directory, size };
      }
      const { parts, full } = localPath(where, path);
      await localInside(where.root, full, { follow: true });
      const info = await stat(full), name = parts.at(-1) ?? basename(where.root);
      if (!info.isFile() && !info.isDirectory()) throw new FileOpError('只能下载文件或文件夹。', 409);
      return { name: info.isDirectory() ? `${name}.tar` : name, directory: info.isDirectory(), size: info.isFile() ? info.size : undefined };
    },

    /** Immediate children of a directory (hidden ones included), unsorted: used for fast `@` completion. */
    async list(where, dir) {
      if (where.kind === 'ssh') {
        const parent = posix.join(where.root, ...resolveBelow(where, dir || '.'));
        const output = await sshCollect(where, 'list', [parent, '.'], { raw: true });
        return output.split('\0').filter(entry => entry.length > 1).map(entry => ({ kind: entry[0] === 'd' ? 'directory' : 'file', name: entry.slice(1) }));
      }
      const { full } = localPath(where, dir || '.');
      await localInside(where.root, join(full, 'x'), { follow: false });
      return (await readdir(full, { withFileTypes: true })).slice(0, 5000)
        .map(entry => ({ kind: entry.isDirectory() ? 'directory' : 'file', name: entry.name }));
    },

    /** Stream a file, or a folder as a tar archive. */
    async download(where, path, signal) {
      if (where.kind === 'ssh') {
        if (hostFs()) {
          const info = await remoteStat(where, path, signal);
          if (!info.directory && (info.size === undefined || info.size <= FS_DOWNLOAD_LIMIT)) {
            try {
              const bytes = await hostFs().readBytes(info.target, signal, FS_DOWNLOAD_LIMIT);
              return { name: info.name, directory: false, size: bytes.length, bytes: Buffer.from(bytes), failure: Promise.resolve() };
            } catch (error) {
              if (error?.code !== 'FS_TOO_LARGE') throw error;
            }
          }
        }
        const { name, parent, directory, size } = await remoteInfo(where, path);
        const { stream, failure } = sshStream(where, directory ? 'folder' : 'file', [parent, name], signal);
        return { name: directory ? `${name}.tar` : name, directory, size, stream, failure };
      }
      const { parts, full } = localPath(where, path);
      await localInside(where.root, full, { follow: true });
      const info = await stat(full);
      const name = parts.at(-1) ?? basename(where.root);
      if (info.isDirectory()) {
        const child = spawn('tar', ['-cf', '-', '-C', dirname(full), '--', basename(full)], { stdio: ['ignore', 'pipe', 'pipe'], signal });
        let stderr = ''; child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
        const failure = new Promise(done => {
          child.once('error', error => done(error));
          child.once('close', code => done(code === 0 ? undefined : new FileOpError(`打包失败：${stderr.trim()}`, 500)));
        });
        return { name: `${name}.tar`, directory: true, stream: child.stdout, failure };
      }
      if (!info.isFile()) throw new FileOpError('只能下载文件或文件夹。', 409);
      return { name, directory: false, size: info.size, stream: createReadStream(full), failure: Promise.resolve() };
    },

    /** Write a request body to `dir/relative`, creating sub-directories; refuses to overwrite unless `replace`. */
    async upload(where, dir, relativePath, body, { replace = false, signal } = {}) {
      const segments = checkRelative(relativePath), name = segments.at(-1), sub = segments.slice(0, -1);
      if (!body) throw new FileOpError('缺少上传数据。', 400);
      if (where.kind === 'ssh') {
        const parts = resolveBelow(where, dir || '.'), parent = posix.join(where.root, ...parts);
        const { child, done } = runSsh(where, SCRIPTS.upload, [parent, sub.join('/'), name, replace ? '1' : '0'], { stdin: true, signal });
        child.stdin.on('error', () => {});
        const sent = pipeline(Readable.fromWeb(body), child.stdin).catch(error => { child.kill(); throw error; });
        const [{ code, stderr }] = await Promise.all([done, sent.catch(() => {})]);
        if (code !== 0) throw sshFailure(code, stderr);
        return { path: join(where.anchorRoot, ...parts, ...segments) };
      }
      const { full: base } = localPath(where, dir || '.');
      await localInside(where.root, join(base, 'x'), { follow: false });
      const folder = join(base, ...sub);
      await mkdir(folder, { recursive: true });
      await localInside(where.root, join(folder, name), { follow: false });
      const target = join(folder, name), temp = join(folder, `.${name}.dsh-upload.${process.pid}.${Date.now()}`);
      try {
        await pipeline(Readable.fromWeb(body), createWriteStream(temp, { flags: 'wx' }), ...(signal ? [{ signal }] : []));
        if (replace) await rename(temp, target);
        else {
          try { await link(temp, target); } catch (error) {
            if (error.code === 'EEXIST') throw new FileOpError('同名文件或文件夹已存在。', 409);
            if (await exists(target)) throw new FileOpError('同名文件或文件夹已存在。', 409);
            await rename(temp, target);
          }
        }
      } finally { await unlink(temp).catch(() => {}); }
      return { path: target };
    },

    async rename(where, path, newName) {
      checkName(newName);
      if (where.kind === 'ssh') {
        const { name, parent } = remoteParts(where, path);
        if (!name) throw new FileOpError('不能重命名工作区根目录。', 403);
        await sshCollect(where, 'rename', [parent, name, newName]);
        return;
      }
      const { parts, full } = localPath(where, path);
      if (!parts.length) throw new FileOpError('不能重命名工作区根目录。', 403);
      await localInside(where.root, full, { follow: false });
      const target = join(dirname(full), newName);
      if (await exists(target)) throw new FileOpError('同名文件或文件夹已存在。', 409);
      if (!(await exists(full))) throw new FileOpError('目标不存在。', 404);
      await rename(full, target);
    },

    async remove(where, path) {
      if (where.kind === 'ssh') {
        const { name, parent } = remoteParts(where, path);
        if (!name) throw new FileOpError('不能删除工作区根目录。', 403);
        await sshCollect(where, 'remove', [parent, name]);
        return;
      }
      const { parts, full } = localPath(where, path);
      if (!parts.length) throw new FileOpError('不能删除工作区根目录。', 403);
      await localInside(where.root, full, { follow: false });
      if (!(await exists(full))) throw new FileOpError('目标不存在。', 404);
      await rm(full, { recursive: true });
    },

    async mkdir(where, dir, name) {
      checkName(name);
      if (where.kind === 'ssh') {
        const parent = posix.join(where.root, ...resolveBelow(where, dir || '.'));
        await sshCollect(where, 'mkdir', [parent, name]);
        return;
      }
      const { full } = localPath(where, dir || '.');
      await localInside(where.root, join(full, 'x'), { follow: false });
      if (await exists(join(full, name))) throw new FileOpError('同名文件或文件夹已存在。', 409);
      await mkdir(join(full, name));
    },
  };
}
