// Bitmask: opt-in per-entity component signature index
// Enabled per World via `enableBitmask()`. A derived mirror of dense-store
// membership that accelerates O(1) `hasMask` / O(words) `hasAllMask` tests; the
// dense stores remain the data home. set/clear are idempotent, commutative bit
// ops, so a row's final state depends only on which (entity, component) pairs are
// members, never the order they were applied.
//
// Layout: `rows` is one flat Uint32Array of `capacity * wordsPerEntity`; entity
// `e` owns `[e * words, (e + 1) * words)`. `words` grows lazily as higher
// component ids are first set, keeping the common small-id case at 1–2 words.
// Component ids are assigned at module load, so width stabilizes after the first
// back-fill and never changes on the per-frame path.

export class Bitmask {
  private readonly capacity: number;
  private words = 1;
  private rows: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.rows = new Uint32Array(capacity * 1);
  }

  /** Current words per entity (>= 1). */
  get wordsPerEntity(): number {
    return this.words;
  }

  // Grow the per-entity stride so `compId` is addressable, re-laying-out every
  // existing row at the wider stride. Only triggers when a never-before-seen
  // high component id is first set, never on the hot path.
  private ensureWidth(compId: number): void {
    const need = (compId >>> 5) + 1;
    if (need <= this.words) return;
    const next = new Uint32Array(this.capacity * need);
    const old = this.words;
    for (let e = 0; e < this.capacity; e++) {
      next.set(this.rows.subarray(e * old, (e + 1) * old), e * need);
    }
    this.rows = next;
    this.words = need;
  }

  /** Set bit `compId` for entity `e`. Grows word width if needed. */
  set(e: number, compId: number): void {
    this.ensureWidth(compId);
    this.rows[e * this.words + (compId >>> 5)] |= (1 << (compId & 31)) >>> 0;
  }

  /** Clear bit `compId` for entity `e`. */
  clear(e: number, compId: number): void {
    const w = compId >>> 5;
    if (w >= this.words) return;
    this.rows[e * this.words + w] &= ~((1 << (compId & 31)) >>> 0);
  }

  /** Test bit `compId` for entity `e`. */
  has(e: number, compId: number): boolean {
    const w = compId >>> 5;
    if (w >= this.words) return false;
    return (this.rows[e * this.words + w] & ((1 << (compId & 31)) >>> 0)) !== 0;
  }

  /** Clear every bit for entity `e` (despawn path). */
  clearEntity(e: number): void {
    this.rows.fill(0, e * this.words, (e + 1) * this.words);
  }

  /**
   * Build a packed query signature: the OR of each def's single bit, sized to
   * span the highest component id in `compIds`. Bit positions are static per
   * component id, so the returned signature is valid forever and can be cached.
   */
  signature(compIds: readonly number[]): Uint32Array {
    let maxWord = 0;
    for (let i = 0; i < compIds.length; i++) {
      const w = compIds[i] >>> 5;
      if (w > maxWord) maxWord = w;
    }
    const sig = new Uint32Array(maxWord + 1);
    for (let i = 0; i < compIds.length; i++) {
      const id = compIds[i];
      sig[id >>> 5] |= (1 << (id & 31)) >>> 0;
    }
    return sig;
  }

  /** Whether entity `e`'s row has all bits in `sig` set. */
  hasAll(e: number, sig: Uint32Array): boolean {
    for (let w = 0; w < sig.length; w++) {
      const want = sig[w];
      if (want === 0) continue;
      if (w >= this.words) return false;
      // `>>> 0` normalizes the AND result to unsigned: a component on bit 31 of
      // its word makes `want` include 0x80000000, and JS `&` yields a SIGNED
      // int32, so without this the masked value compares as negative and a true
      // match wrongly returns false. `want` is already unsigned (Uint32Array).
      if ((this.rows[e * this.words + w] & want) >>> 0 !== want) return false;
    }
    return true;
  }
}
