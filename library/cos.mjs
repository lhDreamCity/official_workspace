// 腾讯云 COS 存取层（Node 原生，零依赖）。算法与 dreamcity_workspace/scripts/cos_store.py 一致。
// 关键坑（2026-10-14 联调排掉）：签名用原始 key，请求 URL 用编码后路径，两者反过来必 403。
import {createHash, createHmac} from 'node:crypto';
import https from 'node:https';
import {createReadStream} from 'node:fs';
import {Transform} from 'node:stream';

export function loadCosConfig(env = process.env) {
  const cfg = {
    COS_BUCKET: env.COS_BUCKET || '',
    COS_REGION: env.COS_REGION || '',
    COS_SECRET_ID: env.COS_SECRET_ID || '',
    COS_SECRET_KEY: env.COS_SECRET_KEY || '',
    COS_PREFIX: env.COS_PREFIX || 'assets/',
  };
  return (cfg.COS_BUCKET && cfg.COS_REGION && cfg.COS_SECRET_ID && cfg.COS_SECRET_KEY) ? cfg : null;
}

// 参数值按 RFC3986 编码（与腾讯云签名规范一致）
function encodeParam(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// params：参与签名的 URL 参数（例如 response-content-disposition）。
// 坑（2026-10-16 踩）：URL 里带了什么参数，就必须在 q-url-param-list 里列出并参与签名，
// 漏签必 403 —— 这跟「签原始 key、请求用编码路径」是同一类对称性要求。
export function sign(cfg, method, key, headers, params = {}, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + ttl}`;
  const names = Object.keys(headers).sort();
  const headerList = names.join(';');
  const headerStr = names.map(k => `${k}=${headers[k]}`).join('&');
  const pNames = Object.keys(params).sort();
  const paramList = pNames.join(';');
  const queryStr = pNames.map(k => `${k}=${encodeParam(String(params[k]))}`).join('&');
  const httpString = `${method.toLowerCase()}\n/${key}\n${queryStr}\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
  const signKey = createHmac('sha1', cfg.COS_SECRET_KEY).update(keyTime).digest('hex');
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${cfg.COS_SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${paramList}&q-signature=${signature}`;
}

// 生成能直接塞进 <video>/<img>/<iframe> 的签名 GET 链接。
// inline=true 会用 response-content-disposition=inline 覆盖 COS 的「强制下载」：
// 桶里的对象带 Content-Disposition: attachment + x-cos-force-download: true，
// 不覆盖的话浏览器一律走下载，<video> 根本拿不到流（2026-10-16 实测确认）。
// download='文件名.ext' 则显式声明为附件并带上原名，供「下载」按钮使用。
export function signedGetUrl(cfg, key, { ttl = 3600, inline = false, download = '' } = {}) {
  const host = `${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com`;
  let disposition = '';
  if (download) disposition = `attachment; filename="${String(download).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(download)}`;
  else if (inline) disposition = 'inline';
  const params = disposition ? { 'response-content-disposition': disposition } : {};
  const qs = Object.keys(params).sort().map(k => `${k}=${encodeParam(params[k])}`).join('&');
  const url = `https://${host}/${quoteKey(key)}${qs ? '?' + qs : ''}`;
  return `${url}${qs ? '&' : '?'}${sign(cfg, 'GET', key, { host }, params, ttl)}`;
}

// 从 manifest 里存的完整 URL 反解出对象键：前端只需要 key，不必重新拼 URL。
export function cosKeyFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/\.myqcloud\.com$/.test(u.hostname)) return '';
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch { return ''; }
}

// 与 Python urllib.parse.quote(s, safe='/') 对齐
function quoteKey(key) {
  return key.split('/').map(seg =>
    encodeURIComponent(seg).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  ).join('/');
}

export function cosKeyFor(cfg, name, subdir = 'misc') {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // Asia/Shanghai
  const ym = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${cfg.COS_PREFIX}${subdir}/${ym}/${name}`;
}

export function publicUrl(cfg, key) {
  return `https://${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com/${key}`;
}

// 编码后的对象地址：请求走编码路径、签名走原始 key，两者不能反过来（见文件头注释）。
export function objectUrl(cfg, key) {
  return `https://${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com/${quoteKey(key)}`;
}

// 流式 PUT：后台打包把几十上百 MB 的 zip 传上云时用。
// 不用 fetch 的原因：undici 的流式请求体只能走 chunked，而 COS 的 PUT 要 Content-Length
// 才肯收；node:https 可以显式给长度、直接 pipe 文件，内存占用与文件大小无关。
// 进度用计量 Transform 统计已发字节；取消时 destroy 请求（COS 那边不会留半截对象）。
export function putFile(cfg, key, filePath, {size, onProgress, signal} = {}) {
  const host = `${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com`;
  const type = 'application/zip';
  // 只签 host。把 content-type 也签进去反而 403：COS 校验时会把 header 值当 URL 参数再编码一遍
  // （服务端回显的 FormatString 是 content-type=text%2Fplain，而我们签的是 text/plain），
  // 未列入 q-header-list 的 header 不参与校验，这里留它在签名外更稳（2026-10-20 实测三种组合）。
  const auth = sign(cfg, 'PUT', key, {host});
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'PUT',
      hostname: host,
      path: '/' + quoteKey(key),
      headers: {Authorization: auth, 'Content-Type': type, 'Content-Length': size},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) resolve({key, url: publicUrl(cfg, key)});
        else reject(new Error(`COS 上传失败：HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('已取消')), {once: true});
    let sent = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) { sent += chunk.length; onProgress?.(sent); cb(null, chunk); },
    });
    createReadStream(filePath, {highWaterMark: 256 * 1024}).on('error', reject).pipe(meter).pipe(req);
  });
}

export async function putBuffer(cfg, key, buf) {
  const host = `${cfg.COS_BUCKET}.cos.${cfg.COS_REGION}.myqcloud.com`;
  const headers = {host}; // 签名只带 host；fetch 会自动带上同值 Host 与 Content-Length
  const res = await fetch(`https://${host}/${quoteKey(key)}`, {
    method: 'PUT',
    headers: {Authorization: sign(cfg, 'PUT', key, headers)},
    body: buf,
    signal: AbortSignal.timeout(300000),
  });
  if (res.status !== 200) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`COS 上传失败：HTTP ${res.status} ${detail}`);
  }
  return {key, url: publicUrl(cfg, key)};
}
