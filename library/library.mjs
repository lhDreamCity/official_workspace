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
  for (const root of ROOTS) {
    out.push({path: root, name: root, type: 'dir', root: true}); // 分区本身也作为条目，前端才能画出目录树
    await walk(path.join(WS, root), root, 1, out, budget);
  }
  const manifest = await readManifest();
  const cos = manifest.filter(e => e.name && e.cos);
  const meta = {};
  for (const e of manifest) if (e.path) meta[e.path] = {author: e.author || '', date: e.date || ''};
  const files = out.filter(e => e.type === 'file');
  const meHit = user?.name ? (await loadRoster()).find(m => m.name === user.name) : null;
  const me = user ? {name: user.name, label: meHit?.label || ''} : null;
  const roster = {};
  for (const m of await loadRoster()) roster[m.id] = m.label; // 让前端把署名 id 显示成标签名
  return {
    entries: out, cos, meta, roots: ROOTS, roster,
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
  if (!from.includes('/') && to.includes('/')) throw fail(400, '分区目录不能改名，请在各分区内部移动。');
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
  if (p === '/api/library/tag' && method === 'POST') {
    respond(res, 200, await tagOp(String(body.path || ''), String(body.tag || ''), user));
    return true;
  }
  return false;
}
