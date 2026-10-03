// Spatial Hash: uniform grid broad phase
// Configurable cell size, a `queryRadius` broad-plus-narrow pass, and
// `queryCandidates`, the broad phase into a typed buffer for callers that run
// their own narrow phase. Result buffers are passed in by reference, so queries
// allocate nothing.
//
// `insert` only records the entity and the cell box it covers. The first read
// after a write files those records into one of two structures. Both answer
// every query with the same entities in the same order: cells by ascending cx,
// each column by ascending cy, each cell's entities in insertion order, and an
// entity reported at the first cell it is found in.
//
//   * The dense cell index lays the occupied cell rectangle out column-major as
//     offsets into one flat entity array, so the cells a query covers in one
//     column are a single contiguous run and a query is plain array reads. It is
//     rebuilt from the records, and serves whenever the rectangle is small
//     enough to lay out.
//   * The bucket map, keyed by Szudzik pairing so negative cells work, serves a
//     spread too wide or too far out for the dense index. Records are filed into
//     it incrementally, so it also answers reads interleaved with inserts; the
//     dense index is rebuilt only once a quarter of the records are new.
//
// Query dedup uses an `Int32Array` keyed by entity id plus a monotonic generation
// counter (no per-query Set or Map allocation). This runs ~2-3.7x faster than a
// `Map<Entity, number>` when one query runs per entity per frame, and a monotonic
// counter never collides. That avoids the false-negative a position-derived
// generation would risk: two queries at colliding positions could share a
// generation, so one would skip an entity the other already marked.
//
// Three occupancy structures keep a bucket-map query off cells nothing was filed
// into, all of them supersets of the true occupied set (so they can only skip
// cells that are provably empty, never change a result):
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

/** Records held before the record arrays first grow. */
const INITIAL_RECORDS = 64;
/** The most cells the dense index lays out. */
const DENSE_MAX_CELLS = 1 << 16;
/** Cells the dense index may lay out however few entries fill them, plus
 *  `DENSE_CELLS_PER_ENTRY` per filed entry, so a sparse spread does not rebuild
 *  and walk mostly empty cells. */
const DENSE_CELL_FLOOR = 4096;
const DENSE_CELLS_PER_ENTRY = 16;
/** The farthest cell coordinate the dense index covers: well inside the range
 *  where the bucket map's Szudzik keys are exact, so both find the same cells. */
const DENSE_MAX_COORD = 1 << 20;

/** A grid bucket. `e` is retained across frames and `n` is the live prefix length;
 *  `g` is the frame stamp, so a bucket from an earlier frame reads as empty. */
interface Cell {
  e: Entity[];
  n: number;
  g: number;
}

export class SpatialHash {
  private invCellSize: number;
  // `seen[entity]` holds the generation of the last query that visited it. Gens
  // are monotonic and start at 1, so the zero-initialised array reads as unseen.
  private generation = 0;
  private readonly seen: Int32Array;

  // This frame's inserts in order: the entity, and the cell box it covers as
  // `[minCX, maxCX, minCY, maxCY]` at `recBoxes[4 * i]`.
  private count = 0;
  private recEntities = new Int32Array(INITIAL_RECORDS);
  private recBoxes = new Float64Array(INITIAL_RECORDS * 4);

  // Dense cell index. `denseFor` is the record count it was built from, or -1
  // when it does not describe this frame; `triedAt` is the record count at this
  // frame's last build attempt, or -1 before the first.
  private denseFor = -1;
  private triedAt = -1;
  private minCX = 0;
  private minCY = 0;
  private cols = 0;
  private rows = 0;
  // Cell `c = (cx - minCX) * rows + (cy - minCY)` holds the entities
  // `cellEntities[cellStart[c]]` up to `cellEntities[cellStart[c + 1]]`.
  private cellStart = new Int32Array(1);
  private cellEntities = new Int32Array(0);
  private cellCursor = new Int32Array(0);
  // The dense span `cover` last clamped a query to: columns `spanX0..spanX1`
  // inclusive and rows `spanY0` up to `spanY1`, all relative to the index.
  private spanX0 = 0;
  private spanX1 = -1;
  private spanY0 = 0;
  private spanY1 = 0;

