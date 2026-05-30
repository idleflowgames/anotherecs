import { beforeEach, describe, expect, it } from "vitest";
import {
  any,
  defineComponent,
  type Entity,
  maybe,
  World,
  without,
} from "../src/index";

const CPos = defineComponent<{ x: number; y: number }>("QfPos");
const CVel = defineComponent<{ vx: number; vy: number }>("QfVel");
const CDead = defineComponent<{ at: number }>("QfDead");
const CBurning = defineComponent<{ dps: number }>("QfBurning");
const CPoisoned = defineComponent<{ dps: number }>("QfPoisoned");
const CPlayer = defineComponent<{ name: string }>("QfPlayer");
const CTag = defineComponent<{ label: string }>("QfTag");

const C1 = defineComponent<{ n: number }>("Qf1");
const C2 = defineComponent<{ n: number }>("Qf2");
const C3 = defineComponent<{ n: number }>("Qf3");
const C4 = defineComponent<{ n: number }>("Qf4");
const C5 = defineComponent<{ n: number }>("Qf5");
const C6 = defineComponent<{ n: number }>("Qf6");

let world: World;
beforeEach(() => {
  world = new World();
});

describe("without()", () => {
  it("excludes entities that have the excluded component", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    world.add(b, CPos, { x: 2, y: 2 });
    world.add(b, CDead, { at: 0 });

    const q = world.select(CPos, without(CDead));
    expect(q.results().map((r) => r[0])).toEqual([a]);

    const seen: Entity[] = [];
    q.each((e) => seen.push(e));
    expect(seen).toEqual([a]);
  });

  it("drops a matched entity once the excluded component is added (version invalidation)", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    const q = world.select(CPos, without(CDead));
    expect(q.count()).toBe(1);
    world.add(a, CDead, { at: 0 });
    expect(q.count()).toBe(0);
  });
});

describe("maybe()", () => {
  it("yields T or undefined and never constrains membership", () => {
    const withVel = world.spawn();
    const noVel = world.spawn();
    world.add(withVel, CPos, { x: 0, y: 0 });
    world.add(withVel, CVel, { vx: 5, vy: 6 });
    world.add(noVel, CPos, { x: 0, y: 0 });

    const q = world.select(CPos, maybe(CVel));
    const byEntity = new Map(q.results().map((r) => [r[0], r]));
    expect(byEntity.get(withVel)?.[2]).toEqual({ vx: 5, vy: 6 });
    expect(byEntity.get(noVel)?.[2]).toBeUndefined();

    const members = q
      .results()
      .map((r) => r[0])
      .sort();
    const plain = world
      .query(CPos)
      .map((r) => r[0])
      .sort();
    expect(members).toEqual(plain);
  });

  it("yields slots follow DECLARATION order across with+maybe (maybe before with)", () => {
    const e = world.spawn();
    world.add(e, CPos, { x: 9, y: 9 });
    world.add(e, CVel, { vx: 1, vy: 2 });
    const r = world.select(maybe(CVel), CPos).results()[0];
    expect(r[1]).toEqual({ vx: 1, vy: 2 });
    expect(r[2]).toEqual({ x: 9, y: 9 });
  });
});

describe("any()", () => {
  it("requires at least one of the group present", () => {
    const burning = world.spawn();
    const poisoned = world.spawn();
    const neither = world.spawn();
    for (const e of [burning, poisoned, neither])
      world.add(e, CPos, { x: 0, y: 0 });
    world.add(burning, CBurning, { dps: 1 });
    world.add(poisoned, CPoisoned, { dps: 1 });

    const q = world.select(CPos, any(CBurning, CPoisoned));
    const members = q
      .results()
      .map((r) => r[0])
      .sort();
    expect(members).toEqual([burning, poisoned].sort());
    expect(q.results()[0]).toHaveLength(2);
  });
});

describe("combined without + maybe + any", () => {
  it("yields the correct intersection and tuple shape", () => {
    const match = world.spawn();
    const dead = world.spawn();
    const noStatus = world.spawn();
    for (const e of [match, dead, noStatus]) world.add(e, CPos, { x: 0, y: 0 });
    world.add(match, CVel, { vx: 3, vy: 4 });
    world.add(match, CBurning, { dps: 2 });
    world.add(dead, CBurning, { dps: 2 });
    world.add(dead, CDead, { at: 0 });

    const q = world.select(
      CPos,
      maybe(CVel),
      without(CDead),
      any(CBurning, CPoisoned),
    );
    const results = q.results();
    expect(results.map((r) => r[0])).toEqual([match]);
    expect(results[0]).toHaveLength(3);
    expect(results[0][1]).toEqual({ x: 0, y: 0 });
    expect(results[0][2]).toEqual({ vx: 3, vy: 4 });
  });
});

