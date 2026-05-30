import { describe, expect, it } from "vitest";
import {
  any,
  defineComponent,
  type Entity,
  type IncrementalQuery,
  maybe,
  World,
  without,
} from "../src/index";

const A = defineComponent<{ v: number }>("IqA");
const B = defineComponent<{ v: number }>("IqB");

const incIds = (q: IncrementalQuery): number[] =>
  [...q.view()].map((e) => e as number).sort((x, y) => x - y);
const cqIds = (r: readonly (readonly [Entity, ...unknown[]])[]): number[] =>
  r.map((t) => t[0] as number).sort((x, y) => x - y);

describe("IncrementalQuery matches the rebuild query", () => {
  it("membership tracks add / remove / despawn / clear identically", () => {
    const w = new World();
    const cq = w.compileQuery(A, B);
    const inc = w.compileIncremental(A, B);
    const check = () => expect(incIds(inc)).toEqual(cqIds(cq.results()));

    const ids: Entity[] = [];
    for (let i = 0; i < 10; i++) {
      const e = w.spawn();
      w.add(e, A, { v: i });
      if (i % 2 === 0) w.add(e, B, { v: i });
      ids.push(e);
    }
    check();

    w.add(ids[1], B, { v: 1 });
    check();
    w.remove(ids[0], A);
    check();
    w.remove(ids[2], B);
    check();
    w.despawn(ids[4]);
    check();
    w.flush();
    check();

    const r = w.spawn();
    w.add(r, A, { v: 99 });
    w.add(r, B, { v: 99 });
    check();

    w.clear();
    check();
    const e2 = w.spawn();
    w.add(e2, A, { v: 1 });
    w.add(e2, B, { v: 1 });
    check();
  });

  it("compileIncremental after populating captures existing matches (initial scan)", () => {
    const w = new World();
    for (let i = 0; i < 5; i++) {
      const e = w.spawn();
      w.add(e, A, { v: i });
      w.add(e, B, { v: i });
    }
    const cq = w.compileQuery(A, B);
    const inc = w.compileIncremental(A, B);
    expect(incIds(inc)).toEqual(cqIds(cq.results()));
    expect(inc.count()).toBe(5);
  });

  it("each() yields the correct components for matched entities", () => {
    const w = new World();
    const e = w.spawn();
    w.add(e, A, { v: 5 });
    w.add(e, B, { v: 50 });
    const inc = w.compileIncremental(A, B);
    const seen: Array<[Entity, number, number]> = [];
    inc.each((ent, a, b) => {
      seen.push([ent, (a as { v: number }).v, (b as { v: number }).v]);
    });
    expect(seen).toEqual([[e, 5, 50]]);
  });

  it("re-adding the same component (object replace) does not duplicate membership", () => {
    const w = new World();
    const inc = w.compileIncremental(A, B);
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    w.add(e, B, { v: 1 });
    w.add(e, A, { v: 2 });
    w.add(e, B, { v: 2 });
    expect(inc.count()).toBe(1);
    expect(incIds(inc)).toEqual([e as number]);
  });
});

describe("IncrementalQuery filters match select() (without / maybe / any)", () => {
  const C = defineComponent<{ v: number }>("IqC");
  const D = defineComponent<{ v: number }>("IqD");
  const Dead = defineComponent<{ v: number }>("IqDead");

  const build = () => {
    const w = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 16; i++) {
      const e = w.spawn();
      w.add(e, A, { v: i });
      if (i % 2 === 0) w.add(e, C, { v: i });
      if (i % 3 === 0) w.add(e, D, { v: i });
      if (i % 4 === 0) w.add(e, Dead, { v: i });
      ids.push(e);
    }
    return { w, ids };
  };

  it("without(): membership equals select(A, without(Dead))", () => {
    const { w } = build();
    const inc = w.compileIncremental(A, without(Dead));
    const sel = w.select(A, without(Dead));
    expect(incIds(inc)).toEqual(cqIds(sel.results()));
  });

  it("any(): membership equals select(A, any(C, D))", () => {
    const { w } = build();
    const inc = w.compileIncremental(A, any(C, D));
    const sel = w.select(A, any(C, D));
    expect(incIds(inc)).toEqual(cqIds(sel.results()));
  });

  it("maybe(): membership is the required set; yields value or undefined", () => {
    const { w } = build();
    const inc = w.compileIncremental(A, maybe(C));
    const sel = w.select(A, maybe(C));
    expect(incIds(inc)).toEqual(cqIds(sel.results()));
    inc.each((e, _a, c) => {
      expect(c).toBe(w.get(e, C));
    });
  });

  it("a maybe-component add (no membership change) is reflected by each()/results()", () => {
    const w = new World();
    const inc = w.compileIncremental(A, maybe(C));
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    expect(inc.count()).toBe(1);
    let seenC: unknown = "x";
    inc.each((_e, _a, c) => {
      seenC = c;
    });
    expect(seenC).toBeUndefined();
    w.add(e, C, { v: 7 });
    expect(inc.count()).toBe(1);
    inc.each((_e, _a, c) => {
      seenC = c;
    });
    expect(seenC).toEqual({ v: 7 });
    expect(inc.results()[0][2]).toEqual({ v: 7 });
  });
});

describe("IncrementalQuery.results() is maintained and allocation-stable", () => {
  it("same reference across unrelated mutation; new reference on membership change", () => {
    const w = new World();
    const Unrelated = defineComponent<{ v: number }>("IqUnrel");
    const inc = w.compileIncremental(A, B);
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    w.add(e, B, { v: 1 });
    const r1 = inc.results();
    expect(inc.results()).toBe(r1);

    const u = w.spawn();
    w.add(u, Unrelated, { v: 9 });
    expect(inc.results()).toBe(r1);

    const e2 = w.spawn();
    w.add(e2, A, { v: 2 });
    w.add(e2, B, { v: 2 });
    const r2 = inc.results();
    expect(r2).not.toBe(r1);
    expect(r2).toHaveLength(2);
  });

  it("reflects an object-replacing add of a yielded component", () => {
    const w = new World();
    const inc = w.compileIncremental(A);
    const e = w.spawn();
    w.add(e, A, { v: 1 });
    expect(inc.results()[0][1]).toEqual({ v: 1 });
    w.add(e, A, { v: 42 });
    expect(inc.results()[0][1]).toEqual({ v: 42 });
  });
});

describe("IncrementalQuery order is deterministic", () => {
  it("a fixed spawn/add/remove script yields the same match order across runs", () => {
    const C = defineComponent<{ v: number }>("IqDetC");
    const run = (): number[] => {
      const w = new World();
      const inc = w.compileIncremental(C);
      const e: Entity[] = [];
      for (let i = 0; i < 8; i++) {
        const x = w.spawn();
        w.add(x, C, { v: i });
        e.push(x);
      }
      w.remove(e[2], C);
      w.remove(e[0], C);
      w.remove(e[5], C);
      const r = w.spawn();
      w.add(r, C, { v: 99 });
      return [...inc.view()].map((x) => x as number);
    };
    expect(run()).toEqual(run());
  });
});
