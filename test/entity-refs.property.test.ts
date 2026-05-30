import { describe, expect, it } from "vitest";
import { type Entity, type EntityRef, World } from "../src/index";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface RunResult {
  refInts: number[];
  derefOutcomes: number[];
  backrefSnapshots: number[][];
}

function scriptedRun(seed: number): RunResult {
  const world = new World();
  world.enableBackrefs();
  const rng = lcg(seed);

  const live: Entity[] = [];
  const refs: EntityRef[] = [];
  const refInts: number[] = [];
  const derefOutcomes: number[] = [];
  const backrefSnapshots: number[][] = [];

  for (let i = 0; i < 12; i++) live.push(world.spawn());

  for (let step = 0; step < 200; step++) {
    const roll = rng();
    if (roll < 0.4 && live.length >= 2) {
      const ti = Math.floor(rng() * live.length);
      let hi = Math.floor(rng() * live.length);
      if (hi === ti) hi = (hi + 1) % live.length;
      const r = world.ref(live[ti], live[hi]);
      refs.push(r);
      refInts.push(r as unknown as number);
    } else if (roll < 0.55 && refs.length > 0) {
      const ri = Math.floor(rng() * refs.length);
      const hi = Math.floor(rng() * live.length);
      world.unref(refs[ri], live[hi]);
    } else if (roll < 0.7) {
      live.push(world.spawn());
    } else if (roll < 0.85 && live.length > 4) {
      const di = Math.floor(rng() * live.length);
      const dead = live.splice(di, 1)[0];
      world.despawn(dead);
      world.flush();
    } else {
      for (const r of refs) {
        const got = world.deref(r);
        derefOutcomes.push(got === null ? -1 : (got as number));
      }
      if (live.length > 0) {
        const t = live[Math.floor(rng() * live.length)];
        backrefSnapshots.push(world.backrefs(t).map((e) => e as number));
      }
    }
  }

  return { refInts, derefOutcomes, backrefSnapshots };
}

describe("EntityRef determinism (seeded script is byte-identical across runs)", () => {
  for (const seed of [1, 42, 1337]) {
    it(`seed ${seed}: identical ref integers, deref outcomes, and backrefs arrays`, () => {
      const a = scriptedRun(seed);
      const b = scriptedRun(seed);
      expect(a.refInts).toEqual(b.refInts);
      expect(a.derefOutcomes).toEqual(b.derefOutcomes);
      expect(a.backrefSnapshots).toEqual(b.backrefSnapshots);
    });
  }
});
