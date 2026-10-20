// 「库」核心逻辑：目录树 / 文件预览 / 上传入库（git + COS 双路由）。
// 路由规则与 dreamcity_workspace/scripts/upload.py 完全一致。
import {execFile} from 'node:child_process';
import {Readable} from 'node:stream';
import {createReadStream, createWriteStream} from 'node:fs';
import {promisify} from 'node:util';
import {finished} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {loadCosConfig, cosKeyFor, putBuffer, putFile, sign, objectUrl, signedGetUrl, cosKeyFromUrl} from './cos.mjs';
import {createZipWriter, wantsDeflate} from './zip.mjs';

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
const ROOTS = ['projects', 'knowledge', 'workflows', 'media']; // 默认分区：库根始终显示这四项，顺序固定
const HIDDEN_ROOTS = new Set(['scripts', 'node_modules']); // 与库内容无关的基础设施目录，不进库树
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'};

// 云端对象内联预览用的类型表：只有列进 COS_INLINE 的才值得内联，
// 其余（office、压缩包等）保持浏览器的默认下载行为。
const COS_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const COS_INLINE = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.pdf', '.txt', '.md']);

const day = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const sanitize = name => String(name).replace(/[<>:\"/\\|?*\u0000-\u001f]+/g, '_').trim().slice(0, 120) || '未命名';
/**
 * 上传文件名按「相对路径」解析：文件夹上传时前端会把 webkitRelativePath 塞进 filename。
 * 任一段是隐藏/保留项（. 或 _ 开头，.DS_Store / __MACOSX / _草稿 之类）→ 整条跳过，
 * 绝不把内容挪到上一层（否则会出现「内容跑到父目录」这种吓人的静默改名）。
 * @returns {string|null} 消毒后的相对路径；null = 跳过该条目
 */
function safeRelPath(raw, maxDepth = 10) {
  const segs = String(raw).split(/[\\/]+/).map(s => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const bad = s => !s || s === '.' || s === '..' || s.startsWith('.') || s.startsWith('_');
  const out = [];
  for (const s of segs) {
    if (bad(s)) return null;
    const clean = sanitize(s);
    if (bad(clean)) return null; // 消毒后变成空或 _ 开头，同样跳过
    out.push(clean);
  }
  if (out.length > maxDepth) return null; // 层级过深直接拒，不做截断（截断=静默改名）
  return out.join('/');
}

// ---------- 花名册：企微姓名 → 署名身份 ----------
async function loadRoster() {
  try {
    const text = await fsp.readFile(path.join(WS, '_meta', 'roster.md'), 'utf8');
    const members = [];
    for (const line of text.split('\n')) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.length < 6 || cells[0] === 'id' || cells[0].startsWith('-') || cells[0].includes('<')) continue;
      members.push({id: cells[0], name: cells[1], email: cells[2], role: cells[4], label: cells[6] || cells[1]});
    }
    return members;
  } catch { return []; }
}

// ---------- 署名登记（谁上传的）----------
const AUTHORS_FILE = path.join(WS, '_meta', 'authors.md');
const AUTHORS_HEAD = '# 署名登记\n\n> 记录每份文件的署名（谁上传的），由「库」页自动维护。**已署名的文件不可修改署名。**\n\n| 路径 | 标签 | 日期 | 登记人 |\n|---|---|---|---|\n';
async function loadAuthors() {
  const map = {};
  try {
    for (const line of (await fsp.readFile(AUTHORS_FILE, 'utf8')).split('\n')) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (cells.length < 4 || cells[0] === '路径' || cells[0].startsWith('-')) continue;
      const p = cells[0].replace(/`/g, '');
      if (p) map[p] = {tag: cells[1], date: cells[2], by: cells[3]};
    }
  } catch { /* 尚未建立 */ }
  return map;
}
async function writeAuthors(map) {
  const rows = Object.entries(map).sort(([a], [b]) => a.localeCompare(b, 'zh'));
  const body = rows.map(([p, v]) => `| ${p} | ${v.tag} | ${v.date} | ${v.by} |`).join('\n');
  await fsp.writeFile(AUTHORS_FILE, AUTHORS_HEAD + (body ? body + '\n' : ''), 'utf8');
}
async function availableTags() { // 署名下拉选项（花名册顺序）
  return (await loadRoster()).filter(m => m.id).map(m => ({id: m.id, label: m.label}));
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
async function commitPush(message, author, paths) { // 不含队列包装，供已在队列内的复合操作复用
  // 整树暂存：git mv 之后原路径不再存在，用 pathspec 会让 git 直接 fatal。
  // 本服务是 workspace 仓的唯一写入方，写前必过 syncBeforeWrite/gitRecover，工作树本就是干净的。
  await git('add', '-A');
  let changed = true;
  try { await git('diff', '--cached', '--quiet'); changed = false; } catch { /* 有暂存变化 */ }
  if (changed) await git('commit', '--author', `${author.name} <${author.email}>`, '-m', message);
  const ahead = Number((await git('rev-list', '--count', 'origin/main..HEAD')).trim());
  if (ahead > 0) { // 本地领先远端就推（含本次提交与历史残留提交）
    try { await git('push', 'origin', 'main'); }
    catch { await gitPull(); await git('push', 'origin', 'main'); }
  }
  return changed;
}
function gitCommitPush(message, author, paths) { return enqueue(() => commitPush(message, author, paths)); }

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
const exists = async p => { try { await fsp.access(p); return true; } catch { return false; } };
function safeJoin(rel) {
  const target = path.resolve(WS, rel);
  if (target !== WS && !target.startsWith(WS + path.sep)) throw fail(400, '路径无效。');
  return target;
}
// 库根的一级目录不是固定四个分区：任何非隐藏、非保留的同级目录都算。
// 以 . 或 _ 开头的是元数据/临时区（_meta、_inbox、_pending、.git），一律不进库。
const isRootName = n => !!n && !/^[._]/.test(n) && !HIDDEN_ROOTS.has(n);
function checkRel(rel) {
  if (!rel || rel.length > 300 || rel.includes('..') || rel.includes('\\')) throw fail(400, '路径无效。');
  const first = rel.split('/')[0];
  if (!isRootName(first)) throw fail(400, '路径无效：只允许库内目录。');
  return rel;
}
// 库根的可见一级目录：默认四项分区排前，用户自建的一级目录按名称排后。
async function listRoots() {
  let names = [];
  try {
    names = (await fsp.readdir(WS, {withFileTypes: true}))
      .filter(it => it.isDirectory() && isRootName(it.name))
      .map(it => it.name);
  } catch { /* 读不到就只给默认分区 */ }
  const extra = names.filter(n => !ROOTS.includes(n)).sort((a, b) => a.localeCompare(b, 'zh'));
  return [...ROOTS, ...extra];
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
  if (depth > 12 || budget.n <= 0) return;
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
async function tree(user) {
  const out = [];
  const budget = {n: 20000};
  const roots = await listRoots();
  for (const root of roots) {
    out.push({path: root, name: root, type: 'dir', root: true}); // 分区本身也作为条目，前端才能画出目录树
    await walk(path.join(WS, root), root, 1, out, budget);
  }
  const manifest = await readManifest();
  // 附上对象键：前端预览时要用它去换签名链接，不必再解析整条 URL。
  const cos = manifest.filter(e => e.name && e.cos).map(e => ({...e, key: cosKeyFromUrl(e.cos)}));
  const meta = {};
  for (const e of manifest) if (e.path) meta[e.path] = {author: e.author || '', date: e.date || ''};
  const files = out.filter(e => e.type === 'file');
  const meHit = user?.name ? (await loadRoster()).find(m => m.name === user.name) : null;
  const me = user ? {name: user.name, label: meHit?.label || ''} : null;
  const roster = {};
  for (const m of await loadRoster()) roster[m.id] = m.label; // 让前端把署名 id 显示成标签名
  return {
    entries: out, cos, meta, roots, roster,
    labels: await loadAuthors(),   // 路径 → {tag,date,by}：署名标签的唯一来源
    tags: await availableTags(),   // 署名下拉选项
    me,
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

// ---------- 云端（COS）文件预览 ----------
// 这个桶开了「强制下载」：响应固定带 Content-Disposition: attachment 与
// x-cos-force-download: true，连签名 URL 上的 response-content-disposition=inline 都被它盖掉
// （2026-10-16 实测）。所以内联预览有两条路：
//   1) 桶设置允许时 → 直接给带 inline 的签名 URL，浏览器直连 COS，不吃服务器带宽；
//   2) 被强制下载时 → 走 /api/library/cos/stream，由服务端重写响应头再转出去。
const normCosKey = (cfg, key) => {
  const k = String(key || '').replace(/^\/+/, '');
  if (!k || k.length > 300 || k.includes('..')) throw fail(400, '对象无效。');
  if (cfg.COS_PREFIX && !k.startsWith(cfg.COS_PREFIX)) throw fail(400, '对象不在库的云端目录内。');
  return k;
};

// 桶级设置对所有对象一致，探测一次缓存十分钟，免得每次预览都多一趟往返。
let forceDownloadCache = {value: null, at: 0};
async function isForceDownload(cfg, key) {
  if (forceDownloadCache.value !== null && Date.now() - forceDownloadCache.at < 600000) return forceDownloadCache.value;
  let v = true; // 探测失败按「被强制下载」处理：走代理更稳，只是费点带宽
  try {
    const r = await fetch(signedGetUrl(cfg, key, {ttl: 120}), {headers: {Range: 'bytes=0-0'}, signal: AbortSignal.timeout(8000)});
    if (r.ok || r.status === 206) v = r.headers.get('x-cos-force-download') === 'true';
    await r.arrayBuffer().catch(() => {});
  } catch { /* 保持默认值 */ }
  forceDownloadCache = {value: v, at: Date.now()};
  return v;
}

// 前端预览用的链接。direct=true 可直接塞进 <video>/<img>；false 指向本站代理。
// dl=true 时返回「附件」直链（大文件下载通道），依旧直连 COS，不吃本站出口带宽。
async function cosLink(key, {dl = false} = {}) {
  const cfg = loadCosConfig();
  if (!cfg) throw fail(503, '云端存储未配置。');
  const k = normCosKey(cfg, key);
  const base = decodeURIComponent(k.split('/').pop() || '');
  if (dl) return {key: k, url: signedGetUrl(cfg, k, {ttl: 3600, download: base}), direct: true, inline: false, name: base};
  const inline = COS_INLINE.has(path.extname(k).toLowerCase());
  if (!inline) return {key: k, url: signedGetUrl(cfg, k, {ttl: 3600}), direct: true, inline: false};
  if (!(await isForceDownload(cfg, k))) {
    return {key: k, url: signedGetUrl(cfg, k, {ttl: 3 * 3600, inline: true}), direct: true, inline: true};
  }
  return {key: k, url: '/api/library/cos/stream?key=' + encodeURIComponent(k), direct: false, inline: true};
}

// 代理转发：从 COS 取流、按本站规则重写响应头（内联 + 正确 MIME），并把 Range 原样透传，
// 视频才能边下边播、拖进度条。内存占用与文件大小无关（纯流式）。
async function cosStream(req, res, key) {
  const cfg = loadCosConfig();
  const bail = (code, msg) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify({error: msg})); };
  if (!cfg) return bail(503, '云端存储未配置。');
  let k;
  try { k = normCosKey(cfg, key); } catch (e) { return bail(e.status || 400, e.message); }
  const host = `${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com`;
  const headers = {host, Authorization: sign(cfg, 'GET', k, {host})};
  if (req.headers.range) headers.Range = req.headers.range; // Range 不参与签名（q-header-list 只有 host）
  let up;
  try {
    up = await fetch(objectUrl(cfg, k), {headers});
  } catch (e) {
    return bail(502, '取云端文件失败：' + e.message);
  }
  const out = {
    'Content-Type': COS_MIME[path.extname(k).toLowerCase()] || up.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
  };
  for (const [from, to] of [['content-length', 'Content-Length'], ['content-range', 'Content-Range'], ['etag', 'ETag'], ['last-modified', 'Last-Modified']]) {
    const v = up.headers.get(from);
    if (v) out[to] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) { res.end(); return; }
  Readable.fromWeb(up.body).pipe(res);
}

// ---------- 下载 ----------
// 两条通道，按「谁掏带宽」分：
//   1) 云端大文件 → COS 签名直链（attachment），浏览器直连 COS，不消耗本站带宽。
//      实测 6.27 MB/s（≈52 Mbps）；
//   2) 仓库内小文件 / 文件夹打包 → 本服务流式吐出。实测出口 0.69 MB/s（6 Mbps 上限）。
// 2026-10-20 实测：服务器 ← COS 入向 17.4 MB/s（不限速），服务器 → COS 出向 0.66 MB/s（同样受限）。
// 所以「打包后转存 COS」只对同一份包被反复下载才划算，单次下载反而更慢，故不做。
const EGRESS_MBPS = Number(env.EGRESS_MBPS || 6);              // 实例出口带宽（套餐）
const EGRESS_MEASURED = Number(env.EGRESS_MEASURED_MBPS || 0.68); // 实测有效吞吐，仅用于估时
const ZIP_MAX = Number(env.ZIP_MAX_MB || 2048) * 1024 * 1024;  // 不实现 ZIP64，超过 2GB 直接拒
const ZIP_MAX_FILES = Number(env.ZIP_MAX_FILES || 5000);

const asciiName = (n, fb = 'download') => String(n).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || fb;
// RFC 6266 / 5987：ASCII 兜底名 + UTF-8 原名，中文文件名在各大浏览器都不乱码
const disposition = name => `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function downloadFile(rel, res) {
  checkRel(rel);
  const target = safeJoin(rel);
  const st = await fsp.stat(target).catch(() => { throw fail(404, '文件不存在。'); });
  if (!st.isFile()) throw fail(400, '这是文件夹，请用「打包下载」。');
  const name = path.basename(rel);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': disposition(name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const s = createReadStream(target);
  s.on('error', () => res.destroy());
  s.pipe(res);
}

// 收集待打包项。空目录单独记一条，解压后才不会凭空少一层。
async function collectZip(rel, base, acc, budget) {
  let items;
  try { items = await fsp.readdir(safeJoin(rel), {withFileTypes: true}); } catch { return; }
  for (const it of items) {
    if (budget.left <= 0) return;
    if (it.name.startsWith('.') || it.name.startsWith('_')) continue; // _meta/_inbox/.gitkeep 这类元数据不进包
    const r = `${rel}/${it.name}`;
    const entry = base ? r.slice(base.length + 1) : r;
    if (it.isDirectory()) {
      const before = acc.files.length;
      await collectZip(r, base, acc, budget);
      if (acc.files.length === before) acc.dirs.push({path: r, entry});
    } else if (it.isFile()) {
      const st = await fsp.stat(path.join(safeJoin(rel), it.name)).catch(() => null);
      if (!st) continue;
      acc.files.push({path: r, entry, size: st.size, mtime: st.mtimeMs});
      acc.bytes += st.size;
      budget.left -= 1;
    }
  }
}

async function zipPlan(paths) {
  if (!paths.length) throw fail(400, '没有选择要打包的内容。');
  if (paths.length > 50) throw fail(400, '一次最多打包 50 项，请分批。');
  const clean = [...new Set(paths.map(p => checkRel(String(p || ''))))];
  const single = clean.length === 1;
  if (single && !(await isDirRel(clean[0]))) throw fail(400, '单个文件直接下载即可，不必打包。');
  // 单项：以它的父目录为基准，解压出来就是「文件夹名/…」；
  // 多项：一律以库根为基准，避免不同父目录下的同名文件互相覆盖。
  const base = single ? (clean[0].includes('/') ? clean[0].slice(0, clean[0].lastIndexOf('/')) : '') : '';
  const acc = {files: [], dirs: [], bytes: 0};
  const budget = {left: ZIP_MAX_FILES};
  for (const p of clean) {
    if (await isDirRel(p)) {
      const before = acc.files.length + acc.dirs.length;
      await collectZip(p, base, acc, budget);
      // 空文件夹也允许下载：包里放一条目录记录，解压出来就是一个空目录（与 Finder 一致）
      if (acc.files.length + acc.dirs.length === before) acc.dirs.push({path: p, entry: base ? p.slice(base.length + 1) : p});
    } else {
      const st = await fsp.stat(safeJoin(p)).catch(() => null);
      if (st?.isFile()) {
        acc.files.push({path: p, entry: base ? p.slice(base.length + 1) : p, size: st.size, mtime: st.mtimeMs});
        acc.bytes += st.size;
      }
    }
  }
  if (!acc.files.length && !acc.dirs.length) throw fail(400, '这里没有可打包的文件（云端大文件请到「云端大文件」里单独下载，走直连更快）。');
  if (acc.bytes > ZIP_MAX) throw fail(413, `打包总量 ${(acc.bytes / 1048576).toFixed(0)}MB，超过 ${Math.round(ZIP_MAX / 1048576)}MB 上限，请分批下载。`);
  const stamp = day().replaceAll('-', '');
  const name = single ? `${clean[0].split('/').pop()}-${stamp}.zip` : `资料库-${clean.length}项-${stamp}.zip`;
  const seconds = Math.round(acc.bytes / (EGRESS_MBPS * 1e6 / 8));
  return {
    name, base, paths: clean,
    files: acc.files.length, dirs: acc.dirs.length, bytes: acc.bytes,
    items: acc.files.map(f => f.entry),
    list: acc, // 只在服务端内部用：真正落盘吐流的清单（对外的 files/dirs 是数字）
    est: {mbps: EGRESS_MBPS, measuredMb: EGRESS_MEASURED, seconds}, // 前端据此显示「约 X MB / 约 Y 秒」
  };
}

async function zipStream(plan, res) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': disposition(plan.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const zw = createZipWriter(res);
  try {
    for (const d of plan.list.dirs) await zw.addDir(d.entry, safeJoin(d.path));
    for (const f of plan.list.files) await zw.addFile(f.entry, safeJoin(f.path), wantsDeflate(f.entry));
    await zw.finish();
  } catch (e) {
    if (!e.aborted) { console.error('zip failed:', e.message); res.destroy(); } // 头已发出，只能断流
  }
}

// ---------- 后台打包任务（异步：打包 → 传云存储 → 给直链） ----------
// 为什么异步：本站出口实测 0.68 MB/s，同步打包下载就是让人对着进度条等七分钟。
// 反过来，先把包传上云（0.66 MB/s）、再把浏览器甩到 COS 直连（6.3 MB/s），
// 第一次会多花一趟上传时间，但同一份内容 7 天内再下就是秒级，而且不占本站出口。
// 产物落 /data/downloads（app_data 卷；容器根文件系统是只读的），传完即删，
// 只留一份 json 记任务。服务重启会把残留 .part 清掉、任务标成中断。
const JOB_DIR = env.DL_JOB_DIR || '/data/downloads';
const JOB_TTL = Number(env.DL_JOB_TTL_HOURS || 168) * 3600 * 1000; // 直链有效期，默认 7 天
const JOB_KEEP = Number(env.DL_JOB_KEEP || 40);                    // 最多保留多少条任务记录
const JOB_LIVE = new Set(['queued', 'packing', 'uploading']);
const jobs = new Map();
let jobQueue = Promise.resolve();

const newJobId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// 内容指纹：路径 + 每个文件的大小与 mtime。同一份内容再点一次直接复用，不必重打重传。
const jobSig = plan => createHash('sha256')
  .update(JSON.stringify({
    name: plan.name,
    files: plan.list.files.map(f => [f.entry, f.size, f.mtime]),
    dirs: plan.list.dirs.map(d => d.entry),
  }))
  .digest('hex').slice(0, 16);
const jobExpired = j => Boolean(j.finishedAt) && Date.now() - j.finishedAt > JOB_TTL;

function saveJob(j) {
  const p = path.join(JOB_DIR, j.id + '.json');
  const body = JSON.stringify(j, (k, v) => (k === 'ctrl' ? undefined : v));
  return fsp.writeFile(p + '.tmp', body, 'utf8').then(() => fsp.rename(p + '.tmp', p)).catch(() => {});
}

function gcJobs() {
  const all = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  all.forEach((j, i) => {
    if (JOB_LIVE.has(j.status)) return;
    if (i >= JOB_KEEP || jobExpired(j)) {
      jobs.delete(j.id);
      fsp.rm(path.join(JOB_DIR, j.id + '.json'), {force: true}).catch(() => {});
    }
  });
}

// 对外视图。直链每次现签：任务在有效期内随时能拿到能用的链接，不存长期凭证。
function viewJob(j) {
  const total = j.bytes || 0, packed = j.packed || 0, sent = j.sent || 0;
  let pct = 0;
  if (j.status === 'ready') pct = 100;
  else if (j.status === 'uploading') pct = 45 + (total ? Math.min(50, (sent / total) * 50) : 0);
  else if (j.status === 'packing') pct = total ? Math.min(45, (packed / total) * 45) : 0;
  let url = '';
  if (j.status === 'ready' && j.cosKey) {
    const cfg = loadCosConfig();
    const left = Math.floor((JOB_TTL - (Date.now() - j.finishedAt)) / 1000);
    if (cfg && left > 60) {
      try { url = signedGetUrl(cfg, j.cosKey, {ttl: left, download: j.name}); } catch { url = ''; }
    }
  }
  return {
    id: j.id, name: j.name, status: j.status, phase: j.phase || '', pct: Math.round(pct),
    bytes: total, size: j.size || 0, files: j.files || 0, dirs: j.dirs || 0,
    uploaded: sent, packed, url, error: j.error || '',
    createdAt: j.createdAt, expiresAt: j.finishedAt ? j.finishedAt + JOB_TTL : 0,
  };
}

async function runJob(j) {
  const cfg = loadCosConfig();
  const part = path.join(JOB_DIR, j.id + '.part');
  let ws = null;
  try {
    if (!cfg) throw fail(503, '云端存储未配置。');
    const plan = await zipPlan(j.paths); // 真正开打前重算一次：期间文件可能变了
    j.bytes = plan.bytes; j.files = plan.files; j.dirs = plan.dirs; j.name = plan.name;
    j.status = 'packing'; j.phase = '正在打包'; await saveJob(j);

    ws = createWriteStream(part);
    const zw = createZipWriter(ws);
    const tick = setInterval(() => { j.packed = ws.bytesWritten; }, 400); // 打包进度直接读文件流计数
    try {
      for (const d of plan.list.dirs) await zw.addDir(d.entry, safeJoin(d.path));
      for (const f of plan.list.files) {
        if (j.cancel) throw fail(499, '已取消');
        await zw.addFile(f.entry, safeJoin(f.path), wantsDeflate(f.entry));
      }
      if (j.cancel) throw fail(499, '已取消');
      await zw.finish();
      await finished(ws);
    } finally {
      clearInterval(tick);
      j.packed = ws.bytesWritten;
      ws.destroy(); // 正常结束时是空操作；中途失败则放掉文件句柄
    }

    const st = await fsp.stat(part);
    j.size = st.size;
    j.status = 'uploading'; j.phase = '正在上传到云存储'; await saveJob(j);
    j.ctrl = new AbortController();
    const key = `${cfg.COS_PREFIX}downloads/${day().replaceAll('-', '').slice(0, 6)}/${j.id}.zip`;
    await putFile(cfg, key, part, {size: st.size, signal: j.ctrl.signal, onProgress: n => { j.sent = n; }});

    j.cosKey = key; j.status = 'ready'; j.phase = '已就绪'; j.finishedAt = Date.now();
    await saveJob(j);
  } catch (e) {
    j.status = 'error';
    // 只留一行摘要：COS 的报错体是多行 XML，塞进界面只会把布局顶坏
    const raw = (j.cancel || e.status === 499) ? '已取消' : (e.status ? e.message : '打包失败：' + (e.message || '未知错误'));
    j.error = String(raw).split('\n')[0].slice(0, 160);
    j.finishedAt = Date.now();
    await saveJob(j);
    if (!j.cancel) console.error('zip job failed:', e.message);
  } finally {
    delete j.ctrl;
    await fsp.rm(part, {force: true}).catch(() => {});
    gcJobs();
  }
}

async function createJob(paths) {
  if (!loadCosConfig()) throw fail(503, '云端存储未配置，无法后台打包，请用「直接下载」。');
  const plan = await zipPlan(Array.isArray(paths) ? paths : []);
  const sig = jobSig(plan);
  const live = [...jobs.values()].find(j => j.sig === sig && !jobExpired(j) && (JOB_LIVE.has(j.status) || j.status === 'ready'));
  if (live) return {hit: true, job: viewJob(live)}; // 同一份内容：直接复用，不重打不重传
  const j = {
    id: newJobId(), sig, name: plan.name, paths: plan.paths,
    bytes: plan.bytes, files: plan.files, dirs: plan.dirs,
    status: 'queued', phase: '排队中', packed: 0, sent: 0, size: 0,
    cosKey: '', error: '', createdAt: Date.now(), finishedAt: 0,
  };
  jobs.set(j.id, j);
  await saveJob(j);
  jobQueue = jobQueue.then(() => runJob(j)).catch(() => {}); // 一次只打一个包：2 核机器不并行抢 CPU
  return {hit: false, job: viewJob(j)};
}

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) throw fail(404, '任务不存在或已过期。');
  if (!JOB_LIVE.has(j.status)) throw fail(400, '这个任务已经结束了。');
  j.cancel = true;
  if (j.status === 'queued') { j.status = 'error'; j.error = '已取消'; j.finishedAt = Date.now(); saveJob(j); }
  else if (j.ctrl) j.ctrl.abort(); // 上传中：断掉请求，COS 不会留半截对象
  return viewJob(j);
}

async function initJobs() {
  try {
    await fsp.mkdir(JOB_DIR, {recursive: true});
    for (const f of await fsp.readdir(JOB_DIR)) {
      const p = path.join(JOB_DIR, f);
      if (f.endsWith('.part') || f.endsWith('.tmp')) { await fsp.rm(p, {force: true}).catch(() => {}); continue; }
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await fsp.readFile(p, 'utf8'));
        if (JOB_LIVE.has(j.status)) { // 重启前正在跑的任务无法恢复（文件流已断），标成中断让用户重发
          j.status = 'error'; j.error = '服务重启，任务已中断，请重新发起。'; j.finishedAt = Date.now();
        }
        jobs.set(j.id, j);
      } catch { await fsp.rm(p, {force: true}).catch(() => {}); }
    }
    gcJobs();
  } catch (e) {
    console.error('下载任务目录不可用：', e.message);
  }
}
initJobs();

