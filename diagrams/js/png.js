// PNG tEXt chunk read/write, keyword "cthDiagram" - the exact format CTH
// Film Room uses (main/videos.js), so a drill PNG exported here reopens
// fully editable in either app. Payload is base64(JSON) because tEXt is
// Latin-1 only.

export const DIAGRAM_KEY = 'cthDiagram';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(u8) {
  return u8.length > 8 && SIG.every((b, i) => u8[i] === b);
}

function* chunks(u8) {
  let off = 8;
  while (off + 8 <= u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset + off);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    yield { off, len, type, dataOff: off + 8 };
    off += 12 + len;
    if (type === 'IEND') break;
  }
}

// Read the embedded diagram state from a PNG's bytes, or null.
export function pngReadDiagram(u8) {
  if (!isPng(u8)) return null;
  for (const c of chunks(u8)) {
    if (c.type !== 'tEXt') continue;
    const data = u8.subarray(c.dataOff, c.dataOff + c.len);
    const nul = data.indexOf(0);
    if (nul < 0) continue;
    const key = String.fromCharCode(...data.subarray(0, nul));
    if (key !== DIAGRAM_KEY) continue;
    try {
      const b64 = String.fromCharCode(...data.subarray(nul + 1));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    } catch (_) { return null; }
  }
  return null;
}

// Return new PNG bytes with exactly one cthDiagram tEXt chunk.
export function pngSetDiagram(u8, state) {
  if (!isPng(u8)) throw new Error('Not a PNG');
  const json = new TextEncoder().encode(JSON.stringify(state));
  let b64 = '';
  for (let i = 0; i < json.length; i += 0x8000) b64 += String.fromCharCode(...json.subarray(i, i + 0x8000));
  b64 = btoa(b64);
  const keyBytes = new TextEncoder().encode(DIAGRAM_KEY);
  const payload = new Uint8Array(keyBytes.length + 1 + b64.length);
  payload.set(keyBytes, 0);
  payload[keyBytes.length] = 0;
  for (let i = 0; i < b64.length; i++) payload[keyBytes.length + 1 + i] = b64.charCodeAt(i);

  const typeBytes = [0x74, 0x45, 0x58, 0x74]; // tEXt
  const chunk = new Uint8Array(12 + payload.length);
  new DataView(chunk.buffer).setUint32(0, payload.length);
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  const crcInput = new Uint8Array(4 + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, 4);
  new DataView(chunk.buffer).setUint32(8 + payload.length, crc32(crcInput));

  // Rebuild: signature, every chunk except old cthDiagram tEXt, with our
  // chunk inserted right before IEND.
  const parts = [u8.subarray(0, 8)];
  for (const c of chunks(u8)) {
    if (c.type === 'tEXt') {
      const data = u8.subarray(c.dataOff, c.dataOff + c.len);
      const nul = data.indexOf(0);
      const key = nul >= 0 ? String.fromCharCode(...data.subarray(0, nul)) : '';
      if (key === DIAGRAM_KEY) continue;
    }
    if (c.type === 'IEND') parts.push(chunk);
    parts.push(u8.subarray(c.off, c.off + 12 + c.len));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function dataUrlToBytes(dataUrl) {
  const res = await fetch(dataUrl);
  return new Uint8Array(await res.arrayBuffer());
}

export function bytesToBlob(u8, type = 'image/png') {
  return new Blob([u8], { type });
}
