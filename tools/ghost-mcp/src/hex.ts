/** Parses hex text ("AA 55", "0xAA55", "aa:55") into bytes. Throws a readable Error on bad input. */
export function parseHex(input: string, maxBytes: number): Uint8Array {
  const cleaned = input.trim().replace(/0x/gi, '').replace(/[\s:,_-]/g, '');
  if (cleaned.length === 0) throw new Error('hex string is empty');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('hex string contains non-hex characters');
  if (cleaned.length % 2 !== 0) throw new Error('hex string has an odd number of digits');
  const length = cleaned.length / 2;
  if (length > maxBytes) throw new Error(`hex string is ${length} bytes; maximum is ${maxBytes}`);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic PRNG (mulberry32) for reproducible noise simulation. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
