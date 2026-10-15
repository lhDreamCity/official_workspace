// 腾讯云 COS 存取层（Node 原生，零依赖）。算法与 dreamcity_workspace/scripts/cos_store.py 一致。
// 关键坑（2026-10-14 联调排掉）：签名用原始 key，请求 URL 用编码后路径，两者反过来必 403。
import {createHash, createHmac} from 'node:crypto';

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

export function sign(cfg, method, key, headers) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 3600}`;
  const names = Object.keys(headers).sort();
  const headerList = names.join(';');
  const headerStr = names.map(k => `${k}=${headers[k]}`).join('&');
  const httpString = `${method.toLowerCase()}\n/${key}\n\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
  const signKey = createHmac('sha1', cfg.COS_SECRET_KEY).update(keyTime).digest('hex');
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${cfg.COS_SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;
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
