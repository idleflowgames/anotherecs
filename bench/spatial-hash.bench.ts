import { bench, describe } from "vitest";
import { type Entity, SpatialHash } from "../src/index";

// SpatialHash against the pre-occupancy implementation it replaced, over a whole
// broadphase frame: clear, re-insert every body, one wide query, then a burst of
// narrow-phase queries. A per-frame rebuild is the shape every consumer drives it
// in, so a micro-bench of `query` alone would miss where the time actually went
// (`clear` walking every bucket, and queries probing cells nothing occupies).

/** The previous implementation: eager per-frame bucket reset, no occupancy. */
class SpatialHashEager {
  private invCellSize: number;
  private cells = new Map<number, Entity[]>();
  private generation = 0;
  private readonly seen: Int32Array;
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
    this.cells.forEach(pruneOrReset, this.cells);
  }
  insert(entity: Entity, x: number, y: number, radius: number): void {
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
  query(x: number, y: number, radius: number, results: Entity[]): void {
    results.length = 0;
    const queryGen = this.nextGen();
    const minCX = Math.floor((x - radius) * this.invCellSize);
    const maxCX = Math.floor((x + radius) * this.invCellSize);
    const minCY = Math.floor((y - radius) * this.invCellSize);
    const maxCY = Math.floor((y + radius) * this.invCellSize);
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const cell = this.cells.get(this.hashKey(cx, cy));
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
        const cell = this.cells.get(this.hashKey(cx, cy));
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
          const combinedR = radius + r;
          if (dx * dx + dy * dy <= combinedR * combinedR) results.push(entity);
        }
      }
    }
  }
  private hashKey(cx: number, cy: number): number {
    const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
    const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
    return a >= b ? a * a + a + b : b * b + a;
  }
}

function pruneOrReset(
  this: Map<number, Entity[]>,
  cell: Entity[],
  key: number,
): void {
  if (cell.length === 0) this.delete(key);
  else cell.length = 0;
}

interface Broadphase {
  clear(): void;
  insert(e: Entity, x: number, y: number, r: number): void;
  query(x: number, y: number, r: number, out: Entity[]): void;
  queryRadius(
    x: number,
    y: number,
    r: number,
    getPos: (e: Entity) => { x: number; y: number } | undefined,
    getRadius: (e: Entity) => number,
    out: Entity[],
  ): void;
}

const CELL = 64;
const BODY_R = 9;
const ARENA = 1200;
const FRAMES = 60;
const NARROW_PER_FRAME = 16;

/** Deterministic LCG so both variants see the identical motion stream. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function frames(hash: Broadphase, count: number, wideRadius: number): number {
  const rnd = makeRng(0x51ed270);
  const pos: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) pos.push({ x: 0, y: 0 });
  const getPos = (e: Entity) => pos[e as number];
  const getRadius = () => BODY_R;
  const out: Entity[] = [];
  let sink = 0;
  for (let f = 0; f < FRAMES; f++) {
    hash.clear();
    for (let i = 0; i < count; i++) {
      const p = pos[i];
      p.x = rnd() * ARENA;
      p.y = rnd() * ARENA;
      hash.insert(i as Entity, p.x, p.y, BODY_R);
    }
    hash.query(ARENA / 2, ARENA / 2, wideRadius, out);
    sink += out.length;
    for (let q = 0; q < NARROW_PER_FRAME; q++) {
      hash.queryRadius(
        rnd() * ARENA,
        rnd() * ARENA,
        40,
        getPos,
        getRadius,
        out,
      );
      sink += out.length;
    }
  }
  return sink;
}

function scenario(name: string, count: number, maxEntities: number): void {
  describe(name, () => {
    const eager = new SpatialHashEager(CELL, maxEntities);
    const current = new SpatialHash(CELL, maxEntities);
    bench("eager per-frame reset (previous)", () => {
      frames(eager, count, 340);
    });
    bench("occupancy-accelerated (current)", () => {
      frames(current, count, 340);
    });
  });
}

scenario("broadphase frame: 50 bodies", 50, 64);
scenario("broadphase frame: 250 bodies", 250, 256);
scenario("broadphase frame: 1000 bodies", 1000, 1024);
