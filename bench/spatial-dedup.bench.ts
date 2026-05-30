import { bench, describe } from "vitest";
import { type Entity, SpatialHash } from "../src/index";

// SpatialHash's Int32Array dedup compared with a Map<Entity, number> baseline.
// Models a broad phase: insert once, then one neighbourhood query per entity.

class SpatialHashMapDedup {
  private invCell: number;
  private cells = new Map<number, Entity[]>();
  private generation = 0;
  private entityGeneration = new Map<Entity, number>();
  constructor(cellSize: number) {
    this.invCell = 1 / cellSize;
  }
  insert(e: Entity, x: number, y: number, r: number): void {
    const minX = Math.floor((x - r) * this.invCell);
    const maxX = Math.floor((x + r) * this.invCell);
    const minY = Math.floor((y - r) * this.invCell);
    const maxY = Math.floor((y + r) * this.invCell);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const k = this.key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) {
          cell = [];
          this.cells.set(k, cell);
        }
        cell.push(e);
      }
    }
  }
  query(x: number, y: number, r: number, out: Entity[]): void {
    out.length = 0;
    const g = (this.generation + (x * 73856093 + y * 19349663)) | 0;
    const minX = Math.floor((x - r) * this.invCell);
    const maxX = Math.floor((x + r) * this.invCell);
    const minY = Math.floor((y - r) * this.invCell);
    const maxY = Math.floor((y + r) * this.invCell);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if (this.entityGeneration.get(e) !== g) {
            this.entityGeneration.set(e, g);
            out.push(e);
          }
        }
      }
    }
  }
  private key(cx: number, cy: number): number {
    const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
    const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
    return a >= b ? a * a + a + b : b * b + a;
  }
}

function scenario(name: string, numEntities: number, maxEnt: number) {
  const real = new SpatialHash(64, maxEnt);
  const old = new SpatialHashMapDedup(64);
  const pos: { x: number; y: number }[] = [];
  for (let i = 0; i < numEntities; i++) {
    const x = (i % 100) * 30;
    const y = Math.floor(i / 100) * 30;
    pos.push({ x, y });
    real.insert(i as Entity, x, y, 8);
    old.insert(i as Entity, x, y, 8);
  }
  const out: Entity[] = [];
  describe(name, () => {
    bench("SpatialHash (Map dedup baseline)", () => {
      for (let i = 0; i < numEntities; i++)
        old.query(pos[i].x, pos[i].y, 40, out);
    });
    bench("SpatialHash (Int32Array dedup, current)", () => {
      for (let i = 0; i < numEntities; i++)
        real.query(pos[i].x, pos[i].y, 40, out);
    });
  });
}

scenario("small: 50 entities", 50, 64);
scenario("large: 1000 entities", 1000, 1024);
