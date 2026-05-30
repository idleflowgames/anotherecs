import { describe, expect, it } from "vitest";
import { ComponentStore, type Entity } from "../src/index";
import { int, mulberry32 } from "./support/prng";

interface Box {
  v: number;
}
const CAP = 64;
const create = (): Box => ({ v: 0 });
const baseline = (): Box => ({ v: 0 });
const reset = (b: Box) => {
  b.v = 0;
};

function checkInvariants(
  store: ComponentStore<Box>,
  present: Map<number, Box>,
) {
  expect(store.size()).toBe(present.size);
  const ents = store.iterEntities();
  expect(ents.length).toBe(present.size);
  const seen = new Set<number>();
  for (const e of ents) {
    const id = e as number;
    expect(seen.has(id)).toBe(false);
    seen.add(id);
    expect(present.has(id)).toBe(true);
    expect(store.has(e)).toBe(true);
    expect(store.get(e)).toBe(present.get(id));
    expect(store.getUnsafe(e)).toBe(present.get(id));
  }
}

function run(pooling: boolean, seed: number): void {
  const rng = mulberry32(seed);
  const store = new ComponentStore<Box>(CAP);
  if (pooling) store.enablePooling(reset);
  const present = new Map<number, Box>();

  for (let step = 0; step < 150; step++) {
    const op = int(rng, 3);
    if (op === 0 || present.size === 0) {
      const id = int(rng, CAP);
      let box: Box | undefined;
      if (pooling && store.pooledCount() > 0 && int(rng, 2) === 0) {
        box = store.acquire();
      }
      if (!box) box = create();
      box.v = int(rng, 1000) + 1;
      store.set(id as Entity, box);
      present.set(id, box);
    } else if (op === 1) {
      const ids = [...present.keys()];
      const id = ids[int(rng, ids.length)];
      const box = present.get(id) as Box;
      store.remove(id as Entity);
      present.delete(id);
      if (pooling) expect(box).toEqual(baseline());
    } else {
      const id = int(rng, CAP);
      const wasPresent = present.has(id);
      const box = present.get(id);
      store.remove(id as Entity);
      present.delete(id);
      if (pooling && wasPresent && box) expect(box).toEqual(baseline());
    }
    checkInvariants(store, present);
  }
}

describe("ComponentStore property/fuzz", () => {
  it("invariants hold across random op sequences (pooling off)", () => {
    for (let seed = 1; seed <= 80; seed++) run(false, seed);
  });

  it("invariants + reset correctness hold across random op sequences (pooling on)", () => {
    for (let seed = 1; seed <= 80; seed++) run(true, seed);
  });
});
