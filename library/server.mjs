// 「库」独立服务（端口 3001）：复用 app_data 卷 sessions 表做企微认证，与 backend/server.mjs 同一套判定。
import http from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {handleLibrary} from './library.mjs';

const env = process.env;
const ORIGIN = new URL(env.PUBLIC_ORIGIN || 'https://work.lhdreamcity.com').origin;
const PROVIDER = env.AUTH_PROVIDER || 'wecom';
const TENANT = env.RECORD_TENANT || env.WECOM_CORP_ID || '';
const PORT = Number(env.PORT || 3001);

const hash = s => createHash('sha256').update(s).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const getCookie = (req, name) => {
  try { return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || ''; }
  catch { return ''; }
};

const db = new DatabaseSync(env.DB_PATH || '/data/workroom.sqlite', {readOnly: true}); // 只读取会话，主库写权限留在 app 服务
try { db.exec('PRAGMA busy_timeout=5000;'); } catch { /* 只读连接下忽略 */ }

function session(req) {
  return db.prepare('SELECT * FROM sessions WHERE token=? AND expires>? AND provider=? AND tenant=?')
    .get(hash(getCookie(req, 'workroom_session')), Date.now(), PROVIDER, TENANT);
}
function respond(res, status, data, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers});
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN), p = url.pathname;
  try {
    if (p === '/api/library/health' && req.method === 'GET') { db.prepare('SELECT 1').get(); return respond(res, 200, {ok: true}); }
    if (p === '/api/upload' || p.startsWith('/api/library/')) {
      const user = session(req);
      if (!user) throw Object.assign(new Error('登录已过期，请重新登录。'), {status: 401});
      if (req.method === 'POST') { // 与主服务 writeGuard 相同：Origin + CSRF
        if (req.headers.origin !== ORIGIN || !equal(req.headers['x-csrf-token'], user.csrf))
          throw Object.assign(new Error('请求验证失败，请刷新页面后重试。'), {status: 403});
      }
      let body = null;
      if (req.method === 'POST' && p !== '/api/upload') { // 文件操作类接口用 JSON body（上传走 multipart）
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 65536) throw Object.assign(new Error('请求内容过大。'), {status: 413});
          chunks.push(c);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { throw Object.assign(new Error('请求格式错误。'), {status: 400}); }
      }
      if (await handleLibrary({path: p, method: req.method, req, res, respond, user, body})) return;
    }
    throw Object.assign(new Error('页面不存在。'), {status: 404});
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error('Library request failed:', e.message);
    respond(res, status, {error: e.status ? e.message : '服务暂时不可用，请稍后重试。'});
  }
});
server.requestTimeout = 600000;   // 大文件上传最长 10 分钟
server.headersTimeout = 15000;
server.listen(PORT, '0.0.0.0', () => console.log('Library service started on', PORT));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
