import { beforeEach, describe, expect, it } from "vitest";
import { type Entity, SpatialHash } from "../src/index";

function eid(n: number): Entity {
  return n as Entity;
}

let hash: SpatialHash;

beforeEach(() => {
  hash = new SpatialHash(64);
});

describe("Basic insert and query", () => {
  it("insert and retrieve a single entity", () => {
    hash.insert(eid(1), 100, 100, 5);
    const results: Entity[] = [];
    hash.query(100, 100, 10, results);
    expect(results).toContain(eid(1));
  });

  it("query returns empty for empty hash", () => {
    const results: Entity[] = [];
    hash.query(0, 0, 100, results);
    expect(results).toHaveLength(0);
  });

  it("query clears results array before populating", () => {
    hash.insert(eid(1), 100, 100, 5);
    const results: Entity[] = [eid(99)];
    hash.query(100, 100, 10, results);
    expect(results).not.toContain(eid(99));
    expect(results).toContain(eid(1));
  });

  it("entity outside query range is not returned", () => {
    hash.insert(eid(1), 0, 0, 5);
    const results: Entity[] = [];
    hash.query(500, 500, 10, results);
    expect(results).toHaveLength(0);
  });

  it("multiple entities in same cell", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.insert(eid(2), 15, 15, 5);
    const results: Entity[] = [];
    hash.query(12, 12, 20, results);
    expect(results).toContain(eid(1));
    expect(results).toContain(eid(2));
  });

  it("entity at query boundary is included", () => {
    hash.insert(eid(1), 64, 0, 5);
    const results: Entity[] = [];
    hash.query(0, 0, 70, results);
    expect(results).toContain(eid(1));
  });
});

describe("Deduplication", () => {
  it("entity spanning multiple cells appears only once", () => {
    hash.insert(eid(1), 32, 32, 50);
    const results: Entity[] = [];
    hash.query(32, 32, 60, results);
    expect(results.filter((e) => e === eid(1))).toHaveLength(1);
  });

  it("two sequential queries produce independent results", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.insert(eid(2), 200, 200, 5);

    const r1: Entity[] = [];
    hash.query(10, 10, 20, r1);
    expect(r1).toContain(eid(1));
    expect(r1).not.toContain(eid(2));

    const r2: Entity[] = [];
    hash.query(200, 200, 20, r2);
    expect(r2).toContain(eid(2));
    expect(r2).not.toContain(eid(1));
  });

  it("entity inserted twice still appears once (query dedup)", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.insert(eid(1), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results.filter((e) => e === eid(1))).toHaveLength(1);
  });
});

describe("Negative coordinates (Szudzik pairing)", () => {
  it("insert and query at negative coordinates", () => {
    hash.insert(eid(1), -100, -200, 5);
    const results: Entity[] = [];
    hash.query(-100, -200, 10, results);
    expect(results).toContain(eid(1));
  });

  it("negative and positive entities are independent", () => {
    hash.insert(eid(1), -50, -50, 5);
    hash.insert(eid(2), 50, 50, 5);
    const r1: Entity[] = [];
    hash.query(-50, -50, 10, r1);
    expect(r1).toContain(eid(1));
    expect(r1).not.toContain(eid(2));
  });

  it("origin entity (0,0) is queryable", () => {
    hash.insert(eid(1), 0, 0, 5);
    const results: Entity[] = [];
    hash.query(0, 0, 10, results);
    expect(results).toContain(eid(1));
  });
});

describe("Clear", () => {
  it("clear removes all entities", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.insert(eid(2), 100, 100, 5);
    hash.clear();
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results).toHaveLength(0);
    hash.query(100, 100, 20, results);
    expect(results).toHaveLength(0);
  });

  it("insert after clear works correctly", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.clear();
    hash.insert(eid(2), 20, 20, 5);
    const results: Entity[] = [];
    hash.query(20, 20, 10, results);
    expect(results).toContain(eid(2));
    expect(results).not.toContain(eid(1));
  });
});

describe("Radius edge cases", () => {
  it("zero radius insert occupies single cell", () => {
    hash.insert(eid(1), 32, 32, 0);
    const results: Entity[] = [];
    hash.query(32, 32, 5, results);
    expect(results).toContain(eid(1));
  });

  it("large radius insert spans many cells", () => {
    hash.insert(eid(1), 0, 0, 200);
    const results: Entity[] = [];
    hash.query(150, 0, 10, results);
    expect(results).toContain(eid(1));
  });
});

