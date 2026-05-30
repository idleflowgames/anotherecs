import { describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";
import { int, mulberry32 } from "./support/prng";

const CA = defineComponent(
  "DpA",
  () => ({ a: 0 }),
  (c) => {
    c.a = 0;
  },
);
const CB = defineComponent(
  "DpB",
  () => ({ b: 0 }),
  (c) => {
    c.b = 0;
  },
);

function runOps(seed: number): number[] {
  const rng = mulberry32(seed);
  const w = new World();
  const live: number[] = [];
  const pending = new Set<number>();

  for (let step = 0; step < 200; step++) {
    const op = int(rng, 10);
    if (op < 4 || live.length === 0) {
      const e = w.spawn();
      w.addComponent(e, CA);
      if (int(rng, 2) === 0) w.addComponent(e, CB);
      live.push(e as number);
    } else if (op < 6) {
      w.addComponent(live[int(rng, live.length)] as Entity, CB);
    } else if (op < 8) {
      w.removeComponent(live[int(rng, live.length)] as Entity, CB);
    } else if (op < 9) {
      const id = live[int(rng, live.length)];
      if (!pending.has(id)) {
        w.despawn(id as Entity);
        pending.add(id);
      }
    } else {
      w.flush();
      for (const id of pending) {
        const i = live.indexOf(id);
        if (i >= 0) live.splice(i, 1);
      }
      pending.clear();
    }
  }
  return [...w.store(CA).iterEntities()].map((e) => e as number);
}

describe("determinism: same seed yields identical iteration order", () => {
  it("two identical runs produce byte-identical iterEntities order (swap-delete)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      expect(runOps(seed)).toEqual(runOps(seed));
    }
  });
});
