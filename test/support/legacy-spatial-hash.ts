import type { Entity } from "../../src/types";

// The 0.1.7 `SpatialHash`, frozen as the oracle for the dense cell index: every
// insert files into a Szudzik-keyed bucket map, and every query walks the map
// clamped by the occupied bounding box and per-column row ranges. The current
// hash must answer every query exactly as this one does, in the same order.

const COL_SLOTS = 256;
const COL_MASK = COL_SLOTS - 1;
const SWEEP_PERIOD = 64;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

interface Cell {
  e: Entity[];
  n: number;
  g: number;
}

export class LegacySpatialHash {
  private invCellSize: number;
  private cells = new Map<number, Cell>();
  private generation = 0;
  private readonly seen: Int32Array;
  private occMinCX = 0;
  private occMaxCX = -1;
  private occMinCY = 0;
  private occMaxCY = -1;
  private readonly col = new Int32Array(COL_SLOTS * 3);
  private frameGen = 1;
  private sweepIn = SWEEP_PERIOD;

  constructor(cellSize: number, maxEntities: number) {
    this.invCellSize = 1 / cellSize;
    this.seen = new Int32Array(maxEntities);
  }

  private nextGen(): number {
    this.generation = (this.generation + 1) | 0;
    if (this.generation === 0) this.generation = 1;
    return this.generation;
  }

  clear(): void {
    this.occMinCX = 0;
    this.occMaxCX = -1;
    this.occMinCY = 0;
    this.occMaxCY = -1;
    const fg = this.frameGen + 1;
    if (fg >= I32_MAX) {
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

  private pruneStale(cell: Cell, key: number): void {
    if (this.frameGen - cell.g >= SWEEP_PERIOD) this.cells.delete(key);
  }

  insert(entity: Entity, x: number, y: number, radius: number): void {
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