describe("queryRadius (narrow-phase)", () => {
  const positions = new Map<Entity, { x: number; y: number }>();
  const radii = new Map<Entity, number>();

  function getPos(e: Entity) {
    return positions.get(e);
  }
  function getRadius(e: Entity) {
    return radii.get(e) ?? 0;
  }

  beforeEach(() => {
    positions.clear();
    radii.clear();
  });

  it("returns entity within circle-circle range", () => {
    positions.set(eid(1), { x: 10, y: 0 });
    radii.set(eid(1), 5);
    hash.insert(eid(1), 10, 0, 5);
    const results: Entity[] = [];
    hash.queryRadius(0, 0, 20, getPos, getRadius, results);
    expect(results).toContain(eid(1));
  });

  it("excludes entity outside range", () => {
    positions.set(eid(1), { x: 100, y: 0 });
    radii.set(eid(1), 5);
    hash.insert(eid(1), 100, 0, 5);
    const results: Entity[] = [];
    hash.queryRadius(0, 0, 10, getPos, getRadius, results);
    expect(results).toHaveLength(0);
  });

  it("includes touching circles at the boundary", () => {
    positions.set(eid(1), { x: 20, y: 0 });
    radii.set(eid(1), 5);
    hash.insert(eid(1), 20, 0, 5);
    const results: Entity[] = [];
    hash.queryRadius(0, 0, 15, getPos, getRadius, results);
    expect(results).toContain(eid(1));
  });

  it("skips entity when getPos returns undefined", () => {
    hash.insert(eid(1), 10, 10, 5);
    const results: Entity[] = [];
    hash.queryRadius(10, 10, 20, getPos, getRadius, results);
    expect(results).toHaveLength(0);
  });

  it("deduplicates entities spanning multiple cells", () => {
    positions.set(eid(1), { x: 32, y: 32 });
    radii.set(eid(1), 40);
    hash.insert(eid(1), 32, 32, 40);
    const results: Entity[] = [];
    hash.queryRadius(32, 32, 50, getPos, getRadius, results);
    expect(results.filter((e) => e === eid(1))).toHaveLength(1);
  });

  it("returns only colliding entities", () => {
    positions.set(eid(1), { x: 10, y: 0 });
    radii.set(eid(1), 5);
    hash.insert(eid(1), 10, 0, 5);
    positions.set(eid(2), { x: 500, y: 0 });
    radii.set(eid(2), 5);
    hash.insert(eid(2), 500, 0, 5);
    positions.set(eid(3), { x: 15, y: 0 });
    radii.set(eid(3), 5);
    hash.insert(eid(3), 15, 0, 5);
    const results: Entity[] = [];
    hash.queryRadius(0, 0, 20, getPos, getRadius, results);
    expect(results).toContain(eid(1));
    expect(results).toContain(eid(3));
    expect(results).not.toContain(eid(2));
  });
});

describe("Cell size variations", () => {
  it("small cell size (1px)", () => {
    const small = new SpatialHash(1);
    small.insert(eid(1), 5, 5, 2);
    const results: Entity[] = [];
    small.query(5, 5, 3, results);
    expect(results).toContain(eid(1));
  });

  it("large cell size (1000px) groups distant entities in broad phase", () => {
    const big = new SpatialHash(1000);
    big.insert(eid(1), 100, 100, 5);
    big.insert(eid(2), 800, 800, 5);
    const results: Entity[] = [];
    big.query(100, 100, 10, results);
    expect(results).toContain(eid(1));
    expect(results).toContain(eid(2));
  });
});

describe("Stress", () => {
  it("handles 1000 entities with no duplicates", () => {
    for (let i = 0; i < 1000; i++) hash.insert(eid(i), i * 10, i * 10, 5);
    const results: Entity[] = [];
    hash.query(500, 500, 50, results);
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results).size).toBe(results.length);
  });
});

describe("Generation counter int32 boundary", () => {
  it("dedup holds when the generation counter crosses 2^31", () => {
    (hash as unknown as { generation: number }).generation = 2 ** 31 - 2;
    hash.insert(eid(1), 32, 32, 50); // spans multiple cells -> relies on dedup
    for (let i = 0; i < 5; i++) {
      const results: Entity[] = [];
      hash.query(32, 32, 60, results);
      expect(results.filter((e) => e === eid(1))).toHaveLength(1);
    }
  });
});

