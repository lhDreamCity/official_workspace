// 流式 ZIP 打包（零依赖，Node 原生 zlib）。
// 为什么手写而不用 archiver：仓库原则是零依赖；而且这里的文件都是「边读边发」的，
// 一次只在内存里放一个 256KB 分片，打包 2GB 目录和打包 2MB 目录的驻留内存一样。
//
// 结构上走「数据描述符」（general purpose bit 3）：本地头里把 crc 与两个长度写 0，
// 文件流完之后再补一个 16 字节的 data descriptor，最后统一写中央目录 + EOCD。
// 这样就不必先 stat 一遍算大小（DEFLATE 后的长度本来就无法预知）。
import {createReadStream} from 'node:fs';
import {createDeflateRaw} from 'node:zlib';
import {Transform} from 'node:stream';
import fsp from 'node:fs/promises';

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf, crc = 0) => {
  let c = crc ^ -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const dosTime = d => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = d => ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

// 已经压过的类型再 DEFLATE 只是白烧 CPU（服务器只有 2 核），只在文本类上压
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svg', '.xml', '.py', '.sh', '.sql', '.log', '.ini', '.toml']);
export const wantsDeflate = name => TEXT_EXT.has(('.' + String(name).split('.').pop()).toLowerCase());

/**
 * @param {import('node:http').ServerResponse} res
 * @returns {{addFile:(name:string,filePath:string,compress:boolean)=>Promise<void>, addDir:(name:string,dirPath:string)=>Promise<void>, finish:()=>Promise<void>, aborted:()=>boolean}}
 */
export function createZipWriter(res) {
  const entries = [];
  let offset = 0, dead = false;
  res.on('close', () => { dead = true; }); // 客户端拔线就停，别把 2GB 空转完

  const put = buf => new Promise((resolve, reject) => {
    if (dead) return reject(Object.assign(new Error('客户端已断开'), {aborted: true}));
    offset += buf.length;
    if (res.write(buf)) resolve();
    else res.once('drain', () => (dead ? reject(Object.assign(new Error('客户端已断开'), {aborted: true})) : resolve()));
  });

  const localHeader = (nameBuf, method, time, date, flag) => {
    const b = Buffer.alloc(30);
    b.writeUInt32LE(0x04034b50, 0);
    b.writeUInt16LE(20, 4);              // version needed
    b.writeUInt16LE(flag, 6);
    b.writeUInt16LE(method, 8);
    b.writeUInt16LE(time, 10);
    b.writeUInt16LE(date, 12);
    // crc / csize / usize 留 0：走数据描述符
    b.writeUInt16LE(nameBuf.length, 26);
    b.writeUInt16LE(0, 28);              // extra
    return b;
  };

  async function addFile(name, filePath, compress) {
    const st = await fsp.stat(filePath);
    const nameBuf = Buffer.from(name, 'utf8');
    const method = compress ? 8 : 0;
    const flag = 0x0808;                 // bit3 = 数据描述符，bit11 = 文件名 UTF-8
    const time = dosTime(st.mtime), date = dosDate(st.mtime);
    const headerOffset = offset;
    await put(Buffer.concat([localHeader(nameBuf, method, time, date, flag), nameBuf]));

    let crc = 0, usize = 0, csize = 0;
    const src = createReadStream(filePath, {highWaterMark: 256 * 1024});
    // 用一个计数 Transform 串在源与压缩器之间：既能统计原始字节与 CRC，
    // 又不依赖事件监听时序（给流挂 'data' 会提前切到 flowing 模式，可能丢片）。
    const counter = new Transform({
      transform(chunk, _enc, cb) { usize += chunk.length; crc = crc32(chunk, crc); cb(null, chunk); },
    });
    if (method === 8) {
      const dz = createDeflateRaw({level: 6});
      src.pipe(counter).pipe(dz);
      for await (const chunk of dz) { csize += chunk.length; await put(chunk); }
    } else {
      src.pipe(counter);
      for await (const chunk of counter) { csize += chunk.length; await put(chunk); }
    }

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(csize, 8);
    dd.writeUInt32LE(usize, 12);
    await put(dd);
    entries.push({nameBuf, method, time, date, crc, csize, usize, offset: headerOffset, ext: false});
  }

  // 空目录也要能在解压后看到，否则「文件夹里只有子目录和空目录」会凭空少一层
  async function addDir(name, dirPath) {
    const st = await fsp.stat(dirPath);
    const nameBuf = Buffer.from(name.endsWith('/') ? name : name + '/', 'utf8');
    const time = dosTime(st.mtime), date = dosDate(st.mtime);
    const offset0 = offset;
    await put(Buffer.concat([localHeader(nameBuf, 0, time, date, 0x0800), nameBuf]));
    entries.push({nameBuf, method: 0, time, date, crc: 0, csize: 0, usize: 0, offset: offset0, ext: true});
  }

  async function finish() {
    const cdOffset = offset;
    for (const e of entries) {
      const b = Buffer.alloc(46);
      b.writeUInt32LE(0x02014b50, 0);
      b.writeUInt16LE(20, 4);            // version made by
      b.writeUInt16LE(20, 6);            // version needed
      b.writeUInt16LE(e.method === 8 ? 0x0808 : 0x0800, 8);
      b.writeUInt16LE(e.method, 10);
      b.writeUInt16LE(e.time, 12);
      b.writeUInt16LE(e.date, 14);
      b.writeUInt32LE(e.crc, 16);
      b.writeUInt32LE(e.csize, 20);
      b.writeUInt32LE(e.usize, 24);
      b.writeUInt16LE(e.nameBuf.length, 28);
      // extra / comment / disk / attrs 全 0
      b.writeUInt32LE(e.ext ? 0x10 : 0x20, 38); // 目录位 / 普通文件（Unix 属性由解压器自行推断）
      b.writeUInt32LE(e.offset, 42);
      await put(Buffer.concat([b, e.nameBuf]));
    }
    const cdSize = offset - cdOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    await put(eocd);
    res.end();
  }

  return {addFile, addDir, finish, aborted: () => dead};
}