// ---------- 上传 ----------
async function ensureFrontmatter(target, tag) {
  const ext = path.extname(target).toLowerCase();
  if (!DOC_EXT.has(ext)) return;
  const text = await fsp.readFile(target, 'utf8').catch(() => '');
  if (text.startsWith('---')) return;
  const stem = path.basename(target, ext);
  const author = tag ? `author: ${tag}\n` : ''; // 允许不署名
  await fsp.writeFile(target, `---\ntitle: ${stem}\n${author}date: ${day()}\n---\n\n${text}`, 'utf8');
}

// ---------- 文件系统操作（建目录 / 移动重命名 / 贴署名；按要求不提供删除） ----------
const KEEP = '.gitkeep'; // git 不跟踪空目录，用隐藏占位文件（以 . 开头，库里不显示）
function checkNewName(rel) { // 新建/改名的最后一段：不接隐藏名与保留前缀
  const name = String(rel).split('/').pop();
  if (!name || /^[._]/.test(name)) throw fail(400, '名称不能以「.」或「_」开头。');
  if (!/[^\s]/.test(name)) throw fail(400, '名称不能为空。');
  return name;
}
async function mkdirOp(rel, user) {
  checkRel(rel);
  checkNewName(rel);
  const dir = safeJoin(rel);
  if (await exists(dir)) throw fail(400, '同名文件夹已存在。');
  await syncBeforeWrite();
  await fsp.mkdir(dir, {recursive: true});
  await fsp.writeFile(path.join(dir, KEEP), '');
  const author = await resolveAuthor(user.name);
  const ok = await gitCommitPush(`mkdir: 新建文件夹 ${rel}`, author, [`${rel}/${KEEP}`]);
  return {committed: ok, path: rel};
}
async function moveOp(from, to, user) {
  checkRel(from); checkRel(to);
  if (from === to) throw fail(400, '源路径与目标路径相同。');
  if (to.startsWith(from + '/')) throw fail(400, '不能移动到自身的子目录里。');
  if (!from.includes('/') && to.includes('/')) throw fail(400, '一级目录只能在库根内改名，不能挪进子目录。');
  checkNewName(to);
  const src = safeJoin(from), dst = safeJoin(to);
  if (!(await exists(src))) throw fail(400, '源文件不存在。');
  if (await exists(dst)) throw fail(400, '目标位置已有同名项。');
  const author = await resolveAuthor(user.name);
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  return await enqueue(async () => {
    await gitRecover();
    await gitPull(); // 先同步远端，再基于最新登记表改署名，避免覆盖别人的登记
    const authors = await loadAuthors();
    const paths = [from, to];
    if (authors[from]) { authors[to] = authors[from]; delete authors[from]; paths.push('_meta/authors.md'); }
    // 目录整体移动时，子文件的署名也要跟着走
    for (const p of Object.keys(authors)) {
      if (p.startsWith(from + '/')) { authors[`${to}/${p.slice(from.length + 1)}`] = authors[p]; delete authors[p]; }
    }
    await git('mv', from, to);
    if (paths.includes('_meta/authors.md')) await writeAuthors(authors);
    const ok = await commitPush(`move: ${from} → ${to}`, author, paths);
    return {committed: ok, from, to};
  });
}
async function isDirRel(rel) {
  return (await fsp.stat(safeJoin(rel)).catch(() => null))?.isDirectory() || false;
}
// 复制 / 剪切粘贴。规则与常规文件系统一致、但只多一条：
// 目标目录里已有同名项时**不覆盖、不自动改名**，直接报错（库里没有删除能力，覆盖等于静默丢文件）。
// 跨目录允许同内容（复制天然如此）；source 与 destination 相同（往原目录里粘）也报错，理由同上。
async function pasteOp(mode, items, to, user) {
  if (mode !== 'copy' && mode !== 'cut') throw fail(400, '未知的操作类型。');
  if (!Array.isArray(items) || !items.length) throw fail(400, '剪贴板是空的，先复制或剪切。');
  if (items.length > 50) throw fail(400, '一次最多粘贴 50 项，请分批。');
  const destDir = String(to || '').replace(/^\/+|\/+$/g, '');
  if (destDir) {
    checkRel(destDir);
    if (!(await exists(safeJoin(destDir)))) throw fail(400, `目标目录「${destDir}」不存在。`);
    if (!(await isDirRel(destDir))) throw fail(400, `「${destDir}」不是目录，不能作为粘贴目标。`);
  }
  const plan = [], seen = new Set();
  for (const raw of items) {
    const from = checkRel(String(raw || ''));
    const name = from.split('/').pop();
    checkNewName(name);
    const dest = destDir ? `${destDir}/${name}` : name;
    if (seen.has(dest)) throw fail(409, `选中内容里有重名项「${name}」，请分开粘贴。`);
    seen.add(dest);
    if (dest === from) throw fail(400, `「${name}」已经在这个位置，不用粘贴。`);
    if (mode === 'cut') {
      if (!from.includes('/') && dest.includes('/')) throw fail(400, `一级目录「${name}」只能在库根内改名，不能挪进子目录。`);
      if (dest.startsWith(from + '/')) throw fail(400, `「${name}」不能移动进自身的子目录。`);
    } else if (dest.startsWith(from + '/')) {
      throw fail(400, `「${name}」不能复制进自身的子目录。`);
    }
    if (!(await exists(safeJoin(from)))) throw fail(400, `「${name}」已不在原位置，可能被别人改过，刷新后重试。`);
    const isDir = await isDirRel(from);
    // 库根只放一级目录：往库根粘文件会落在任何视图都看不到的地方，直接拦住
    if (!destDir && !isDir) throw fail(400, `库根只能放一级目录，「${name}」是文件，请选一个目录粘贴。`);
    if (await exists(safeJoin(dest))) throw fail(409, `目标位置已有同名项「${name}」。同一文件夹内不能重名。`);
    plan.push({from, to: dest, name, isDir});
  }
  const author = await resolveAuthor(user.name);
  return await enqueue(async () => {
    await gitRecover();
    await gitPull(); // 先同步远端，再基于最新登记表改署名，避免覆盖别人的登记
    const authors = await loadAuthors();
    const before = JSON.stringify(authors);
    for (const it of plan) {
      await fsp.mkdir(path.dirname(safeJoin(it.to)), {recursive: true});
      if (mode === 'cut') await git('mv', it.from, it.to);
      else await fsp.cp(safeJoin(it.from), safeJoin(it.to), {recursive: true, errorOnExist: false, force: false});
      // 署名跟着走：副本继承原件的署名，剪切时原条目迁到新路径（目录连整棵子树）
      for (const p of Object.keys(authors)) {
        if (p === it.from) {
          authors[it.to] = authors[p];
          if (mode === 'cut') delete authors[p];
        } else if (p.startsWith(it.from + '/')) {
          authors[`${it.to}/${p.slice(it.from.length + 1)}`] = authors[p];
          if (mode === 'cut') delete authors[p];
        }
      }
    }
    const paths = plan.flatMap(it => [it.from, it.to]);
    const renamed = JSON.stringify(authors) !== before;
    if (renamed) { await writeAuthors(authors); paths.push('_meta/authors.md'); }
    const what = plan.length === 1 ? plan[0].name : `${plan.length} 项`;
    const where = destDir || '库根';
    const msg = mode === 'cut' ? `move: ${what} → ${where}` : `copy: ${what} → ${where}`;
    const ok = await commitPush(msg, author, paths);
    return {mode, to: destDir, items: plan.map(it => it.to), committed: ok};
  });
}
async function tagOp(rel, value, user) {
  checkRel(rel);
  if (!(await exists(safeJoin(rel)))) throw fail(400, '文件不存在。');
  if (!value) return {tagged: false, tag: '', message: '未署名'}; // 允许不署名
  const tags = await availableTags();
  const hit = tags.find(t => t.label === value || t.id === value);
  if (!hit) throw fail(400, '未知的署名标签。');
  const author = await resolveAuthor(user.name);
  return await enqueue(async () => {
    await gitRecover();
    await gitPull();
    const authors = await loadAuthors();
    if (authors[rel]) throw fail(400, `这份文件已署名为「${authors[rel].tag}」，署名不可修改。`);
    authors[rel] = {tag: hit.label, date: day(), by: user.name};
    await writeAuthors(authors);
    const ok = await commitPush(`tag: ${rel} 署名 ${hit.label}`, author, ['_meta/authors.md']);
    return {tagged: true, tag: hit.label, committed: ok};
  });
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
    // dirs 是「空文件夹相对路径」清单，可能很长，单独放宽上限
    else if (p.name) fields[p.name] = p.data.toString('utf8').slice(0, p.name === 'dirs' ? 60000 : 500);
  }
  if (!files.length && !fields.dirs) throw fail(400, '没有选择文件。');
  if (files.length > 200) throw fail(400, '一次最多上传 200 个文件，请分批。');

  const author = await resolveAuthor(user.name);
  const rosterHit = (await loadRoster()).find(m => m.name === user.name);
  // 署名标签：请求显式给出就用它（空串 = 不署名），否则默认用登录人对应的标签
  const tag = fields.tag !== undefined ? fields.tag.trim() : (rosterHit?.label || author.name);
  await syncBeforeWrite();          // 先把远端同步与残留清理做完，再落本地文件
  const cfg = loadCosConfig();
  let targetRel = (fields.path || 'knowledge').replace(/^\/+|\/+$/g, '');
  checkRel(targetRel);
  const targetDir = safeJoin(targetRel);
  await fsp.mkdir(targetDir, {recursive: true});

  const results = [], touched = new Set(), manifestLines = [], authorsNew = {};
  let skipped = 0; // 被跳过的干扰项（.DS_Store / _ 开头的目录等），回给前端如实告知

  // 先建空文件夹（浏览器不会为没有文件的目录产生条目，所以前端单独传一份清单）
  for (const raw of String(fields.dirs || '').split('\n')) {
    const sub = safeRelPath(raw);
    if (!sub) { if (raw.trim()) skipped += 1; continue; }
    const dir = path.join(targetDir, sub);
    await fsp.mkdir(dir, {recursive: true});
    await fsp.writeFile(path.join(dir, KEEP), '');
    const dirRel = path.relative(WS, dir).split(path.sep).join('/');
    touched.add(`${dirRel}/${KEEP}`);
    results.push({name: `${sub}/`, route: 'dir', path: dirRel});
  }

  for (const f of files) {
    const relSub = safeRelPath(f.filename); // 文件夹上传时形如 "docs/子目录/文件.md"
    if (!relSub) { skipped += 1; continue; }
    const name = path.basename(relSub), subDir = path.dirname(relSub);
    const ext = path.extname(name).toLowerCase();
    if (VIDEO_EXT.has(ext) || f.data.length > GIT_MAX) {
      // COS 路由（对象存储按类型+日期扁平存放，不保留目录层级；层级信息记进 manifest）
      if (!cfg) throw fail(503, '云端存储未配置，请联系管理员。');
      const subdir = VIDEO_EXT.has(ext) ? 'videos' : 'assets';
      const key = cosKeyFor(cfg, name, subdir);
      const r = await putBuffer(cfg, key, f.data);
      const label = subDir && subDir !== '.' ? `${subDir}/${name}` : name;
      manifestLines.push(`- name: ${label}\n  author: ${tag || ''}\n  date: ${day()}\n  size_mb: ${(f.data.length / 1048576).toFixed(1)}\n  status: stored\n  cos: ${r.url}\n`);
      results.push({name, route: 'cos', url: r.url});
    } else {
      // git 路由：保留文件夹层级（重名加日期后缀，再重加序号）
      const outDir = subDir && subDir !== '.' ? path.join(targetDir, subDir) : targetDir;
      await fsp.mkdir(outDir, {recursive: true});
      let dest = path.join(outDir, name);
      let stem = path.basename(name, ext), n = 0;
      while (true) {
        try { await fsp.access(dest); n += 1; dest = path.join(outDir, n === 1 ? `${stem}-${day()}${ext}` : `${stem}-${day()}-${n}${ext}`); }
        catch { break; }
      }
      await fsp.writeFile(dest, f.data);
      await ensureFrontmatter(dest, tag);
      const rel = path.relative(WS, dest).split(path.sep).join('/');
      touched.add(rel);
      if (tag) { authorsNew[rel] = {tag, date: day(), by: user.name}; }
      if (MEDIA_EXT.has(ext)) manifestLines.push(`- path: ${rel}\n  author: ${tag || ''}\n  date: ${day()}\n`);
      results.push({name: path.basename(dest), route: 'git', path: rel});
    }
  }

  if (manifestLines.length) {
    await fsp.appendFile(MANIFEST, manifestLines.join(''));
    touched.add('media/manifest.yaml');
  }
  if (Object.keys(authorsNew).length) { // 署名登记（已署名文件不受影响，只新增）
    const authors = await loadAuthors();
    Object.assign(authors, authorsNew);
    await writeAuthors(authors);
    touched.add('_meta/authors.md');
  }

  let committed = false;
  if (touched.size) {
    const gitFiles = results.filter(r => r.route === 'git').length;
    const dirs = results.filter(r => r.route === 'dir').length;
    const cosFiles = results.filter(r => r.route === 'cos').length;
    const names = results.filter(r => r.route === 'git').map(r => r.name).slice(0, 3).join('、');
    const parts = [];
    if (dirs) parts.push(`${dirs} 个文件夹`);
    if (gitFiles) parts.push(`${gitFiles} 个文件（${names}${gitFiles > 3 ? ' 等' : ''}）`);
    if (cosFiles) parts.push(`${cosFiles} 个大文件入云端`);
    const msg = `upload: ${tag || '未署名'} 上传 ${parts.join(' + ') || '大文件登记'}`;
    committed = await gitCommitPush(msg, author, [...touched]);
  }
  return {results, committed, author: author.name, tag: tag || '', skipped};
}

