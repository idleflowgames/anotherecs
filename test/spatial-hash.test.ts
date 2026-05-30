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
