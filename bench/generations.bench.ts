import { bench, describe } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

const N = 1000;
const CTag = defineComponent<{ x: number }>("BenchGenTag");

describe("generations: handleOf + resolve round-trip", () => {
  const world = new World();
  const entities: Entity[] = [];
  for (let i = 0; i < N; i++) {
    const e = world.spawn();
    world.add(e, CTag, { x: i });
    entities.push(e);
  }

  bench("handleOf + resolve round-trip (1000 live entities)", () => {
    let sum = 0;
    for (let i = 0; i < entities.length; i++) {
      const h = world.handleOf(entities[i]);
      const r = world.resolve(h);
      if (r !== null) sum += r as number;
    }
    if (sum < 0) throw new Error("unreachable");
  });
});

describe("generations: flush() despawn cost is unchanged by the generation bump", () => {
  bench("flush() despawn-all, read entityCount (control)", () => {
    const world = new World();
    const entities: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const e = world.spawn();
      world.add(e, CTag, { x: i });
      entities.push(e);
    }
    for (let i = 0; i < entities.length; i++) world.despawn(entities[i]);
    world.flush();
    if (world.entityCount !== 0) throw new Error("unreachable");
  });

  bench(
    "flush() despawn-all, stamped handle goes stale (generation bump)",
    () => {
      const world = new World();
      const entities: Entity[] = [];
      for (let i = 0; i < N; i++) {
        const e = world.spawn();
        world.add(e, CTag, { x: i });
        entities.push(e);
      }
      const h = world.handleOf(entities[0]);
      for (let i = 0; i < entities.length; i++) world.despawn(entities[i]);
      world.flush();
      if (world.isHandleValid(h)) throw new Error("unreachable");
    },
  );
});