describe("5+ component queries lift the old 4-cap", () => {
  function spawnWith(...defs: { id: number }[]): Entity {
    const e = world.spawn();
    for (let i = 0; i < defs.length; i++)
      world.add(e, defs[i] as never, { n: i } as never);
    return e;
  }

  it("query(C1..C6) returns the right membership and 6-long tuples", () => {
    const all = spawnWith(C1, C2, C3, C4, C5, C6);
    spawnWith(C1, C2, C3, C4, C5);
    const results = world.query(C1, C2, C3, C4, C5, C6);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(all);
    expect(results[0]).toHaveLength(7);
  });

  it("each over 6 defs visits the same entities and assembles all six", () => {
    spawnWith(C1, C2, C3, C4, C5, C6);
    spawnWith(C1, C2, C3, C4, C5, C6);
    const seen: Entity[] = [];
    let assembled = 0;
    world.each(C1, C2, C3, C4, C5, C6, (e, a, b, c, d, f, g) => {
      seen.push(e);
      assembled += [a, b, c, d, f, g].filter((x) => x !== undefined).length;
    });
    const viaQuery = world.query(C1, C2, C3, C4, C5, C6).map((r) => r[0]);
    expect(seen.sort()).toEqual(viaQuery.sort());
    expect(assembled).toBe(12);
  });

  it("compileQuery(...6).count() matches and does not throw", () => {
    spawnWith(C1, C2, C3, C4, C5, C6);
    const q = world.compileQuery(C1, C2, C3, C4, C5, C6);
    expect(q.count()).toBe(1);
    expect(q.results()[0]).toHaveLength(7);
  });

  it("each 6-component generic lane equals query membership", () => {
    spawnWith(C1, C2, C3, C4, C5, C6);
    spawnWith(C1, C2, C3, C4, C5, C6);
    spawnWith(C1, C2, C3);
    const viaEach: Entity[] = [];
    world.each(C1, C2, C3, C4, C5, C6, (e) => viaEach.push(e));
    const viaQuery = world.query(C1, C2, C3, C4, C5, C6).map((r) => r[0]);
    expect(viaEach.sort()).toEqual(viaQuery.sort());
  });
});

describe("single()", () => {
  it("returns the sole match", () => {
    const p = world.spawn();
    world.add(p, CPlayer, { name: "hero" });
    const [entity, player] = world.select(CPlayer).single();
    expect(entity).toBe(p);
    expect(player.name).toBe("hero");
  });

  it("throws with the count for zero matches", () => {
    expect(() => world.select(CPlayer).single()).toThrow(/got 0/);
  });

  it("throws with the count for two matches", () => {
    world.add(world.spawn(), CPlayer, { name: "a" });
    world.add(world.spawn(), CPlayer, { name: "b" });
    expect(() => world.select(CPlayer).single()).toThrow(/got 2/);
  });
});

describe("get(entity)", () => {
  it("returns the tuple when the entity matches, null otherwise", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.add(a, CPos, { x: 1, y: 2 });
    world.add(a, CVel, { vx: 3, vy: 4 });
    world.add(b, CPos, { x: 0, y: 0 });

    const q = world.select(CPos, CVel);
    const got = q.get(a);
    expect(got).not.toBeNull();
    expect(got?.[0]).toBe(a);
    expect(got?.[1]).toEqual({ x: 1, y: 2 });
    expect(got?.[2]).toEqual({ vx: 3, vy: 4 });
    expect(q.get(b)).toBeNull();
  });

  it("returns null for a dead entity", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    world.add(a, CVel, { vx: 0, vy: 0 });
    const q = world.select(CPos, CVel);
    world.despawn(a);
    world.flush();
    expect(q.get(a)).toBeNull();
  });

  it("returns a FRESH tuple, not the cached results reference", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    world.add(a, CVel, { vx: 0, vy: 0 });
    const q = world.select(CPos, CVel);
    const fromResults = q.results()[0];
    const fromGet = q.get(a);
    expect(fromGet).not.toBe(fromResults);
    expect(fromGet).toEqual(fromResults);
  });

  it("honors filter terms (without)", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 1, y: 1 });
    world.add(a, CDead, { at: 0 });
    const q = world.select(CPos, without(CDead));
    expect(q.get(a)).toBeNull();
  });
});

