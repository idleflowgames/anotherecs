import { bench, describe } from "vitest";
import { type Entity, type EntityRef, World } from "../src/index";

const N = 5000;

describe("entity-refs: ref()+deref() hot loop (backrefs OFF)", () => {
  bench("ref()+deref(): one pack + alive/gen check, no Map touch", () => {
    const world = new World();
    const ents: Entity[] = [];
    const refs: EntityRef[] = [];
    for (let i = 0; i < N; i++) ents.push(world.spawn());
    for (let i = 0; i < N; i++) refs.push(world.ref(ents[i]));
    let live = 0;
    for (let i = 0; i < N; i++) if (world.deref(refs[i]) !== null) live++;
    if (live < 0) throw new Error("unreachable");
  });

  bench("baseline: store raw Entity ids + world.isAlive", () => {
    const world = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < N; i++) ents.push(world.spawn());
    let live = 0;
    for (let i = 0; i < N; i++) if (world.isAlive(ents[i])) live++;
    if (live < 0) throw new Error("unreachable");
  });
});

describe("entity-refs: ref(target,holder) registration (backrefs ON)", () => {
  bench("includes()-dedupe + Map insert: N holders -> one target", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const holders: Entity[] = [];
    for (let i = 0; i < N; i++) holders.push(world.spawn());
    for (let i = 0; i < N; i++) world.ref(target, holders[i]);
  });

  bench("baseline: no-dedupe push into a plain array", () => {
    const world = new World();
    const target = world.spawn();
    const holders: Entity[] = [];
    for (let i = 0; i < N; i++) holders.push(world.spawn());
    const list: Entity[] = [];
    for (let i = 0; i < N; i++) {
      world.ref(target, holders[i]);
      list.push(holders[i]);
    }
    if (list.length < 0) throw new Error("unreachable");
  });
});

describe("entity-refs: flush() sweep cost", () => {
  bench("flush sweeps N despawned targets' edges (backrefs ON)", () => {
    const world = new World();
    world.enableBackrefs();
    const targets: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const t = world.spawn();
      const h = world.spawn();
      world.ref(t, h);
      targets.push(t);
    }
    for (let i = 0; i < N; i++) world.despawn(targets[i]);
    world.flush();
  });

  bench("baseline: flush the same despawn batch (backrefs OFF)", () => {
    const world = new World();
    const targets: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const t = world.spawn();
      world.spawn();
      targets.push(t);
    }
    for (let i = 0; i < N; i++) world.despawn(targets[i]);
    world.flush();
  });
});
