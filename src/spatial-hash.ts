// Spatial Hash: uniform grid broad phase
// Configurable cell size, Szudzik pairing for negative coordinates, and a
// `queryRadius` broad-plus-narrow pass. Result arrays are passed in by reference,
// so queries allocate nothing.
//
// Query dedup uses an `Int32Array` keyed by entity id plus a monotonic generation
// counter (no per-query Set or Map allocation). This runs ~2-3.7x faster than a
// `Map<Entity, number>` when one query runs per entity per frame, and a monotonic
// counter never collides. That avoids the false-negative a position-derived
// generation would risk: two queries at colliding positions could share a
// generation, so one would skip an entity the other already marked.
//
// Three occupancy structures keep a query off cells nothing was inserted into, all
// of them supersets of the true occupied set (so they can only skip cells that are
// provably empty, never change a result):
//   * the frame stamp on each bucket, which makes `clear()` O(1);
//   * the occupied bounding box, which clamps a query's cell span;
//   * the per-column occupied row range, which clamps it again per column.

import { DEFAULT_MAX_ENTITIES } from "./store";
import type { Entity } from "./types";

/** Direct-mapped column slots, indexed `cx & COL_MASK`. Aliasing two columns onto
 *  one slot merges their row ranges, which is a superset, so results are unchanged. */
const COL_SLOTS = 256;
const COL_MASK = COL_SLOTS - 1;
/** Clears between prunes. A bucket survives up to 2x this many idle frames. */
const SWEEP_PERIOD = 64;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/** A grid bucket. `e` is retained across frames and `n` is the live prefix length;
 *  `g` is the frame stamp, so a bucket from an earlier frame reads as empty. */
interface Cell {
  e: Entity[];
  n: number;
  g: number;
}

export class SpatialHash {
  private invCellSize: number;
  private cells = new Map<number, Cell>();
  // `seen[entity]` holds the generation of the last query that visited it. Gens
  // are monotonic and start at 1, so the zero-initialised array reads as unseen.
  private generation = 0;
  private readonly seen: Int32Array;
  // Occupied bounding box in cell coordinates for the current frame; empty while
  // `occMaxCX < occMinCX`, which collapses every query's cell span to nothing.
  private occMinCX = 0;
  private occMaxCX = -1;
  private occMinCY = 0;
  private occMaxCY = -1;
  // Per column: [frame stamp, min occupied cy, max occupied cy].
  private readonly col = new Int32Array(COL_SLOTS * 3);
  // Frame stamp, never 0 (0 is the zero-filled "never written" reading of `col`)
  // and never past I32_MAX, so it stays a Smi and matches `col`'s int32 domain.
  private frameGen = 1;
  private sweepIn = SWEEP_PERIOD;

  /**
   * @param cellSize    grid cell size in world units. Must be > 0.
   * @param maxEntities upper bound on entity ids inserted (sizes the dedup
   *   array, `maxEntities * 4` bytes). Match the consuming World's capacity.
   */
  constructor(cellSize = 64, maxEntities: number = DEFAULT_MAX_ENTITIES) {
    if (!(cellSize > 0)) {
      throw new Error(`SpatialHash: cellSize must be > 0 (got ${cellSize})`);
    }
    this.invCellSize = 1 / cellSize;
    this.seen = new Int32Array(maxEntities);
  }

  // `| 0` keeps the counter in the same int32 domain as `seen`; skip 0 (= unseen).
  private nextGen(): number {
    this.generation = (this.generation + 1) | 0;
    if (this.generation === 0) this.generation = 1;
    return this.generation;
  }