describe("pairs()", () => {
  it("visits each unordered pair exactly once with a's component tail", () => {
    const ents: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const e = world.spawn();
      world.add(e, CPos, { x: i, y: 0 });
      ents.push(e);
    }
    const seen: [Entity, Entity][] = [];
    const tails: number[] = [];
    world.select(CPos).pairs((a, b, posA) => {
      seen.push([a, b]);
      tails.push(posA.x);
    });
    expect(seen).toHaveLength(6);
    const keys = new Set<string>();
    for (const [a, b] of seen) {
      expect(a).not.toBe(b);
      const rev = `${b}:${a}`;
      expect(keys.has(rev)).toBe(false);
      keys.add(`${a}:${b}`);
    }
    for (let i = 0; i < seen.length; i++) {
      const a = seen[i][0];
      expect(tails[i]).toBe(ents.indexOf(a));
    }
  });

  it("does nothing for fewer than two matches", () => {
    const e = world.spawn();
    world.add(e, CPos, { x: 0, y: 0 });
    let calls = 0;
    world.select(CPos).pairs(() => calls++);
    expect(calls).toBe(0);
  });
});

describe("filtered caches: allocation-stability + version invalidation", () => {
  it("returns the same array reference with no structural change, new after one", () => {
    const a = world.spawn();
    world.add(a, CPos, { x: 0, y: 0 });
    const q = world.select(CPos, without(CDead));
    const r1 = q.results();
    expect(q.results()).toBe(r1);
    const b = world.spawn();
    world.add(b, CPos, { x: 1, y: 1 });
    expect(q.results()).not.toBe(r1);
  });

  it("the filtered cache key is distinct from the plain select(CPos) cache", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.add(a, CPos, { x: 0, y: 0 });
    world.add(b, CPos, { x: 1, y: 1 });
    world.add(b, CDead, { at: 0 });
    const plain = world.select(CPos).results();
    const filtered = world.select(CPos, without(CDead)).results();
    expect(plain).not.toBe(filtered);
    expect(plain.map((r) => r[0]).sort()).toEqual([a, b].sort());
    expect(filtered.map((r) => r[0])).toEqual([a]);
  });
});

describe("pure-with select shares the query cache", () => {
  it("select(CPos).results() === world.query(CPos)", () => {
    const e = world.spawn();
    world.add(e, CPos, { x: 0, y: 0 });
    expect(world.select(CPos).results()).toBe(world.query(CPos));
  });

  it("select(CPos, CVel).results() === world.query(CPos, CVel)", () => {
    const e = world.spawn();
    world.add(e, CPos, { x: 0, y: 0 });
    world.add(e, CVel, { vx: 0, vy: 0 });
    expect(world.select(CPos, CVel).results()).toBe(world.query(CPos, CVel));
  });
});

describe("compileSpec rejects a query with no required term", () => {
  it("select(maybe(CVel)) throws at compile time", () => {
    expect(() => world.select(maybe(CVel))).toThrow(/at least one required/);
  });

  it("select(without(CDead)) throws at compile time", () => {
    expect(() => world.select(without(CDead))).toThrow(/at least one required/);
  });

  it("select(any(CBurning, CPoisoned)) throws at compile time", () => {
    expect(() => world.select(any(CBurning, CPoisoned))).toThrow(
      /at least one required/,
    );
  });
});

describe("smallest-store-first drives over required stores only", () => {
  it("iterates the small required store, ignoring without/maybe stores", () => {
    const tagged = world.spawn();
    world.add(tagged, CPos, { x: 0, y: 0 });
    world.add(tagged, CTag, { label: "needle" });
    for (let i = 0; i < 50; i++) {
      const e = world.spawn();
      world.add(e, CPos, { x: i, y: 0 });
    }
    const found = world.select(CPos, CTag, without(CDead)).results();
    expect(found.map((r) => r[0])).toEqual([tagged]);

    world.add(tagged, CDead, { at: 0 });
    expect(world.select(CPos, CTag, without(CDead)).count()).toBe(0);
  });
});

describe("determinism: a fixed script yields fixed filtered membership + pair order", () => {
  function scripted(): { members: number[]; pairs: [number, number][] } {
    const w = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const e = w.spawn();
      w.add(e, CPos, { x: i, y: 0 });
      if (i % 2 === 0) w.add(e, CBurning, { dps: i });
      if (i % 3 === 0) w.add(e, CDead, { at: i });
      ids.push(e);
    }
    w.remove(ids[2], CPos);
    w.remove(ids[5], CPos);
    const q = w.select(CPos, without(CDead), any(CBurning, CPoisoned));
    const members = q.results().map((r) => r[0] as number);
    const pairs: [number, number][] = [];
    q.pairs((a, b) => pairs.push([a as number, b as number]));
    return { members, pairs };
  }

  it("two runs match exactly", () => {
    const a = scripted();
    const b = scripted();
    expect(a.members).toEqual(b.members);
    expect(a.pairs).toEqual(b.pairs);
  });
});