describe("Bounds and validation", () => {
  it("insert throws for an id at/over capacity", () => {
    const h = new SpatialHash(64, 16);
    expect(() => h.insert(eid(16), 0, 0, 1)).toThrow(/exceeds maxEntities/);
    expect(() => h.insert(eid(15), 0, 0, 1)).not.toThrow();
  });

  it("constructor throws for non-positive or NaN cellSize", () => {
    expect(() => new SpatialHash(0)).toThrow(/cellSize must be > 0/);
    expect(() => new SpatialHash(-5)).toThrow(/cellSize must be > 0/);
    expect(() => new SpatialHash(Number.NaN)).toThrow(/cellSize must be > 0/);
  });
});

// ---------------------------------------------------------------------------
// Occupancy acceleration. `clear()` is O(1) (a frame stamp), and queries clamp
// their cell span to an occupied bounding box plus a per-column row range. Each
// of those is a superset of the true occupied set, so none of them may change a
// result; these tests pin that against the cases where a superset could slip.
// ---------------------------------------------------------------------------

describe("Frame-stamped clear", () => {
  it("a bucket refilled after clear holds only the new frame's entities", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.insert(eid(2), 12, 12, 5);
    hash.clear();
    hash.insert(eid(3), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results).toEqual([eid(3)]);
  });

  it("a bucket left untouched by the new frame reads as empty", () => {
    hash.insert(eid(1), 10, 10, 5);
    hash.clear();
    hash.insert(eid(2), 500, 500, 5);
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results).toHaveLength(0);
  });

  it("repeated clear/insert cycles never leak an earlier frame", () => {
    for (let frame = 0; frame < 20; frame++) {
      hash.clear();
      hash.insert(eid(frame), 10, 10, 5);
      const results: Entity[] = [];
      hash.query(10, 10, 20, results);
      expect(results).toEqual([eid(frame)]);
    }
  });

  it("survives more clears than the internal sweep period", () => {
    for (let frame = 0; frame < 400; frame++) {
      hash.clear();
      hash.insert(eid(1), 10 + (frame % 7) * 64, 10, 5);
      const results: Entity[] = [];
      hash.query(10 + (frame % 7) * 64, 10, 20, results);
      expect(results).toEqual([eid(1)]);
    }
  });

  it("the frame stamp wrapping resets cleanly", () => {
    hash.insert(eid(1), 10, 10, 5);
    (hash as unknown as { frameGen: number }).frameGen = 2147483645;
    hash.clear();
    hash.insert(eid(2), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results).toEqual([eid(2)]);
    hash.clear();
    hash.insert(eid(3), 10, 10, 5);
    hash.query(10, 10, 20, results);
    expect(results).toEqual([eid(3)]);
  });
});

