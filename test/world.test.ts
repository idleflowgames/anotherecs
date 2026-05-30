import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineComponent,
  defineResource,
  type Entity,
  World,
} from "../src/index";

const CPos = defineComponent(
  "Pos",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);
const CVel = defineComponent(
  "Vel",
  () => ({ vx: 0, vy: 0 }),
  (c) => {
    c.vx = 0;
    c.vy = 0;
  },
);

interface Health {
  hp: number;
}
const CHealth = defineComponent<Health>("Health");

let world: World;

beforeEach(() => {
  world = new World();
});

describe("Entity lifecycle", () => {
  it("spawn returns unique ids starting at 1 (0 reserved)", () => {
    const a = world.spawn();
    const b = world.spawn();
    expect(a).toBe(1 as Entity);
    expect(b).toBe(2 as Entity);
    expect(a).not.toBe(b);
  });

  it("spawned entity is alive; entityCount tracks it", () => {
    expect(world.entityCount).toBe(0);
    const e = world.spawn();
    expect(world.isAlive(e)).toBe(true);
    expect(world.entityCount).toBe(1);
  });

  it("despawn is deferred: entity stays alive until flush", () => {
    const e = world.spawn();
    world.despawn(e);
    expect(world.isAlive(e)).toBe(true);
    world.flush();
    expect(world.isAlive(e)).toBe(false);
    expect(world.entityCount).toBe(0);
  });

  it("flush with nothing pending is a no-op", () => {
    world.spawn();
    world.flush();
    expect(world.entityCount).toBe(1);
  });

  it("recycles ids LIFO after flush", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.despawn(b);
    world.despawn(a);
    world.flush();
    expect(world.spawn()).toBe(a);
    expect(world.spawn()).toBe(b);
  });

  it("recycled entity starts fresh with no components", () => {
    const e = world.spawn();
    world.add(e, CHealth, { hp: 99 });
    world.despawn(e);
    world.flush();
    const recycled = world.spawn();
    expect(recycled).toBe(e);
    expect(world.has(recycled, CHealth)).toBe(false);
  });

  it("double despawn applies once (dedup at flush via alive set)", () => {
    const e = world.spawn();
    const spy = vi.fn();
    world.onBeforeDestroy = spy;
    world.despawn(e);
    world.despawn(e);
    world.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(world.isAlive(e)).toBe(false);
  });
});

describe("Component access: core (add/get/has/remove)", () => {
  it("add stores the exact object passed", () => {
    const e = world.spawn();
    const hp: Health = { hp: 50 };
    world.add(e, CHealth, hp);
    expect(world.get(e, CHealth)).toBe(hp);
    expect(world.has(e, CHealth)).toBe(true);
  });

  it("get returns undefined for a missing component", () => {
    const e = world.spawn();
    expect(world.get(e, CHealth)).toBeUndefined();
  });

  it("remove deletes the component", () => {
    const e = world.spawn();
    world.add(e, CHealth, { hp: 1 });
    world.remove(e, CHealth);
    expect(world.has(e, CHealth)).toBe(false);
  });

  it("getFirst returns the only instance and throws when empty", () => {
    expect(() => world.getFirst(CHealth)).toThrow(/no entries/);
    const e = world.spawn();
    world.add(e, CHealth, { hp: 7 });
    expect(world.getFirst(CHealth)).toEqual({ hp: 7 });
  });

  it("flush strips all components from despawned entities", () => {
    const e = world.spawn();
    world.add(e, CHealth, { hp: 1 });
    world.addComponent(e, CPos, { x: 1, y: 2 });
    world.despawn(e);
    world.flush();
    expect(world.get(e, CHealth)).toBeUndefined();
    expect(world.getComponent(e, CPos)).toBeUndefined();
  });
});

describe("Component access: factory sugar (addComponent/...)", () => {
  it("addComponent with a factory builds defaults, merges partial", () => {
    const e = world.spawn();
    const pos = world.addComponent(e, CPos, { x: 10 });
    expect(pos).toEqual({ x: 10, y: 0 });
  });

  it("addComponent with no data returns factory defaults", () => {
    const e = world.spawn();
    expect(world.addComponent(e, CPos)).toEqual({ x: 0, y: 0 });
  });

  it("addComponent twice reuses the instance and merges", () => {
    const e = world.spawn();
    const first = world.addComponent(e, CPos, { x: 1, y: 2 });
    const second = world.addComponent(e, CPos, { x: 10 });
    expect(first).toBe(second);
    expect(first).toEqual({ x: 10, y: 2 });
  });

  it("getOrThrow throws on missing, returns on present", () => {
    const e = world.spawn();
    expect(() => world.getOrThrow(e, CPos)).toThrow(/missing component Pos/);
    world.addComponent(e, CPos, { x: 5, y: 0 });
    expect(world.getOrThrow(e, CPos).x).toBe(5);
  });

  it("hasComponent / removeComponent behave as aliases", () => {
    const e = world.spawn();
    expect(world.hasComponent(e, CPos)).toBe(false);
    world.addComponent(e, CPos);
    expect(world.hasComponent(e, CPos)).toBe(true);
    world.removeComponent(e, CPos);
    expect(world.hasComponent(e, CPos)).toBe(false);
  });

  it("count is O(1) store size; getStoreRaw exposes the dense store", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(b, CPos);
    expect(world.count(CPos)).toBe(2);
    expect(world.count(CVel)).toBe(0);
    const raw = world.getStoreRaw(CPos);
    expect(raw.size()).toBe(2);
  });
});