  clear(): void {
    // O(1): bump the frame stamp, and every bucket, column range and bounding box
    // written by an earlier frame reads as empty. Nothing is walked per frame.
    // The cost is retention: a dead bucket is only reclaimed by the periodic
    // sweep, so an unbounded / roaming world holds the buckets touched in the last
    // 2 sweep periods rather than the last frame. Per-cell push order and per-cell
    // visit order are untouched, so a result array keeps both its membership and
    // its ORDER. `generation` is deliberately NOT reset: monotonic gens are what
    // keep the query dedup correct across frames.
    this.occMinCX = 0;
    this.occMaxCX = -1;
    this.occMinCY = 0;
    this.occMaxCY = -1;
    const fg = this.frameGen + 1;
    if (fg >= I32_MAX) {
      // Wrap. Every stamp restarts, so nothing may survive carrying an old one.
      this.cells.clear();
      this.col.fill(0);
      this.frameGen = 1;
      this.sweepIn = SWEEP_PERIOD;
      return;
    }
    this.frameGen = fg;
    if (--this.sweepIn <= 0) {
      this.sweepIn = SWEEP_PERIOD;
      this.cells.forEach(this.pruneStale, this);
    }
  }

  /** `Map.forEach` callback for the periodic sweep, invoked with the hash as
   *  `thisArg` so it allocates no per-sweep closure. */
  private pruneStale(cell: Cell, key: number): void {
    if (this.frameGen - cell.g >= SWEEP_PERIOD) this.cells.delete(key);
  }

  insert(entity: Entity, x: number, y: number, radius: number): void {
    const seen = this.seen;
    if ((entity as number) >= seen.length) {
      throw new Error(
        `SpatialHash.insert(): entity id ${entity} exceeds maxEntities ` +
          `(${seen.length}). Construct the SpatialHash with a maxEntities ` +
          `that matches the consuming World's capacity.`,
      );
    }
    const cells = this.cells;
    const inv = this.invCellSize;
    const minCX = Math.floor((x - radius) * inv);
    const maxCX = Math.floor((x + radius) * inv);
    const minCY = Math.floor((y - radius) * inv);
    const maxCY = Math.floor((y + radius) * inv);

    if (this.occMaxCX < this.occMinCX) {
      this.occMinCX = minCX;
      this.occMaxCX = maxCX;
      this.occMinCY = minCY;
      this.occMaxCY = maxCY;
    } else {
      if (minCX < this.occMinCX) this.occMinCX = minCX;
      if (maxCX > this.occMaxCX) this.occMaxCX = maxCX;
      if (minCY < this.occMinCY) this.occMinCY = minCY;
      if (maxCY > this.occMaxCY) this.occMaxCY = maxCY;
    }

    const col = this.col;
    const fg = this.frameGen;
    // `col` is int32, so a row index past that domain is stored WIDENED to the
    // domain edge. Widening keeps the stored range a superset; truncating it
    // would wrap into a narrower range and drop results.
    const cLo = minCY < I32_MIN ? I32_MIN : minCY;
    const cHi = maxCY > I32_MAX ? I32_MAX : maxCY;

    for (let cx = minCX; cx <= maxCX; cx++) {
      const ci = (cx & COL_MASK) * 3;
      if (col[ci] !== fg) {
        col[ci] = fg;
        col[ci + 1] = cLo;
        col[ci + 2] = cHi;
      } else {
        if (cLo < col[ci + 1]) col[ci + 1] = cLo;
        if (cHi > col[ci + 2]) col[ci + 2] = cHi;
      }
      // Szudzik pairing, which handles negatives. `a` and `a * a + a` depend only
      // on cx, so both are hoisted out of the cy loop. Cell-index magnitude must
      // stay below ~sqrt(2^53) (~9.4e7) for `a * a` to remain an exact integer;
      // beyond that distinct cells collide.
      const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
      const aa = a * a + a;
      for (let cy = minCY; cy <= maxCY; cy++) {
        const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
        const key = a >= b ? aa + b : b * b + a;
        let cell = cells.get(key);
        if (cell === undefined) {
          cell = { e: [], n: 0, g: fg };
          cells.set(key, cell);
        } else if (cell.g !== fg) {
          cell.g = fg;
          cell.n = 0;
        }
        const n = cell.n;
        const items = cell.e;
        if (n < items.length) items[n] = entity;
        else items.push(entity);
        cell.n = n + 1;
      }
    }
  }

