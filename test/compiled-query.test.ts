import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

const CPos = defineComponent(
  "CqPos",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);
const CVel = defineComponent(
  "CqVel",
  () => ({ vx: 0, vy: 0 }),
  (c) => {
    c.vx = 0;
    c.vy = 0;
  },
);

let world: World;
beforeEach(() => {
  world = new World();
});

describe("compileQuery handle", () => {
  it("membership / first / count match world.query", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(a, CVel);
    const b = world.spawn();
    world.addComponent(b, CPos);

    const q = world.compileQuery(CPos, CVel);
    expect(q.results().map((r) => r[0])).toEqual(
      world.query(CPos, CVel).map((r) => r[0]),
    );
    expect(q.count()).toBe(1);
    expect(q.first()?.[0]).toBe(a);
  });

  it("each visits the same entities and mutations are visible", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 0, y: 0 });
    world.addComponent(e, CVel, { vx: 5, vy: -2 });

    const q = world.compileQuery(CPos, CVel);
    const seen: Entity[] = [];
    q.each((ent, pos, vel) => {
      seen.push(ent);
      pos.x += vel.vx;
      pos.y += vel.vy;
    });
    expect(seen).toEqual([e]);
    expect(world.getOrThrow(e, CPos)).toEqual({ x: 5, y: -2 });
  });

  it("results() is allocation-stable until a structural change", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    const q = world.compileQuery(CPos);
    const r1 = q.results();
    expect(q.results()).toBe(r1);

    const e2 = world.spawn();
    world.addComponent(e2, CPos);
    const r3 = q.results();
    expect(r3).not.toBe(r1);
    expect(r3).toHaveLength(2);
  });

  it("reflects add/remove between calls", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    const q = world.compileQuery(CPos, CVel);
    expect(q.count()).toBe(0);
    world.addComponent(a, CVel);
    expect(q.count()).toBe(1);
    world.removeComponent(a, CVel);
    expect(q.count()).toBe(0);
  });

  it("stays valid across world.clear() + re-spawn (cache reset in place)", () => {
    const a = world.spawn();
    world.addComponent(a, CPos);
    const q = world.compileQuery(CPos);
    expect(q.count()).toBe(1);

    world.clear();
    expect(q.count()).toBe(0);

    const b = world.spawn();
    world.addComponent(b, CPos);
    expect(q.results().map((r) => r[0])).toEqual([b]);
  });

  it("shares the underlying cache with world.query (same key)", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    const q = world.compileQuery(CPos);
    expect(q.results()).toBe(world.query(CPos));
  });
});