describe("Version counter", () => {
  it("addComponent (new) bumps; overwrite does not", () => {
    const e = world.spawn();
    const v0 = world.version;
    world.addComponent(e, CPos);
    expect(world.version).toBe(v0 + 1);
    world.addComponent(e, CPos, { x: 5 });
    expect(world.version).toBe(v0 + 1);
  });

  it("removeComponent (existing) bumps; absent does not", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    const v1 = world.version;
    world.removeComponent(e, CPos);
    expect(world.version).toBe(v1 + 1);
    world.removeComponent(e, CPos);
    expect(world.version).toBe(v1 + 1);
  });

  it("flush bumps once per destroyed entity", () => {
    const a = world.spawn();
    const b = world.spawn();
    world.addComponent(a, CPos);
    world.addComponent(b, CPos);
    world.despawn(a);
    world.despawn(b);
    const v1 = world.version;
    world.flush();
    expect(world.version).toBe(v1 + 2);
  });
});

describe("onBeforeDestroy", () => {
  it("fires once per removed entity, before components are stripped", () => {
    const e = world.spawn();
    world.addComponent(e, CPos, { x: 42, y: 99 });
    world.despawn(e);

    let seenX = -1;
    world.onBeforeDestroy = (entity) => {
      const pos = world.getComponent(entity, CPos);
      if (pos) seenX = pos.x;
    };
    world.flush();
    expect(seenX).toBe(42);
    expect(world.getComponent(e, CPos)).toBeUndefined();
  });

  it("null callback is safe", () => {
    const e = world.spawn();
    world.despawn(e);
    world.onBeforeDestroy = null;
    expect(() => world.flush()).not.toThrow();
  });

  it("not called for entities already dead before this flush", () => {
    const e = world.spawn();
    world.despawn(e);
    world.flush();
    const spy = vi.fn();
    world.onBeforeDestroy = spy;
    world.despawn(e);
    world.flush();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Resources", () => {
  const RScore = defineResource<number>("score");
  const RConfig = defineResource<{ name: string }>("config");

  it("token resources: set/get; get throws when unset", () => {
    expect(() => world.getResource(RScore)).toThrow(/not set/);
    world.setResource(RScore, 42);
    expect(world.getResource(RScore)).toBe(42);
    world.setResource(RScore, 7);
    expect(world.getResource(RScore)).toBe(7);
  });

  it("tryGetResource returns undefined when unset", () => {
    expect(world.tryGetResource(RConfig)).toBeUndefined();
    world.setResource(RConfig, { name: "x" });
    expect(world.tryGetResource(RConfig)).toEqual({ name: "x" });
  });

  it("string-keyed overload: set/get; get returns undefined when unset", () => {
    expect(world.getResource<number>("runState")).toBeUndefined();
    world.setResource("runState", 99);
    expect(world.getResource<number>("runState")).toBe(99);
  });

  it("token and string namespaces are independent", () => {
    const RName = defineResource<string>("name");
    world.setResource(RName, "token");
    world.setResource("name", "string");
    expect(world.getResource(RName)).toBe("token");
    expect(world.getResource<string>("name")).toBe("string");
  });
});

describe("Component pooling via World.enablePooling", () => {
  it("reuses a reset object on the next addComponent after despawn", () => {
    world.enablePooling(CPos);
    const a = world.spawn();
    const first = world.addComponent(a, CPos, { x: 5, y: 6 });
    world.despawn(a);
    world.flush();

    const b = world.spawn();
    const second = world.addComponent(b, CPos, { x: 1, y: 2 });
    expect(second).toBe(first);
    expect(second).toEqual({ x: 1, y: 2 });
  });
});

describe("clear", () => {
  it("wipes entities, components, resources, and events", () => {
    const RScore = defineResource<number>("clearScore");
    const e = world.spawn();
    world.addComponent(e, CPos);
    world.setResource(RScore, 1);
    world.setResource("k", 2);
    world.clear();
    expect(world.entityCount).toBe(0);
    expect(world.count(CPos)).toBe(0);
    expect(world.tryGetResource(RScore)).toBeUndefined();
    expect(world.getResource<number>("k")).toBeUndefined();
  });
});
