// 「库」核心逻辑：目录树 / 文件预览 / 上传入库（git + COS 双路由）。
// 路由规则与 dreamcity_workspace/scripts/upload.py 完全一致。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {loadCosConfig, cosKeyFor, putBuffer} from './cos.mjs';

const execFileP = promisify(execFile);
const fail = (status, message) => Object.assign(new Error(message), {status});

const env = process.env;
const WS = env.WORKSPACE_DIR || '/workspace';
const GIT_KEY = env.GIT_SSH_KEY || '/keys/id_ed25519';
const GIT_MAX = Number(env.UPLOAD_GIT_MAX_MB || 50) * 1024 * 1024;
const TOTAL_MAX = Number(env.UPLOAD_TOTAL_MAX_MB || 300) * 1024 * 1024;
const COMPANY_EMAIL = '13316596505@163.com';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']);
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.psd', '.ai', '.sketch', '.fig', '.zip']);
const DOC_EXT = new Set(['.md', '.markdown', '.txt']);
const PREVIEW_TEXT = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.csv']);
const PREVIEW_IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const ROOTS = ['projects', 'knowledge', 'workflows', 'media'];
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'};

const day = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const sanitize = name => String(name).replace(/[<>:\"/\\|?*\u0000-\u001f]+/g, '_').trim().slice(0, 120) || '未命名';

// ---------- 花名册：企微姓名 → 署名身份 ----------
async function loadRoster() {
  try {
    const text = await fsp.readFile(path.join(WS, '_meta', 'roster.md'), 'utf8');
    const members = [];
    for (const line of text.split('\n')) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.length < 6 || cells[0] === 'id' || cells[0].startsWith('-') || cells[0].includes('<')) continue;
      members.push({id: cells[0], name: cells[1], email: cells[2], role: cells[4]});
    }
    return members;
  } catch { return []; }
}
async function resolveAuthor(userName) {
  const hit = (await loadRoster()).find(m => m.name === userName);
  return hit || {id: userName, name: userName, email: COMPANY_EMAIL};
}

// ---------- git 操作（串行队列 + 只写环境变量配置，适配只读容器） ----------
let queue = Promise.resolve();
const enqueue = job => { const r = queue.then(job); queue = r.catch(() => {}); return r; };

const GIT_ENV = {
  ...process.env,
  GIT_SSH_COMMAND: `ssh -i ${GIT_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(WS, '.git', 'deploy_known_hosts')}`,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: WS,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
async function git(...args) {
  const full = ['-c', 'user.name=梦之城工作台', '-c', `user.email=${COMPANY_EMAIL}`, ...args];
  const {stdout} = await execFileP('git', full, {cwd: WS, env: GIT_ENV, timeout: 120000, maxBuffer: 16 * 1024 * 1024});
  return stdout;
}
let lastPull = 0;
async function gitPull() {
  try { await git('rebase', '--abort'); } catch { /* 没有进行中的 rebase */ }
  await git('pull', '--rebase', 'origin', 'main');
  lastPull = Date.now();
}
export function refreshSoon() { // tree 请求触发后台同步（60s 节流）
  if (Date.now() - lastPull > 60000) enqueue(gitPull).catch(e => console.error('git pull failed:', e.message));
}
async function gitRecover() { // 上次任务中断留下脏树时，先兜底提交并推送（.gitignore 已拦 _inbox/_pending/密钥）
  const dirty = (await git('status', '--porcelain')).trim();
  if (!dirty) return;
  console.error('workspace 有未提交残留，兜底提交后同步');
  await git('add', '-A');
  await git('commit', '-m', 'chore: 恢复中断的上传残留');
  await git('push', 'origin', 'main');
}
/** 写文件前调用：先处理残留、再同步远端（顺序很重要，否则本次上传会被卷进兜底提交） */
async function syncBeforeWrite() {
  return enqueue(async () => {
    await gitRecover();
    await gitPull();
  });
}
async function gitCommitPush(message, author, paths) {
  return enqueue(async () => {
    await git('add', '-A', '--', ...paths);
    let changed = true;
    try { await git('diff', '--cached', '--quiet'); changed = false; } catch { /* 有暂存变化 */ }
    if (changed) await git('commit', '--author', `${author.name} <${author.email}>`, '-m', message);
    const ahead = Number((await git('rev-list', '--count', 'origin/main..HEAD')).trim());
    if (ahead > 0) { // 本地领先远端就推（含本次提交与历史残留提交）
      try { await git('push', 'origin', 'main'); }
      catch { await gitPull(); await git('push', 'origin', 'main'); }
    }
    return changed;
  });
}

// ---------- manifest（append-only 文本，宽松解析） ----------
const MANIFEST = path.join(WS, 'media', 'manifest.yaml');
function parseManifest(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = /^- (name|path):\s*(.+)$/.exec(line);
    if (head) { cur = head[1] === 'name' ? {name: head[2].trim()} : {path: head[2].trim()}; entries.push(cur); continue; }
    const kv = /^\s{2,}(\w+):\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]] = kv[2].trim();
  }
  return entries;
}
async function readManifest() {
  try { return parseManifest(await fsp.readFile(MANIFEST, 'utf8')); } catch { return []; }
}

