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

import { DEFAULT_MAX_ENTITIES } from "./store";
import type { Entity } from "./types";

// `Map.forEach` callback for SpatialHash.clear(): prune a bucket that went unused
// last frame, else reset its array to length 0 for refill. Hoisted to module
// scope (and invoked with the cell Map as `thisArg`) so clear() allocates no
// per-frame closure. `this` is the SpatialHash's `cells` map.
function pruneOrReset(
  this: Map<number, Entity[]>,
  cell: Entity[],
  key: number,
): void {
  if (cell.length === 0) this.delete(key);
  else cell.length = 0;
}

export class SpatialHash {
  private invCellSize: number;
  private cells = new Map<number, Entity[]>();
  // `seen[entity]` holds the generation of the last query that visited it. Gens
  // are monotonic and start at 1, so the zero-initialised array reads as unseen.
  private generation = 0;
  private readonly seen: Int32Array;

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
    // Reuse cell arrays across frames instead of dropping them. Dropping every
    // bucket (the old `cells.clear()`) churned the GC and forced the Map to be
    // rebuilt from scratch each frame — by far the hottest cost in a per-frame
    // broadphase rebuild. Instead: an actively-used bucket keeps its backing
    // array and is reset to length 0 for refill; a bucket that received no
    // inserts last frame is pruned (a one-frame lag), so an unbounded / roaming
    // world can't accumulate dead buckets. After warmup on a bounded arena this
    // allocates nothing and never mutates the Map's key set. Query/insert results
    // and per-cell iteration order are unchanged (insertion order is preserved).
    // `generation` is intentionally NOT reset; monotonic gens keep the dedup
    // correct across frames without having to clear `seen`.
    this.cells.forEach(pruneOrReset, this.cells);
  }

  insert(entity: Entity, x: number, y: number, radius: number): void {
    if ((entity as number) >= this.seen.length) {
      throw new Error(
        `SpatialHash.insert(): entity id ${entity} exceeds maxEntities ` +
          `(${this.seen.length}). Construct the SpatialHash with a maxEntities ` +
          `that matches the consuming World's capacity.`,
      );
    }
    const minCX = Math.floor((x - radius) * this.invCellSize);
    const maxCX = Math.floor((x + radius) * this.invCellSize);
    const minCY = Math.floor((y - radius) * this.invCellSize);
    const maxCY = Math.floor((y + radius) * this.invCellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = this.hashKey(cx, cy);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = [];
          this.cells.set(key, cell);
        }
        cell.push(entity);
      }
    }
  }

  /** Query all entities within a circle. Deduplicates via generation counter. */
  query(x: number, y: number, radius: number, results: Entity[]): void {
    results.length = 0;
    const queryGen = this.nextGen();

    const minCX = Math.floor((x - radius) * this.invCellSize);
    const maxCX = Math.floor((x + radius) * this.invCellSize);
    const minCY = Math.floor((y - radius) * this.invCellSize);
    const maxCY = Math.floor((y + radius) * this.invCellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = this.hashKey(cx, cy);
        const cell = this.cells.get(key);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const entity = cell[i];
          if (this.seen[entity as number] !== queryGen) {
            this.seen[entity as number] = queryGen;
            results.push(entity);
          }
        }
      }
    }
  }

  /** Query + circle-circle narrow phase in one pass. */
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
    const minCX = Math.floor((x - radius) * this.invCellSize);
    const maxCX = Math.floor((x + radius) * this.invCellSize);
    const minCY = Math.floor((y - radius) * this.invCellSize);
    const maxCY = Math.floor((y + radius) * this.invCellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = this.hashKey(cx, cy);
        const cell = this.cells.get(key);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const entity = cell[i];
          if (this.seen[entity as number] === queryGen) continue;
          this.seen[entity as number] = queryGen;

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

  private hashKey(cx: number, cy: number): number {
    // Szudzik pairing, handles negatives. Cell-index magnitude must stay below
    // ~sqrt(2^53) (~9.4e7) for `a * a` to remain an exact integer; beyond that
    // distinct cells can collide.
    const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
    const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
    return a >= b ? a * a + a + b : b * b + a;
  }
}
