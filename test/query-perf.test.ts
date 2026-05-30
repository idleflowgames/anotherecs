import { describe, expect, it } from "vitest";
import { defineComponent, type Entity, World, without } from "../src/index";

describe("per-store versioning: unrelated mutations don't invalidate a query", () => {
  const A = defineComponent<{ v: number }>("PsvA");
  const B = defineComponent<{ v: number }>("PsvB");

  it("a query over A is not rebuilt when B is mutated, but is when A changes", () => {
    const w = new World();
    const e = w.spawn();
    w.add(e, A, { v: 1 });

    const q = w.compileQuery(A);
    const r1 = q.results();
    expect(q.results()).toBe(r1);

    const e2 = w.spawn();
    w.add(e2, B, { v: 2 });
    expect(q.results()).toBe(r1);
    w.remove(e2, B);
    expect(q.results()).toBe(r1);

    const e3 = w.spawn();
    w.add(e3, A, { v: 3 });
    const r2 = q.results();
    expect(r2).not.toBe(r1);
    expect(r2).toHaveLength(2);
  });

  it("world.query over A is stable across an unrelated B add (entry-point path)", () => {
    const w = new World();
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    const first = w.query(A);
    const e2 = w.spawn();
    w.add(e2, B, { v: 9 });
    expect(w.query(A)).toBe(first);
  });

  it("an object-replacing add (same entity) still invalidates the cache", () => {
    const w = new World();
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    const r1 = w.query(A);
    w.add(e, A, { v: 99 });
    const r2 = w.query(A);
    expect(r2).not.toBe(r1);
    expect(r2[0][1]).toEqual({ v: 99 });
  });
});

describe("bitmask-accelerated rebuild matches the has()-loop path (>= 4 required)", () => {
  const A = defineComponent<{ v: number }>("BmA");
  const B = defineComponent<{ v: number }>("BmB");
  const C = defineComponent<{ v: number }>("BmC");
  const D = defineComponent<{ v: number }>("BmD");
  const Dead = defineComponent<{ v: number }>("BmDead");

  const build = (useMask: boolean): World => {
    const w = new World();
    if (useMask) w.enableBitmask();
    for (let i = 0; i < 24; i++) {
      const e = w.spawn();
      w.add(e, A, { v: i });
      if (i % 2 === 0) w.add(e, B, { v: i });
      if (i % 3 === 0) w.add(e, C, { v: i });
      if (i % 2 === 1) w.add(e, D, { v: i });
      if (i % 5 === 0) w.add(e, Dead, { v: i });
    }
    return w;
  };

  it("4-component join (A,B,C,D) yields identical matches and order", () => {
    const ids = (w: World) => w.query(A, B, C, D).map((r) => r[0]);
    expect(ids(build(true))).toEqual(ids(build(false)));
  });

  it("filtered 4-required join (A,B,C,D without Dead) is identical", () => {
    const ids = (w: World) =>
      w
        .select(A, B, C, D, without(Dead))
        .results()
        .map((r) => r[0]);
    expect(ids(build(true))).toEqual(ids(build(false)));
  });

  it("yielded component values are correct under the bitmask path", () => {
    const w = build(true);
    w.query(A, B, C, D).forEach(([e, a, b, c, d]) => {
      expect(a).toBe(w.get(e as Entity, A));
      expect(b).toBe(w.get(e as Entity, B));
      expect(c).toBe(w.get(e as Entity, C));
      expect(d).toBe(w.get(e as Entity, D));
    });
  });
});

describe("each() yields the correct component per entity after swap-delete", () => {
  it("single component: each value matches its entity after a removal", () => {
    const A = defineComponent<{ v: number }>("Sd1A");
    const w = new World();
    const e: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      const x = w.spawn();
      w.add(x, A, { v: i });
      e.push(x);
    }
    w.remove(e[2], A);

    const q = w.compileQuery(A);
    let n = 0;
    q.each((ent, a) => {
      expect(a).toBe(w.get(ent, A));
      n++;
    });
    expect(n).toBe(5);
  });

  it("two components: both slots match after removals reorder the driver", () => {
    const A = defineComponent<{ v: number }>("Sd2A");
    const B = defineComponent<{ v: number }>("Sd2B");
    const w = new World();
    const e: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const x = w.spawn();
      w.add(x, A, { v: i });
      w.add(x, B, { v: i * 10 });
      e.push(x);
    }
    w.remove(e[1], A);
    w.remove(e[5], A);

    const q = w.compileQuery(A, B);
    let n = 0;
    q.each((ent, a, b) => {
      expect(a).toBe(w.get(ent, A));
      expect(b).toBe(w.get(ent, B));
      n++;
    });
    expect(n).toBe(6);
  });
});