// ---------- 路径安全 ----------
function safeJoin(rel) {
  const target = path.resolve(WS, rel);
  if (target !== WS && !target.startsWith(WS + path.sep)) throw fail(400, '路径无效。');
  return target;
}
function checkRel(rel) {
  if (!rel || rel.length > 300 || rel.includes('..') || rel.includes('\\')) throw fail(400, '路径无效。');
  const first = rel.split('/')[0];
  if (!ROOTS.includes(first)) throw fail(400, '只允许库内分区目录。');
  return rel;
}

// ---------- multipart 解析（手写，带总上限） ----------
export function parseMultipart(buf, boundary) {
  const mark = Buffer.from('--' + boundary);
  const parts = [];
  let pos = buf.indexOf(mark);
  while (pos !== -1) {
    let p = pos + mark.length;
    if (buf[p] === 45 && buf[p + 1] === 45) break; // 结束边界 '--'
    if (buf[p] === 13 && buf[p + 1] === 10) p += 2;
    const headEnd = buf.indexOf('\r\n\r\n', p);
    if (headEnd === -1) break;
    const head = buf.toString('latin1', p, headEnd);
    const next = buf.indexOf(mark, headEnd + 4);
    if (next === -1) break;
    const data = buf.subarray(headEnd + 4, next - 2); // 去掉边界前的 CRLF
    const name = /name="([^"]*)"/.exec(head)?.[1] || '';
    const rawFile = /filename="([^"]*)"/.exec(head)?.[1];
    // 浏览器以 UTF-8 发文件名；latin1 读入后转回
    const filename = rawFile !== undefined ? Buffer.from(rawFile, 'latin1').toString('utf8') : undefined;
    parts.push({name, filename, data});
    pos = next;
  }
  return parts;
}

// ---------- 目录树 ----------
async function walk(dir, rel, depth, out, budget) {
  if (depth > 6 || budget.n <= 0) return;
  let items;
  try { items = await fsp.readdir(dir, {withFileTypes: true}); } catch { return; }
  for (const it of items) {
    if (budget.n-- <= 0) return;
    if (it.name.startsWith('.') || it.name.startsWith('_')) continue;
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) {
      out.push({path: r, name: it.name, type: 'dir'});
      await walk(path.join(dir, it.name), r, depth + 1, out, budget);
    } else if (it.isFile()) {
      try {
        const st = await fsp.stat(path.join(dir, it.name));
        out.push({path: r, name: it.name, type: 'file', size: st.size, mtime: st.mtime.toISOString().slice(0, 10)});
      } catch { /* 忽略读不到的文件 */ }
    }
  }
}
async function tree() {
  const out = [];
  const budget = {n: 5000};
  for (const root of ROOTS) {
    out.push({path: root, name: root, type: 'dir', root: true}); // 分区本身也作为条目，前端才能画出目录树
    await walk(path.join(WS, root), root, 1, out, budget);
  }
  const manifest = await readManifest();
  const cos = manifest.filter(e => e.name && e.cos);
  const meta = {};
  for (const e of manifest) if (e.path) meta[e.path] = {author: e.author || '', date: e.date || ''};
  const files = out.filter(e => e.type === 'file');
  const roster = {};
  for (const m of await loadRoster()) roster[m.id] = m.name; // 让前端把 author id 显示成中文名
  return {
    entries: out, cos, meta, roots: ROOTS, roster,
    stats: {
      files: files.length,
      dirs: out.length - files.length,
      bytes: files.reduce((s, f) => s + (f.size || 0), 0),
      cloud: cos.length,
      updated: files.map(f => f.mtime).sort().pop() || '',
    },
  };
}

// ---------- 文件预览 ----------
async function preview(rel) {
  checkRel(rel);
  const ext = path.extname(rel).toLowerCase();
  if (!PREVIEW_TEXT.has(ext) && !PREVIEW_IMG.has(ext)) throw fail(400, '该类型暂不支持预览。');
  const target = safeJoin(rel);
  const st = await fsp.stat(target).catch(() => { throw fail(404, '文件不存在。'); });
  if (!st.isFile() || st.size > 20 * 1024 * 1024) throw fail(400, '文件过大或不可读。');
  const buf = await fsp.readFile(target);
  const type = PREVIEW_IMG.has(ext) ? (MIME[ext] || 'application/octet-stream') : 'text/plain; charset=utf-8';
  return {buf, type, ext};
}