  /** Query all entities within a circle. Deduplicates via generation counter. */
  query(x: number, y: number, radius: number, results: Entity[]): void {
    results.length = 0;
    const queryGen = this.nextGen();
    const cells = this.cells;
    const seen = this.seen;
    const inv = this.invCellSize;

    let minCX = Math.floor((x - radius) * inv);
    let maxCX = Math.floor((x + radius) * inv);
    let minCY = Math.floor((y - radius) * inv);
    let maxCY = Math.floor((y + radius) * inv);
    if (minCX < this.occMinCX) minCX = this.occMinCX;
    if (maxCX > this.occMaxCX) maxCX = this.occMaxCX;
    if (minCY < this.occMinCY) minCY = this.occMinCY;
    if (maxCY > this.occMaxCY) maxCY = this.occMaxCY;

    const col = this.col;
    const fg = this.frameGen;
    for (let cx = minCX; cx <= maxCX; cx++) {
      const ci = (cx & COL_MASK) * 3;
      if (col[ci] !== fg) continue;
      let cyLo = minCY;
      let cyHi = maxCY;
      if (cyLo < col[ci + 1]) cyLo = col[ci + 1];
      if (cyHi > col[ci + 2]) cyHi = col[ci + 2];
      const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
      const aa = a * a + a;
      for (let cy = cyLo; cy <= cyHi; cy++) {
        const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
        const cell = cells.get(a >= b ? aa + b : b * b + a);
        if (cell === undefined || cell.g !== fg) continue;
        const items = cell.e;
        for (let i = 0, n = cell.n; i < n; i++) {
          const entity = items[i];
          if (seen[entity as number] !== queryGen) {
            seen[entity as number] = queryGen;
            results.push(entity);
          }
        }
      }
    }
  }

  /** Query + circle-circle narrow phase in one pass. `getPos` and `getRadius` are
   *  called once per candidate and must not mutate the hash. */
  queryRadius(
    x: number,
    y: number,
    radius: number,
    getPos: (e: Entity) => { x: number; y: number } | undefined,
    getRadius: (e: Entity) => number,
    results: Entity[],
  ): void {
    results.length = 0;
    const queryGen = this.nextGen();
    const cells = this.cells;
    const seen = this.seen;
    const inv = this.invCellSize;

    let minCX = Math.floor((x - radius) * inv);
    let maxCX = Math.floor((x + radius) * inv);
    let minCY = Math.floor((y - radius) * inv);
    let maxCY = Math.floor((y + radius) * inv);
    if (minCX < this.occMinCX) minCX = this.occMinCX;
    if (maxCX > this.occMaxCX) maxCX = this.occMaxCX;
    if (minCY < this.occMinCY) minCY = this.occMinCY;
    if (maxCY > this.occMaxCY) maxCY = this.occMaxCY;

    const col = this.col;
    const fg = this.frameGen;
    for (let cx = minCX; cx <= maxCX; cx++) {
      const ci = (cx & COL_MASK) * 3;
      if (col[ci] !== fg) continue;
      let cyLo = minCY;
      let cyHi = maxCY;
      if (cyLo < col[ci + 1]) cyLo = col[ci + 1];
      if (cyHi > col[ci + 2]) cyHi = col[ci + 2];
      const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
      const aa = a * a + a;
      for (let cy = cyLo; cy <= cyHi; cy++) {
        const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
        const cell = cells.get(a >= b ? aa + b : b * b + a);
        if (cell === undefined || cell.g !== fg) continue;
        const items = cell.e;
        for (let i = 0, n = cell.n; i < n; i++) {
          const entity = items[i];
          if (seen[entity as number] === queryGen) continue;
          seen[entity as number] = queryGen;

          const pos = getPos(entity);
          if (!pos) continue;
          const r = getRadius(entity);
          const dx = pos.x - x;
          const dy = pos.y - y;
          const distSq = dx * dx + dy * dy;
          const combinedR = radius + r;
          if (distSq <= combinedR * combinedR) {
            results.push(entity);
          }
        }
      }
    }
  }
}
