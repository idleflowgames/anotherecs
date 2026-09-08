import { test } from "vitest";
import {
  ComponentStore,
  defineComponent,
  type Entity,
  World,
} from "../src/index";

// Change tracking is opt-in; these benches compare untracked stores, tracked
// stores, clearChanges(), and getMut's explicit changed-record path.

const N = 5000;

test("change tracking: add + remove N entities", async ({ bench }) => {
  await bench.compare(
    bench("tracking OFF", () => {
      const s = new ComponentStore<{ x: number }>();
      for (let i = 0; i < N; i++) s.set(i as Entity, { x: i });
      for (let i = 0; i < N; i++) s.remove(i as Entity);
    }),
    bench("tracking ON (records added/removed deltas)", () => {
      const s = new ComponentStore<{ x: number }>();
      s.enableTracking();
      for (let i = 0; i < N; i++) s.set(i as Entity, { x: i });
      for (let i = 0; i < N; i++) s.remove(i as Entity);
      s.drainChanges();
    }),
  );
});

test("change tracking: clearChanges drain", async ({ bench }) => {
  const K = 16;
  const defs = Array.from({ length: K }, (_, i) =>
    defineComponent<{ x: number }>(`BenchClearC${i}`),
  );

  await bench.compare(
    bench("clearChanges over 0 tracked stores (no-op)", () => {
      const world = new World();
      const e = world.spawn();
      for (const d of defs) world.add(e, d, { x: 1 });
      world.clearChanges();
    }),
    bench("clearChanges over K tracked stores with N deltas each", () => {
      const world = new World();
      for (const d of defs) world.trackChanges(d);
      for (let i = 0; i < N; i++) {
        const e = world.spawn();
        for (const d of defs) world.add(e, d, { x: i });
      }
      world.clearChanges();
    }),
  );
});

test("change tracking: getMut vs get on a tracked store", async ({ bench }) => {
  const C = defineComponent<{ hp: number }>("BenchGetMutC");
  const world = new World();
  world.trackChanges(C);
  const ids: Entity[] = [];
  for (let i = 0; i < N; i++) {
    const e = world.spawn();
    world.add(e, C, { hp: i });
    ids.push(e);
  }

  await bench.compare(
    bench("get (no change record)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += world.get(ids[i], C)?.hp ?? 0;
      if (sum < 0) throw new Error("unreachable");
    }),
    bench("getMut (records changed)", () => {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += world.getMut(ids[i], C)?.hp ?? 0;
      world.clearChanges();
      if (sum < 0) throw new Error("unreachable");
    }),
  );
});
