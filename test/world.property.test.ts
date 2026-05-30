import { describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";
import { int, mulberry32 } from "./support/prng";
import { ReferenceWorld } from "./support/reference-world";

const make = (name: string) =>
  defineComponent(
    name,
    () => ({ v: 0 }),
    (c) => {
      c.v = 0;
    },
  );
const CA = make("PrA");
const CB = make("PrB");
const CC = make("PrC");
const CD = make("PrD");
const ALL = [CA, CB, CC, CD];

function ids(entities: readonly Entity[]): number[] {
  return entities.map((e) => e as number).sort((a, b) => a - b);
}

function run(seed: number): void {
  const rng = mulberry32(seed);
  const w = new World();
  const r = new ReferenceWorld();
  const live: number[] = [];
  const pending = new Set<number>();

  const compare = () => {
    expect(w.entityCount).toBe(r.aliveIds().length);
    for (const def of ALL) {
      const ws = [...w.getStoreRaw(def).iterEntities()]
        .map((e) => e as number)
        .sort((a, b) => a - b);
      expect(ws).toEqual(r.storeMembers(def));
    }
    expect(ids(w.query(CA).map((t) => t[0]))).toEqual(r.query(CA));
    expect(ids(w.query(CA, CB).map((t) => t[0]))).toEqual(r.query(CA, CB));
    expect(ids(w.query(CB, CC).map((t) => t[0]))).toEqual(r.query(CB, CC));
    expect(ids(w.query(CA, CB, CC).map((t) => t[0]))).toEqual(
      r.query(CA, CB, CC),
    );
    expect(ids(w.query(CA, CC, CD).map((t) => t[0]))).toEqual(
      r.query(CA, CC, CD),
    );
  };

  for (let step = 0; step < 120; step++) {
    const op = int(rng, 10);
    if (op < 3 || live.length === 0) {
      const e = w.spawn();
      const re = r.spawn();
      expect(e).toBe(re);
      live.push(e as number);
    } else if (op < 6) {
      const id = live[int(rng, live.length)];
      const def = ALL[int(rng, ALL.length)];
      w.addComponent(id as Entity, def);
      r.add(id as Entity, def, {});
    } else if (op < 8) {
      const id = live[int(rng, live.length)];
      const def = ALL[int(rng, ALL.length)];
      w.removeComponent(id as Entity, def);
      r.remove(id as Entity, def);
    } else if (op < 9) {
      const id = live[int(rng, live.length)];
      if (!pending.has(id)) {
        w.despawn(id as Entity);
        r.despawn(id as Entity);
        pending.add(id);
      }
    } else {
      w.flush();
      r.flush();
      for (const id of pending) {
        const i = live.indexOf(id);
        if (i >= 0) live.splice(i, 1);
      }
      pending.clear();
    }
    compare();
  }
}

describe("World vs naive oracle (differential/fuzz)", () => {
  it("alive set, store membership, and query results match across random op streams", () => {
    for (let seed = 1; seed <= 64; seed++) run(seed);
  });
});
