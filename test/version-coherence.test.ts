import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, World } from "../src/index";

const CPos = defineComponent(
  "VcPos",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);

let world: World;
beforeEach(() => {
  world = new World();
});

describe("version coherence: add/remove invalidate queries", () => {
  it("world.add after a cached query is not stale", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 2 });
    expect(world.query(CPos)).toHaveLength(1);

    const b = world.spawn();
    world.add(b, CPos, { x: 3, y: 4 });
    expect(world.query(CPos)).toHaveLength(2);
  });

  it("world.remove after a cached query is not stale", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    world.add(b, CPos, { x: 2, y: 2 });
    expect(world.query(CPos)).toHaveLength(2);

    world.remove(a, CPos);
    expect(world.query(CPos).map((r) => r[0])).toEqual([b]);
  });

  it("world.add overwrite replaces the object, and the query reflects it", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    expect(world.query(CPos)).toHaveLength(1);

    world.add(a, CPos, { x: 9, y: 9 });
    const r = world.query(CPos);
    expect(r).toHaveLength(1);
    expect(r[0][1]).toEqual({ x: 9, y: 9 });
  });

  it("world.remove of an absent component does not bump (no needless rebuild)", () => {
    const a = world.spawn();
    const v = world.version;
    world.remove(a, CPos);
    expect(world.version).toBe(v);
  });
});
