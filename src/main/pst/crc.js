'use strict';
// [MS-PST] 5.3: CRC-32 (reflected, polynomial 0xEDB88320) with a zero seed and no final XOR.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

function crc32(buf, start = 0, end = buf.length, seed = 0) {
  let crc = seed >>> 0;
  for (let i = start; i < end; i++) crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

// [MS-PST] 5.5: block/page signature.
function computeSig(ib, bid) {
  const x = Number((BigInt(ib) ^ BigInt(bid)) & 0xffffffffn);
  return ((x >>> 16) ^ x) & 0xffff;
}

module.exports = { crc32, computeSig };