// ---------- 上传 ----------
async function ensureFrontmatter(target, author) {
  const ext = path.extname(target).toLowerCase();
  if (!DOC_EXT.has(ext)) return;
  const text = await fsp.readFile(target, 'utf8').catch(() => '');
  if (text.startsWith('---')) return;
  const stem = path.basename(target, ext);
  await fsp.writeFile(target, `---\ntitle: ${stem}\nauthor: ${author.id}\ndate: ${day()}\n---\n\n${text}`, 'utf8');
}

async function upload(req, user) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > TOTAL_MAX) throw fail(413, `单次上传总量不能超过 ${Math.round(TOTAL_MAX / 1048576)}MB。`);
    chunks.push(c);
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] || '');
  if (!m) throw fail(400, '请求格式错误。');
  const parts = parseMultipart(Buffer.concat(chunks), (m[1] || m[2]).trim());
  const fields = {};
  const files = [];
  for (const p of parts) {
    if (p.filename !== undefined) { if (p.filename) files.push(p); }
    else if (p.name) fields[p.name] = p.data.toString('utf8').slice(0, 500);
  }
  if (!files.length) throw fail(400, '没有选择文件。');
  if (files.length > 20) throw fail(400, '一次最多上传 20 个文件。');

  const author = await resolveAuthor(user.name);
  await syncBeforeWrite();          // 先把远端同步与残留清理做完，再落本地文件
  const cfg = loadCosConfig();
  let targetRel = (fields.path || 'knowledge').replace(/^\/+|\/+$/g, '');
  checkRel(targetRel);
  const targetDir = safeJoin(targetRel);
  await fsp.mkdir(targetDir, {recursive: true});

  const results = [], touched = new Set(), manifestLines = [];
  for (const f of files) {
    const name = sanitize(f.filename);
    const ext = path.extname(name).toLowerCase();
    if (VIDEO_EXT.has(ext) || f.data.length > GIT_MAX) {
      // COS 路由
      if (!cfg) throw fail(503, '云端存储未配置，请联系管理员。');
      const subdir = VIDEO_EXT.has(ext) ? 'videos' : 'assets';
      const key = cosKeyFor(cfg, name, subdir);
      const r = await putBuffer(cfg, key, f.data);
      manifestLines.push(`- name: ${name}\n  author: ${author.id}\n  date: ${day()}\n  size_mb: ${(f.data.length / 1048576).toFixed(1)}\n  status: stored\n  cos: ${r.url}\n`);
      results.push({name, route: 'cos', url: r.url});
    } else {
      // git 路由（重名加日期后缀，再重加序号）
      let dest = path.join(targetDir, name);
      let stem = path.basename(name, ext), n = 0;
      while (true) {
        try { await fsp.access(dest); n += 1; dest = path.join(targetDir, n === 1 ? `${stem}-${day()}${ext}` : `${stem}-${day()}-${n}${ext}`); }
        catch { break; }
      }
      await fsp.writeFile(dest, f.data);
      await ensureFrontmatter(dest, author);
      const rel = path.relative(WS, dest).split(path.sep).join('/');
      touched.add(rel);
      if (MEDIA_EXT.has(ext)) manifestLines.push(`- path: ${rel}\n  author: ${author.id}\n  date: ${day()}\n`);
      results.push({name: path.basename(dest), route: 'git', path: rel});
    }
  }

  if (manifestLines.length) {
    await fsp.appendFile(MANIFEST, manifestLines.join(''));
    touched.add('media/manifest.yaml');
  }

  let committed = false;
  if (touched.size) {
    const names = results.filter(r => r.route === 'git').map(r => r.name).slice(0, 5).join('、') || '大文件登记';
    const msg = `upload: ${author.id} 上传 ${names}${results.length > 5 ? ' 等' : ''}`;
    committed = await gitCommitPush(msg, author, [...touched]);
  }
  return {results, committed, author: author.name};
}

// ---------- 入口 ----------
export async function handleLibrary({path: p, method, req, res, respond, user, raw}) {
  if (p === '/api/library/tree' && method === 'GET') { refreshSoon(); respond(res, 200, await tree()); return true; }
  if (p === '/api/library/file' && method === 'GET') {
    const rel = new URL(req.url, 'http://x').searchParams.get('path') || '';
    const {buf, type, ext} = await preview(rel);
    res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(ext === '.svg' ? {'Content-Security-Policy': "script-src 'none'"} : {})});
    res.end(buf);
    return true;
  }
  if (p === '/api/upload' && method === 'POST') {
    respond(res, 200, await upload(req, user));
    return true;
  }
  return false;
}
