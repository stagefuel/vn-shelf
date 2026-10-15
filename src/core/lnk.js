'use strict';
// Read where a Windows shortcut (.lnk) points, without Windows: the documented Shell Link format
// (MS-SHLLINK). Returns { target, args, workingDir } or null.

const fsp = require('fs').promises;

const HAS_IDLIST = 0x1, HAS_LINKINFO = 0x2, HAS_NAME = 0x4, HAS_RELPATH = 0x8, HAS_WORKDIR = 0x10, HAS_ARGS = 0x20, HAS_ICON = 0x40, UNICODE = 0x80;

function cstr(buf, at, wide) {
  if (at <= 0 || at >= buf.length) return '';
  if (wide) {
    let end = at;
    while (end + 1 < buf.length && (buf[end] || buf[end + 1])) end += 2;
    return buf.toString('utf16le', at, end);
  }
  let end = at;
  while (end < buf.length && buf[end]) end++;
  // ANSI paths use the PC's code page; Shift-JIS on Japanese Windows. Try it, else Latin-1.
  try { return new TextDecoder('shift_jis', { fatal: true }).decode(buf.subarray(at, end)); } catch { return buf.toString('latin1', at, end); }
}

function parse(buf) {
  if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x4c) return null;
  const flags = buf.readUInt32LE(0x14);
  let p = 0x4c;
  if (flags & HAS_IDLIST) p += 2 + buf.readUInt16LE(p);
  let target = '';
  if (flags & HAS_LINKINFO) {
    const size = buf.readUInt32LE(p);
    const headerSize = buf.readUInt32LE(p + 4);
    const localOff = buf.readUInt32LE(p + 16);
    const suffixOff = buf.readUInt32LE(p + 24);
    if (headerSize >= 0x24) {
      const localW = buf.readUInt32LE(p + 28);
      const suffixW = buf.readUInt32LE(p + 32);
      target = cstr(buf, p + localW, true) + (suffixW ? cstr(buf, p + suffixW, true) : '');
    }
    if (!target && localOff) target = cstr(buf, p + localOff, false) + (suffixOff ? cstr(buf, p + suffixOff, false) : '');
    p += size;
  }
  const wide = !!(flags & UNICODE);
  const str = () => {
    if (p + 2 > buf.length) return '';
    const n = buf.readUInt16LE(p);
    const len = wide ? n * 2 : n;
    const s = wide ? buf.toString('utf16le', p + 2, p + 2 + len) : buf.toString('latin1', p + 2, p + 2 + len);
    p += 2 + len;
    return s;
  };
  const out = { target, args: '', workingDir: '', relativePath: '' };
  if (flags & HAS_NAME) str();
  if (flags & HAS_RELPATH) out.relativePath = str();
  if (flags & HAS_WORKDIR) out.workingDir = str();
  if (flags & HAS_ARGS) out.args = str();
  if (flags & HAS_ICON) str();
  return out.target || out.relativePath ? out : null;
}

async function read(file) {
  try { return parse(await fsp.readFile(file)); } catch { return null; }
}

/** Build a minimal .lnk (for tests): a LinkInfo with a Unicode local path, and optional arguments. */
function build(target, args = '') {
  const ansi = Buffer.from(`${target}\0`, 'latin1');
  const wide = Buffer.from(`${target}\0`, 'utf16le');
  const infoHeader = 0x24;
  const info = Buffer.alloc(infoHeader + ansi.length + 1 + wide.length + 2);
  info.writeUInt32LE(info.length, 0);
  info.writeUInt32LE(infoHeader, 4);
  info.writeUInt32LE(1, 8); // VolumeIDAndLocalBasePath
  info.writeUInt32LE(0, 12);
  info.writeUInt32LE(infoHeader, 16); // local base path (ANSI)
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(infoHeader + ansi.length, 24); // common suffix: empty
  info.writeUInt32LE(infoHeader + ansi.length + 1, 28); // local base path (Unicode)
  info.writeUInt32LE(0, 32);
  ansi.copy(info, infoHeader);
  wide.copy(info, infoHeader + ansi.length + 1);
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  header.writeUInt32LE(HAS_LINKINFO | UNICODE | (args ? HAS_ARGS : 0), 0x14);
  const parts = [header, info];
  if (args) { const n = Buffer.alloc(2); n.writeUInt16LE(args.length); parts.push(n, Buffer.from(args, 'utf16le')); }
  return Buffer.concat(parts);
}

module.exports = { parse, read, build };
