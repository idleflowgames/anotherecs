// Deterministic, seedable PRNG for fuzz tests and benchmarks. The framework
// owns no RNG, so a test-local generator is appropriate; fixed seeds keep the
// property tests reproducible (no Math.random).

/** mulberry32: small, fast, well-distributed 32-bit PRNG. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function int(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}
