/** CRC-32 (IEEE 802.3): reflected polynomial 0xEDB88320, init and final XOR 0xFFFFFFFF. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Computes CRC-32 over `bytes[start, end)`. Returns an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array, start = 0, end: number = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
