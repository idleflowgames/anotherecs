import { describe, expect, it } from "vitest";
import {
  defineComponent,
  defineLocal,
  defineResource,
  type Entity,
  Schedule,
  type System,
  World,
} from "../src/index";

describe("local() lazily initializes once and returns a stable reference", () => {
  it("inits at most once and hands back the same object across calls", () => {
    let calls = 0;
    const L = defineLocal<{ n: number }>("t1", () => {
      calls++;
      return { n: 0 };
    });
    const world = new World();

    expect(world.hasLocal(L)).toBe(false);

    const a = world.local(L);
    expect(world.hasLocal(L)).toBe(true);
    expect(a.n).toBe(0);
    expect(calls).toBe(1);

    a.n = 5;
    const b = world.local(L);
    expect(b).toBe(a);
    expect(b.n).toBe(5);
    world.local(L);
    world.local(L);
    expect(calls).toBe(1);
  });
});

describe("local state persists across Schedule frames and is private per token", () => {
  it("a system's local survives frames; a second token is isolated", () => {
    const A = defineLocal<{ n: number }>("A", () => ({ n: 0 }));
    const B = defineLocal<{ n: number }>("B", () => ({ n: 100 }));
    const world = new World();

    const bumpA: System = (w) => {
      w.local(A).n++;
    };
    const schedule = new Schedule().addGroup("tick", bumpA);
    schedule.run(world);
    schedule.run(world);
    schedule.run(world);
    expect(world.local(A).n).toBe(3);

    const bumpB: System = (w) => {
      w.local(B).n++;
    };
    new Schedule().addGroup("tick", bumpB).run(world);
    expect(world.local(A).n).toBe(3);
    expect(world.local(B).n).toBe(101);
  });
});

describe("init returning undefined is treated as initialized (no re-init)", () => {
  it("an undefined initial value still counts as initialized", () => {
    let calls = 0;
    const U = defineLocal<number | undefined>("u", () => {
      calls++;
      return undefined;
    });
    const world = new World();

    expect(world.local(U)).toBeUndefined();
    expect(world.hasLocal(U)).toBe(true);
    expect(calls).toBe(1);

    expect(world.local(U)).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("resetLocal forces re-initialization from init", () => {
  it("reset rebuilds a fresh value; reset on a never-init token is a no-op", () => {
    const L = defineLocal<{ n: number }>("r", () => ({ n: 0 }));
    const world = new World();

    const first = world.local(L);
    first.n = 9;
    world.resetLocal(L);
    expect(world.hasLocal(L)).toBe(false);

    const rebuilt = world.local(L);
    expect(rebuilt.n).toBe(0);
    expect(rebuilt).not.toBe(first);

    const Never = defineLocal<{ n: number }>("never", () => ({ n: 0 }));
    expect(() => world.resetLocal(Never)).not.toThrow();
    expect(world.hasLocal(Never)).toBe(false);
  });
});

describe("clear() forgets locals; next access rebuilds", () => {
  it("clear drops locals and resources independently, without throwing", () => {
    const L = defineLocal<{ n: number }>("c", () => ({ n: 0 }));
    const R = defineResource<number>("cRes");
    const world = new World();

    world.local(L).n = 7;
    world.setResource(R, 42);
    expect(world.hasLocal(L)).toBe(true);
    expect(world.getResource(R)).toBe(42);

    expect(() => world.clear()).not.toThrow();

    expect(world.hasLocal(L)).toBe(false);
    expect(() => world.getResource(R)).toThrow();

    expect(world.local(L).n).toBe(0);
  });
});

describe("unused local tokens do not change world behavior", () => {
  const CObstacle = defineComponent<{ lane: number }>("LocalUnusedObstacle");
  const Unused = defineLocal<{ n: number }>("unused", () => ({ n: 0 }));

  function scriptedIterationOrder(): number[] {
    const world = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const e = world.spawn();
      world.add(e, CObstacle, { lane: i });
      ids.push(e);
    }
    world.remove(ids[2], CObstacle);
    world.remove(ids[0], CObstacle);
    world.remove(ids[5], CObstacle);
    return world
      .store(CObstacle)
      .iterEntities()
      .map((e) => e as number);
  }

  it("a never-accessed local token leaves dense order and counts identical", () => {
    const plain = scriptedIterationOrder();
    const plainWorld = new World();
    let plainCount = 0;
    {
      const ids: Entity[] = [];
      for (let i = 0; i < 8; i++) {
        const e = plainWorld.spawn();
        plainWorld.add(e, CObstacle, { lane: i });
        ids.push(e);
      }
      plainWorld.remove(ids[2], CObstacle);
      plainWorld.remove(ids[0], CObstacle);
      plainWorld.remove(ids[5], CObstacle);
      plainCount = plainWorld.entityCount;
    }

    expect(Unused.name).toBe("unused");
    const indexed = scriptedIterationOrder();
    const indexedWorld = new World();
    let indexedCount = 0;
    let indexedStoreSize = 0;
    {
      const ids: Entity[] = [];
      for (let i = 0; i < 8; i++) {
        const e = indexedWorld.spawn();
        indexedWorld.add(e, CObstacle, { lane: i });
        ids.push(e);
      }
      indexedWorld.remove(ids[2], CObstacle);
      indexedWorld.remove(ids[0], CObstacle);
      indexedWorld.remove(ids[5], CObstacle);
      indexedCount = indexedWorld.entityCount;
      indexedStoreSize = indexedWorld.store(CObstacle).size();
    }

    expect(indexed).toEqual(plain);
    expect(indexedCount).toBe(plainCount);
    expect(indexedStoreSize).toBe(plainWorld.store(CObstacle).size());
    expect(indexedWorld.hasLocal(Unused)).toBe(false);
  });
});