describe("Occupied-span clamping", () => {
  it("a query far outside the occupied box returns nothing", () => {
    hash.insert(eid(1), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(10000, 10000, 50, results);
    expect(results).toHaveLength(0);
  });

  it("a query straddling the edge of the occupied box still finds it", () => {
    hash.insert(eid(1), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(-500, -500, 800, results);
    expect(results).toEqual([eid(1)]);
  });

  it("an unswept query on an empty hash returns nothing", () => {
    const results: Entity[] = [eid(9)];
    hash.query(0, 0, 1e6, results);
    expect(results).toHaveLength(0);
  });

  it("columns 256 cells apart alias onto one slot without losing either", () => {
    // COL_SLOTS is 256, so cx and cx + 256 share a column slot; the merged row
    // range must stay a superset of both.
    hash.insert(eid(1), 1 * 64 + 8, 1 * 64 + 8, 2);
    hash.insert(eid(2), 257 * 64 + 8, 40 * 64 + 8, 2);
    const r1: Entity[] = [];
    hash.query(1 * 64 + 8, 1 * 64 + 8, 10, r1);
    expect(r1).toEqual([eid(1)]);
    const r2: Entity[] = [];
    hash.query(257 * 64 + 8, 40 * 64 + 8, 10, r2);
    expect(r2).toEqual([eid(2)]);
  });

  it("negative columns clamp correctly", () => {
    hash.insert(eid(1), -1000, -1000, 5);
    hash.insert(eid(2), 1000, 1000, 5);
    const r1: Entity[] = [];
    hash.query(-1000, -1000, 20, r1);
    expect(r1).toEqual([eid(1)]);
    const r2: Entity[] = [];
    hash.query(0, 0, 3000, r2);
    expect(new Set(r2)).toEqual(new Set([eid(1), eid(2)]));
  });

  it("a NaN insert leaves later results intact", () => {
    hash.insert(eid(1), Number.NaN, Number.NaN, 5);
    hash.insert(eid(2), 10, 10, 5);
    const results: Entity[] = [];
    hash.query(10, 10, 20, results);
    expect(results).toEqual([eid(2)]);
  });
});

// ---------------------------------------------------------------------------
// Differential test against a brute-force reference. The acceleration structures
// are only allowed to skip provably empty cells, so every query must agree with
// an exhaustive scan, IN ORDER: consumers award order-dependent outcomes (a
// killing blow, a nearest-target tie-break) from the result array's order, so a
// reordered result is as much a regression as a missing one.
// ---------------------------------------------------------------------------

/** Cell-ordered brute force: the same cx-major / cy-minor walk over the same
 *  Szudzik cells, with no occupancy structures at all. */
class ReferenceHash {
  private inv: number;
  private cells = new Map<number, Entity[]>();
  private seen = new Map<Entity, number>();
  private gen = 0;
  constructor(cellSize: number) {
    this.inv = 1 / cellSize;
  }
  clear(): void {
    this.cells.clear();
  }
  insert(e: Entity, x: number, y: number, r: number): void {
    for (let cx = this.f(x - r); cx <= this.f(x + r); cx++) {
      for (let cy = this.f(y - r); cy <= this.f(y + r); cy++) {
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
    this.gen++;
    for (let cx = this.f(x - r); cx <= this.f(x + r); cx++) {
      for (let cy = this.f(y - r); cy <= this.f(y + r); cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (!cell) continue;
        for (const e of cell) {
          if (this.seen.get(e) === this.gen) continue;
          this.seen.set(e, this.gen);
          out.push(e);
        }
      }
    }
  }
  queryRadius(
    x: number,
    y: number,
    r: number,
    getPos: (e: Entity) => { x: number; y: number } | undefined,
    getRadius: (e: Entity) => number,
    out: Entity[],
  ): void {
    const broad: Entity[] = [];
    this.query(x, y, r, broad);
    out.length = 0;
    for (const e of broad) {
      const p = getPos(e);
      if (!p) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const cr = r + getRadius(e);
      if (dx * dx + dy * dy <= cr * cr) out.push(e);
    }
  }
  private f(v: number): number {
    return Math.floor(v * this.inv);
  }
  private key(cx: number, cy: number): number {
    const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
    const b = cy >= 0 ? 2 * cy : -2 * cy - 1;
    return a >= b ? a * a + a + b : b * b + a;
  }
}

describe("Differential vs brute force", () => {
  it("agrees element-for-element over a randomised frame stream", () => {
    // Deterministic LCG: a failure has to be reproducible from the file alone.
    let s = 0x2f6e2b1;
    const rnd = () => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const CELL = 64;
    const N = 120;
    const subject = new SpatialHash(CELL, 256);
    const reference = new ReferenceHash(CELL);
    const pos = new Array<{ x: number; y: number } | undefined>(N);
    const getPos = (e: Entity) => pos[e as number];
    const getRadius = () => 9;
    const a: Entity[] = [];
    const b: Entity[] = [];

    for (let frame = 0; frame < 300; frame++) {
      subject.clear();
      reference.clear();
      for (let i = 0; i < N; i++) pos[i] = undefined;
      // Roam the cloud so buckets go empty, get pruned and are re-created.
      const ox = (rnd() - 0.5) * 4000;
      const oy = (rnd() - 0.5) * 4000;
      const live = 1 + ((rnd() * N) | 0);
      for (let i = 0; i < live; i++) {
        const x = ox + (rnd() - 0.5) * 600;
        const y = oy + (rnd() - 0.5) * 600;
        pos[i] = { x, y };
        subject.insert(i as Entity, x, y, 9);
        reference.insert(i as Entity, x, y, 9);
      }
      for (let q = 0; q < 4; q++) {
        const qx = ox + (rnd() - 0.5) * 1600;
        const qy = oy + (rnd() - 0.5) * 1600;
        const qr = 10 + rnd() * 400;
        subject.query(qx, qy, qr, a);
        reference.query(qx, qy, qr, b);
        expect(a).toEqual(b);
        subject.queryRadius(qx, qy, qr, getPos, getRadius, a);
        reference.queryRadius(qx, qy, qr, getPos, getRadius, b);
        expect(a).toEqual(b);
      }
    }
  });
});