  // Bucket map. `filed` is how many of this frame's records it holds.
  private cells = new Map<number, Cell>();
  private filed = 0;
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
  /** Where a bucket-map `queryCandidates` collects before copying out. */
  private readonly candidates: Entity[] = [];

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
    // O(1): drop the records, and bump the frame stamp so every bucket, column
    // range and bounding box written by an earlier frame reads as empty. Nothing
    // is walked per frame. The cost is retention: a dead bucket is only
    // reclaimed by the periodic sweep, so an unbounded / roaming world holds the
    // buckets touched in the last 2 sweep periods rather than the last frame.
    // Per-cell push order and per-cell visit order are untouched, so a result
    // array keeps both its membership and its ORDER. `generation` is
    // deliberately NOT reset: monotonic gens are what keep the query dedup
    // correct across frames.
    this.count = 0;
    this.filed = 0;
    this.denseFor = -1;
    this.triedAt = -1;
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
    if ((entity as number) >= this.seen.length) {
      throw new Error(
        `SpatialHash.insert(): entity id ${entity} exceeds maxEntities ` +
          `(${this.seen.length}). Construct the SpatialHash with a maxEntities ` +
          `that matches the consuming World's capacity.`,
      );
    }
    const at = this.count;
    if (at === this.recEntities.length) this.growRecords();
    const inv = this.invCellSize;
    const box = this.recBoxes;
    const b = at * 4;
    this.recEntities[at] = entity;
    box[b] = Math.floor((x - radius) * inv);
    box[b + 1] = Math.floor((x + radius) * inv);
    box[b + 2] = Math.floor((y - radius) * inv);
    box[b + 3] = Math.floor((y + radius) * inv);
    this.count = at + 1;
  }

  /** Query all entities within a circle. Deduplicates via generation counter. */
  query(x: number, y: number, radius: number, results: Entity[]): void {
    if (!this.prepare()) {
      this.mapQuery(x, y, radius, results);
      return;
    }
    results.length = 0;
    if (!this.cover(x, y, radius)) return;
    const queryGen = this.nextGen();
    const seen = this.seen;
    const start = this.cellStart;
    const entities = this.cellEntities;
    const rows = this.rows;
    const y0 = this.spanY0;
    const y1 = this.spanY1;
    for (let cx = this.spanX0, last = this.spanX1; cx <= last; cx++) {
      const column = cx * rows;
      for (let k = start[column + y0], end = start[column + y1]; k < end; k++) {
        const entity = entities[k] as Entity;
        if (seen[entity] === queryGen) continue;
        seen[entity] = queryGen;
        results.push(entity);
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
    if (!this.prepare()) {
      this.mapQueryRadius(x, y, radius, getPos, getRadius, results);
      return;
    }
    results.length = 0;
    if (!this.cover(x, y, radius)) return;
    const queryGen = this.nextGen();
    const seen = this.seen;
    const start = this.cellStart;
    const entities = this.cellEntities;
    const rows = this.rows;
    const y0 = this.spanY0;
    const y1 = this.spanY1;
    for (let cx = this.spanX0, last = this.spanX1; cx <= last; cx++) {
      const column = cx * rows;
      for (let k = start[column + y0], end = start[column + y1]; k < end; k++) {
        const entity = entities[k] as Entity;
        if (seen[entity] === queryGen) continue;
        seen[entity] = queryGen;

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

  /**
   * Writes the entities `query` returns for this circle to `out`, in the same
   * order, and returns how many it wrote: each entity filed in a cell the
   * circle's bounding box overlaps, once, with no distance test. A caller that
   * runs its own narrow phase reads them back from a typed buffer, with no
   * callback per candidate and no array to grow.
   *
   * With `filter` and `stamp`, only entities with `filter[entity] === stamp`
   * are written, still in `query` order, and the rest are skipped before any
   * other work. Stamping the entities a caller cares about once per frame, and
   * bumping the stamp to empty the set, keeps a sparse narrow phase off the
   * bodies it would reject. `filter` must cover every entity id.
   *
   * `out` needs a slot for every entity written; one of `maxEntities` length
   * always has room. A shorter one that fills up throws a RangeError.
   */
  queryCandidates(
    x: number,
    y: number,
    radius: number,
    out: Int32Array,
  ): number;
  queryCandidates(
    x: number,
    y: number,
    radius: number,
    out: Int32Array,
    filter: Int32Array,
    stamp: number,
  ): number;
  queryCandidates(
    x: number,
    y: number,
    radius: number,
    out: Int32Array,
    filter?: Int32Array,
    stamp?: number,
  ): number {
    const cap = out.length;
    if (!this.prepare()) {
      const candidates = this.candidates;
      this.mapQuery(x, y, radius, candidates);
      let count = 0;
      for (let i = 0, n = candidates.length; i < n; i++) {
        const entity = candidates[i] as number;
        if (filter !== undefined && filter[entity] !== stamp) continue;
        if (count === cap) throw this.outFull(cap);
        out[count++] = entity;
      }
      return count;
    }
    if (!this.cover(x, y, radius)) return 0;
    const queryGen = this.nextGen();
    const seen = this.seen;
    const start = this.cellStart;
    const entities = this.cellEntities;
    const rows = this.rows;
    const y0 = this.spanY0;
    const y1 = this.spanY1;
    let count = 0;
    if (filter === undefined) {
      for (let cx = this.spanX0, last = this.spanX1; cx <= last; cx++) {
        const column = cx * rows;
        for (
          let k = start[column + y0], end = start[column + y1];
          k < end;
          k++
        ) {
          const entity = entities[k];
          if (seen[entity] === queryGen) continue;
          seen[entity] = queryGen;
          if (count === cap) throw this.outFull(cap);
          out[count++] = entity;
        }
      }
      return count;
    }
    for (let cx = this.spanX0, last = this.spanX1; cx <= last; cx++) {
      const column = cx * rows;
      for (let k = start[column + y0], end = start[column + y1]; k < end; k++) {
        const entity = entities[k];
        if (filter[entity] !== stamp) continue;
        if (seen[entity] === queryGen) continue;
        seen[entity] = queryGen;
        if (count === cap) throw this.outFull(cap);
        out[count++] = entity;
      }
    }
    return count;
  }

  private outFull(cap: number): RangeError {
    return new RangeError(
      `SpatialHash.queryCandidates(): out holds ${cap} ids and the circle ` +
        `covers more. Size it to maxEntities (${this.seen.length}).`,
    );
  }

  /**
   * Brings a read structure up to date with every insert: true to read the
   * dense index, false to read the bucket map. A rebuild re-reads every record,
   * so after a frame's first build attempt the next waits until a quarter of the
   * records are new, and reads in between take the incrementally filed map.
   */
  private prepare(): boolean {
    const count = this.count;
    if (this.denseFor === count) return true;
    const tried = this.triedAt;
    if (tried < 0 || (count - tried) * 4 >= count) {
      this.triedAt = count;
      if (this.buildDense()) {
        this.denseFor = count;
        return true;
      }
      this.denseFor = -1;
    }
    for (let i = this.filed; i < count; i++) this.file(i);
    this.filed = count;
    return false;
  }

  /**
   * Clamps the cell box around a query circle to the dense index, as spans
   * relative to it; false when the box covers no indexed cell.
   */
  private cover(x: number, y: number, radius: number): boolean {
    const inv = this.invCellSize;
    let x0 = Math.floor((x - radius) * inv) - this.minCX;
    let x1 = Math.floor((x + radius) * inv) - this.minCX;
    let y0 = Math.floor((y - radius) * inv) - this.minCY;
    let y1 = Math.floor((y + radius) * inv) - this.minCY;
    if (x0 < 0) x0 = 0;
    if (x1 >= this.cols) x1 = this.cols - 1;
    if (y0 < 0) y0 = 0;
    if (y1 >= this.rows) y1 = this.rows - 1;
    // Also false for a NaN box, which covers no cell.
    if (!(x0 <= x1 && y0 <= y1)) return false;
    this.spanX0 = x0;
    this.spanX1 = x1;
    this.spanY0 = y0;
    this.spanY1 = y1 + 1;
    return true;
  }

  /**
   * Lays this frame's records out as the dense cell index. False, leaving the
   * index as it was, when their spread is too wide or too far out to lay out.
   */
  private buildDense(): boolean {
    const count = this.count;
    const box = this.recBoxes;
    let minCX = 0;
    let maxCX = -1;
    let minCY = 0;
    let maxCY = -1;
    let entries = 0;
    for (let b = 0, end = count * 4; b < end; b += 4) {
      const x0 = box[b];
      const x1 = box[b + 1];
      const y0 = box[b + 2];
      const y1 = box[b + 3];
      // A NaN coordinate or a negative radius covers no cell.
      if (!(x0 <= x1 && y0 <= y1)) continue;
      if (maxCX < minCX) {
        minCX = x0;
        maxCX = x1;
        minCY = y0;
        maxCY = y1;
      } else {
        if (x0 < minCX) minCX = x0;
        if (x1 > maxCX) maxCX = x1;
        if (y0 < minCY) minCY = y0;
        if (y1 > maxCY) maxCY = y1;
      }
      entries += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
    const cols = maxCX - minCX + 1;
    const rows = maxCY - minCY + 1;
    const cells = cols * rows;
    if (
      entries > 0 &&
      !(
        cells <= DENSE_MAX_CELLS &&
        cells <= DENSE_CELL_FLOOR + DENSE_CELLS_PER_ENTRY * entries &&
        minCX > -DENSE_MAX_COORD &&
        maxCX < DENSE_MAX_COORD &&
        minCY > -DENSE_MAX_COORD &&
        maxCY < DENSE_MAX_COORD
      )
    ) {
      return false;
    }
    this.minCX = minCX;
    this.minCY = minCY;
    this.cols = cols;
    this.rows = rows;

    // Count each cell's entries one slot ahead, then prefix-sum the counts
    // into offsets, then place each record's entity at its cells' cursors.
    if (this.cellStart.length <= cells)
      this.cellStart = new Int32Array(cells + 1);
    if (this.cellCursor.length < cells) this.cellCursor = new Int32Array(cells);
    const start = this.cellStart;
    const cursor = this.cellCursor;
    start.fill(0, 0, cells + 1);
    for (let b = 0, end = count * 4; b < end; b += 4) {
      if (!(box[b] <= box[b + 1] && box[b + 2] <= box[b + 3])) continue;
      const x0 = (box[b] - minCX) | 0;
      const x1 = (box[b + 1] - minCX) | 0;
      const y0 = (box[b + 2] - minCY) | 0;
      const y1 = (box[b + 3] - minCY) | 0;
      for (let cx = x0; cx <= x1; cx++) {
        const column = cx * rows + 1;
        for (let cy = y0; cy <= y1; cy++) start[column + cy]++;
      }
    }
    for (let c = 0; c < cells; c++) {
      start[c + 1] += start[c];
      cursor[c] = start[c];
    }
    const total = start[cells];
    if (this.cellEntities.length < total) {
      this.cellEntities = new Int32Array(
        Math.max(total, this.cellEntities.length * 2),
      );
    }
    const out = this.cellEntities;
    const recEntities = this.recEntities;
    for (let i = 0, b = 0; i < count; i++, b += 4) {
      if (!(box[b] <= box[b + 1] && box[b + 2] <= box[b + 3])) continue;
      const entity = recEntities[i];
      const x0 = (box[b] - minCX) | 0;
      const x1 = (box[b + 1] - minCX) | 0;
      const y0 = (box[b + 2] - minCY) | 0;
      const y1 = (box[b + 3] - minCY) | 0;
      for (let cx = x0; cx <= x1; cx++) {
        const column = cx * rows;
        for (let cy = y0; cy <= y1; cy++) out[cursor[column + cy]++] = entity;
      }
    }
    return true;
  }

  private growRecords(): void {
    const size = this.recEntities.length * 2;
    const entities = new Int32Array(size);
    entities.set(this.recEntities);
    this.recEntities = entities;
    const boxes = new Float64Array(size * 4);
    boxes.set(this.recBoxes);
    this.recBoxes = boxes;
  }

  /** Files record `i` into the bucket map. */
  private file(i: number): void {
    const entity = this.recEntities[i] as Entity;
    const box = this.recBoxes;
    const b = i * 4;
    const minCX = box[b];
    const maxCX = box[b + 1];
    const minCY = box[b + 2];
    const maxCY = box[b + 3];
    const cells = this.cells;

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

  /** `query` over the bucket map. */
  private mapQuery(
    x: number,
    y: number,
    radius: number,
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
          if (seen[entity as number] !== queryGen) {
            seen[entity as number] = queryGen;
            results.push(entity);
          }
        }
      }
    }
  }

  /** `queryRadius` over the bucket map. */
  private mapQueryRadius(
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