// ---------- 入口 ----------
export async function handleLibrary({path: p, method, req, res, respond, user, body}) {
  if (p === '/api/library/tree' && method === 'GET') { refreshSoon(); respond(res, 200, await tree(user)); return true; }
  if (p === '/api/library/file' && method === 'GET') {
    const rel = new URL(req.url, 'http://x').searchParams.get('path') || '';
    const {buf, type, ext} = await preview(rel);
    res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(ext === '.svg' ? {'Content-Security-Policy': "script-src 'none'"} : {})});
    res.end(buf);
    return true;
  }
  if (p === '/api/library/cos' && method === 'GET') { // 换预览链接（签名直连或本站代理）
    const u = new URL(req.url, 'http://x');
    respond(res, 200, await cosLink(u.searchParams.get('key') || '', {dl: u.searchParams.get('dl') === '1'}));
    return true;
  }
  if (p === '/api/library/cos/stream' && method === 'GET') { // 代理转发云端对象（支持 Range）
    await cosStream(req, res, new URL(req.url, 'http://x').searchParams.get('key') || '');
    return true;
  }
  if (p === '/api/library/download' && method === 'GET') { // 仓库内单文件下载（走本站，受出口带宽限制）
    await downloadFile(new URL(req.url, 'http://x').searchParams.get('path') || '', res);
    return true;
  }
  if (p === '/api/library/zip' && method === 'GET') { // 文件夹 / 多选打包：plan=1 先报体积与预计耗时
    const u = new URL(req.url, 'http://x');
    const plan = await zipPlan(u.searchParams.getAll('path'));
    if (u.searchParams.get('plan') === '1') { const {list, ...pub} = plan; respond(res, 200, pub); return true; }
    await zipStream(plan, res);
    return true;
  }
  if (p === '/api/library/zipjob' && method === 'POST') { // 建后台打包任务（同一份内容复用旧任务）
    respond(res, 200, await createJob(body?.paths));
    return true;
  }
  if (p === '/api/library/zipjob' && method === 'GET') {
    const j = jobs.get(new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!j) throw fail(404, '任务不存在或已过期。');
    respond(res, 200, viewJob(j));
    return true;
  }
  if (p === '/api/library/zipjobs' && method === 'GET') { // 任务列表：刷新页面后也能找回已打好的包
    gcJobs();
    respond(res, 200, {jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(viewJob)});
    return true;
  }
  if (p === '/api/library/zipjob/cancel' && method === 'POST') {
    respond(res, 200, cancelJob(String(body?.id || '')));
    return true;
  }
  if (p === '/api/upload' && method === 'POST') {
    respond(res, 200, await upload(req, user));
    return true;
  }
  if (p === '/api/library/mkdir' && method === 'POST') {
    respond(res, 200, await mkdirOp(String(body.path || ''), user));
    return true;
  }
  if (p === '/api/library/move' && method === 'POST') {
    respond(res, 200, await moveOp(String(body.from || ''), String(body.to || ''), user));
    return true;
  }
  if (p === '/api/library/paste' && method === 'POST') { // 复制 / 剪切粘贴（以站点身份，不支持删除）
    respond(res, 200, await pasteOp(String(body.mode || ''), body.items, String(body.to || ''), user));
    return true;
  }
  if (p === '/api/library/tag' && method === 'POST') {
    respond(res, 200, await tagOp(String(body.path || ''), String(body.tag || ''), user));
    return true;
  }
  return false;
}
