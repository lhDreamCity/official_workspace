// SQLite 定时备份：一致性快照 → 传 COS。
//
// 为什么不能直接拷 .sqlite 文件：
//   库开着 WAL，主库文件 57KB 而 WAL 有 729KB —— 只拷主库会丢掉还在 WAL 里
//   没 checkpoint 的记录。备份文件照样能打开、看着是好的，内容却是残的
//   （2026-10-29 实测：现存手工备份只有一半记录、且丢了唯一那条 session）。
//   VACUUM INTO 会把主库 + WAL 一起读成一份自洽的快照，这才是能用的备份。
//
// 运行方式（宿主机）：
//   tools/backup-db.sh            —— 包了一层 docker run，主机不需要装 node
//   node tools/backup-db.mjs      —— 在容器里直接跑
//
// 环境变量（都有默认值）：
//   DB_PATH             默认 /data/workroom.sqlite
//   BACKUP_DIR          默认 /data/backups
//   BACKUP_COS_PREFIX   默认 backups/db/
//   BACKUP_DEST         cos（默认，上传 COS）| local（只做快照与校验，不外传，用于演练）
//
// 刻意不做的事：
//   · 不删任何文件 —— 本地快照每天几十 KB，攒着无所谓；COS 上的旧备份
//     交给桶的生命周期规则处理，不在这里写删除逻辑。
//   · 不碰已有的 before-*.sqlite 手工快照（那是别的流程留的）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { loadCosConfig, putFile } from '../library/cos.mjs';

const DB_PATH = process.env.DB_PATH || '/data/workroom.sqlite';
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const COS_PREFIX = process.env.BACKUP_COS_PREFIX || 'backups/db/';
const DEST = process.env.BACKUP_DEST || 'cos';

const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const fileName = `workroom-${stamp}-${process.pid}.sqlite`;
const snapshotPath = path.join(BACKUP_DIR, fileName);

function tableCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const counts = {};
    for (const t of tables) counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    return counts;
  } finally {
    db.close();
  }
}

function fail(message) {
  console.error(`[backup-db] 失败：${message}`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 1) 先读一次活的库做基线 —— 快照的行数至少要不低于它
let liveCounts;
try {
  liveCounts = tableCounts(DB_PATH);
} catch (e) {
  fail(`读不到源库 ${DB_PATH}：${e.message}`);
}
console.log(`[backup-db] 源库 ${DB_PATH} 行数 ${JSON.stringify(liveCounts)}`);

// 2) VACUUM INTO 做一致性快照（主库 + WAL 一起）
let source;
try {
  source = new DatabaseSync(DB_PATH);
  source.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  source.close();
} catch (e) {
  fail(`VACUUM INTO 失败：${e.message}`);
}

// 3) 校验快照：完整性 + 行数不低于基线
try {
  const check = new DatabaseSync(snapshotPath, { readOnly: true });
  const integrity = check.prepare('PRAGMA integrity_check').get();
  check.close();
  if (!integrity || integrity.integrity_check !== 'ok') fail(`快照完整性检查不通过：${JSON.stringify(integrity)}`);
} catch (e) {
  fail(`快照校验失败：${e.message}`);
}
const snapCounts = tableCounts(snapshotPath);
for (const [table, n] of Object.entries(liveCounts)) {
  if ((snapCounts[table] ?? 0) < n) fail(`快照少了数据：${table} 基线 ${n} → 快照 ${snapCounts[table]}`);
}
console.log(`[backup-db] 快照行数 ${JSON.stringify(snapCounts)}`);

// 4) 传 COS
if (DEST === 'local') {
  console.log(`[backup-db] BACKUP_DEST=local，演练模式：快照留在 ${snapshotPath}，不上传`);
  console.log(`[backup-db] 完成（演练）${snapshotPath}`);
  process.exit(0);
}
const cfg = loadCosConfig();
if (!cfg) fail('COS 配置不完整（library.env 里 COS_*），快照已留在本地未上传');
const key = `${COS_PREFIX}${fileName}`;
const size = fs.statSync(snapshotPath).size;
try {
  await putFile(cfg, key, snapshotPath, { size });
} catch (e) {
  fail(`上传 COS 失败（快照留在本地 ${snapshotPath}）：${e.message}`);
}
console.log(`[backup-db] 已上传 COS ${key}（${(size / 1048576).toFixed(2)} MB）`);
console.log(`[backup-db] 完成 ${key}`);
