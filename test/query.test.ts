import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

const CPos = defineComponent(
  "QPos",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);
const CVel = defineComponent(
  "QVel",
  () => ({ vx: 0, vy: 0 }),
  (c) => {
    c.vx = 0;
    c.vy = 0;
  },
);
const CTag = defineComponent(
  "QTag",
  () => ({ label: "" }),
  (c) => {
    c.label = "";
  },
);

let world: World;

beforeEach(() => {
  world = new World();
});

describe("Query correctness", () => {
  it("empty world returns empty results", () => {
    expect(world.query(CPos)).toEqual([]);
  });

  it("single-component query returns all matching entities", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.addComponent(a, CPos, { x: 1, y: 2 });
    world.addComponent(b, CPos, { x: 3, y: 4 });
    const entities = world.query(CPos).map((r) => r[0]);
    expect(entities).toContain(a);
    expect(entities).toContain(b);
    expect(entities).toHaveLength(2);
  });

  it("multi-component query returns only entities with ALL components", () => {
    const a = world.spawn();
    const b = world.spawn();
    const c = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(a, CVel);
    world.addComponent(b, CPos);
    world.addComponent(c, CVel);
    const results = world.query(CPos, CVel);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(a);
  });

  it("tuples carry components in call order", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 10, y: 20 });
    world.addComponent(e, CVel, { vx: 30, vy: 40 });
    const [entity, pos, vel] = world.query(CPos, CVel)[0];
    expect(entity).toBe(e);
    expect(pos).toEqual({ x: 10, y: 20 });
    expect(vel).toEqual({ vx: 30, vy: 40 });
  });

  it("reversed call order yields the same members (component order follows the call)", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 1, y: 1 });
    world.addComponent(e, CVel, { vx: 2, vy: 2 });
    const r1 = world.query(CPos, CVel);
    const r2 = world.query(CVel, CPos);
    expect(r1[0][0]).toBe(r2[0][0]);
    expect(r1[0][1]).toEqual({ x: 1, y: 1 });
    expect(r2[0][1]).toEqual({ vx: 2, vy: 2 });
  });

  it("3-component query", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(a, CVel);
    world.addComponent(a, CTag, { label: "hit" });
    const b = world.spawn();
    world.addComponent(b, CPos);
    world.addComponent(b, CVel);
    const results = world.query(CPos, CVel, CTag);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(a);
    expect(results[0][3].label).toBe("hit");
  });

  it("queryFirst returns first match or null", () => {
    expect(world.queryFirst(CPos)).toBeNull();
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 42, y: 0 });
    const r = world.queryFirst(CPos);
    expect(r?.[0]).toBe(e);
    expect(r?.[1].x).toBe(42);
  });
});

describe("Smallest-store-first + early out", () => {
  it("returns empty when one component's store is empty", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    expect(world.query(CPos, CVel)).toHaveLength(0);
  });

  it("iterates the smaller store (result is independent of which is smaller)", () => {
    const tagged = world.spawn();
    world.addComponent(tagged, CPos);
    world.addComponent(tagged, CTag, { label: "needle" });
    for (let i = 0; i < 50; i++) {
      const e = world.spawn();
      world.addComponent(e, CPos);
    }
    const results = world.query(CPos, CTag);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(tagged);
  });
});

describe("Version invalidation", () => {
  it("rebuilds when a component is added", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    expect(world.query(CPos, CVel)).toHaveLength(0);
    world.addComponent(a, CVel);
    expect(world.query(CPos, CVel)).toHaveLength(1);
  });

  it("rebuilds when a component is removed", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(a, CVel);
    expect(world.query(CPos, CVel)).toHaveLength(1);
    world.removeComponent(a, CVel);
    expect(world.query(CPos, CVel)).toHaveLength(0);
  });

  it("excludes entities after despawn + flush", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(b, CPos);
    expect(world.query(CPos)).toHaveLength(2);
    world.despawn(a);
    world.flush();
    const results = world.query(CPos);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(b);
  });
});

describe("Allocation-stable results (by-reference, read-only contract)", () => {
  it("returns the SAME array across calls with no structural change", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    const r1 = world.query(CPos);
    const r2 = world.query(CPos);
    expect(r2).toBe(r1);
    expect(r2[0]).toBe(r1[0]);
  });

  it("returns a NEW array after a structural change", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    const r1 = world.query(CPos);
    const b = world.spawn();
    world.addComponent(b, CPos);
    const r2 = world.query(CPos);
    expect(r2).not.toBe(r1);
    expect(r2).toHaveLength(2);
  });

  it("cached tuples reflect in-place component mutations (stable references)", () => {
    const e = world.spawn();
    const pos = world.addComponent(e, CPos, { x: 1, y: 1 });
    const r1 = world.query(CPos);
    pos.x = 999;
    const r2 = world.query(CPos);
    expect(r2).toBe(r1);
    expect(r2[0][1].x).toBe(999);
  });
});

describe("each()", () => {
  it("visits exactly the query membership", () => {
    const a = world.spawn();
    const b = world.spawn();
    const c = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(a, CVel);
    world.addComponent(b, CPos);
    world.addComponent(b, CVel);
    world.addComponent(c, CPos);

    const viaQuery = world
      .query(CPos, CVel)
      .map((r) => r[0])
      .sort();
    const viaEach: Entity[] = [];
    world.each(CPos, CVel, (e) => {
      viaEach.push(e);
    });
    expect(viaEach.sort()).toEqual(viaQuery);
  });

  it("passes components straight from the dense stores", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 3, y: 4 });
    world.addComponent(e, CVel, { vx: 5, vy: 6 });
    let sum = 0;
    world.each(CPos, CVel, (_e, pos, vel) => {
      sum = pos.x + pos.y + vel.vx + vel.vy;
    });
    expect(sum).toBe(18);
  });

  it("mutations through each are visible afterwards", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 0, y: 0 });
    world.addComponent(e, CVel, { vx: 10, vy: -3 });
    world.each(CPos, CVel, (_e, pos, vel) => {
      pos.x += vel.vx;
      pos.y += vel.vy;
    });
    expect(world.getOrThrow(e, CPos)).toEqual({ x: 10, y: -3 });
  });

  it("single-component each works", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.addComponent(a, CPos, { x: 1, y: 0 });
    world.addComponent(b, CPos, { x: 2, y: 0 });
    let total = 0;
    world.each(CPos, (_e, pos) => {
      total += pos.x;
    });
    expect(total).toBe(3);
  });
});
