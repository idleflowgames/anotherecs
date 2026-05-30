import { describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

const C = defineComponent<{ hp: number }>("TrackC");

describe("Change tracking: disabled by default", () => {
  it("an untracked store records nothing", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, C, { hp: 1 });
    world.remove(e, C);

    expect(world.added(C)).toHaveLength(0);
    expect(world.removed(C)).toHaveLength(0);
    expect(world.changed(C)).toHaveLength(0);
    expect(world.store(C).isTracking()).toBe(false);
  });

  it("untracked reads return the same shared empty array", () => {
    const world = new World();
    expect(world.added(C)).toBe(world.removed(C));
    expect(world.removed(C)).toBe(world.changed(C));
  });

  it("flush with no callbacks and no despawns is a no-op", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, C, { hp: 1 });
    const v = world.version;
    world.flush();
    expect(world.version).toBe(v);
    expect(world.isAlive(e)).toBe(true);
  });
});

describe("Change tracking: added", () => {
  it("records a real add only, in dense order", () => {
    const world = new World();
    world.trackChanges(C);
    const e1 = world.spawn();
    const e2 = world.spawn();
    const e3 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.add(e2, C, { hp: 2 });
    world.add(e3, C, { hp: 3 });

    expect(world.added(C)).toEqual([e1, e2, e3]);

    world.add(e1, C, { hp: 9 });
    expect(world.added(C)).toEqual([e1, e2, e3]);
  });

  it("does not retroactively record members present before trackChanges", () => {
    const world = new World();
    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.trackChanges(C);
    expect(world.added(C)).toHaveLength(0);

    const e2 = world.spawn();
    world.add(e2, C, { hp: 2 });
    expect(world.added(C)).toEqual([e2]);
  });
});

describe("Change tracking: removed", () => {
  it("captures removed before swap-delete, dense order preserved", () => {
    const world = new World();
    world.trackChanges(C);
    const e: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const id = world.spawn();
      world.add(id, C, { hp: i });
      e.push(id);
    }
    world.remove(e[1], C);
    expect(world.removed(C)).toEqual([e[1]]);
    const order = world
      .store(C)
      .iterEntities()
      .map((x) => x as number);
    expect(order).toEqual([e[0], e[3], e[2]] as number[]);
  });

  it("removing an absent entity records nothing", () => {
    const world = new World();
    world.trackChanges(C);
    const e = world.spawn();
    world.remove(e, C);
    expect(world.removed(C)).toHaveLength(0);
  });

  it("despawn flush records removed for tracked stores", () => {
    const world = new World();
    world.trackChanges(C);
    const e = world.spawn();
    world.add(e, C, { hp: 1 });
    world.despawn(e);
    expect(world.removed(C)).toHaveLength(0);
    world.flush();
    expect(world.removed(C)).toEqual([e]);
  });
});

describe("Change tracking: changed", () => {
  it("markChanged records only present entities", () => {
    const world = new World();
    world.trackChanges(C);
    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.markChanged(e1, C);
    expect(world.changed(C)).toEqual([e1]);

    const e2 = world.spawn();
    world.markChanged(e2, C);
    expect(world.changed(C)).toEqual([e1]);

    world.markChanged(e1, C);
    expect(world.changed(C)).toEqual([e1, e1]);
  });

  it("getMut returns the live component and records changed", () => {
    const world = new World();
    world.trackChanges(C);
    const e1 = world.spawn();
    world.add(e1, C, { hp: 5 });

    const c = world.getMut(e1, C);
    expect(c).toBeDefined();
    if (c) c.hp = 3;
    expect(world.get(e1, C)?.hp).toBe(3);
    expect(world.changed(C)).toEqual([e1]);

    const e2 = world.spawn();
    expect(world.getMut(e2, C)).toBeUndefined();
    expect(world.changed(C)).toEqual([e1]);
  });
});

describe("Change tracking: drain & non-destructive reads", () => {
  it("clearChanges drains all three lists once per frame", () => {
    const world = new World();
    world.trackChanges(C);
    const e1 = world.spawn();
    const e2 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.add(e2, C, { hp: 2 });
    world.remove(e2, C);
    world.markChanged(e1, C);

    expect(world.added(C).length).toBeGreaterThan(0);
    expect(world.removed(C).length).toBeGreaterThan(0);
    expect(world.changed(C).length).toBeGreaterThan(0);

    world.clearChanges();
    expect(world.added(C)).toHaveLength(0);
    expect(world.removed(C)).toHaveLength(0);
    expect(world.changed(C)).toHaveLength(0);
  });

  it("clearChanges only drains tracked stores", () => {
    const world = new World();
    const D = defineComponent<{ n: number }>("TrackD");
    world.trackChanges(C);
    const e = world.spawn();
    world.add(e, C, { hp: 1 });
    world.add(e, D, { n: 1 });
    world.clearChanges();
    expect(world.added(C)).toHaveLength(0);
    expect(world.added(D)).toHaveLength(0);
    expect(world.store(D).isTracking()).toBe(false);
  });

  it("reads are non-destructive within a frame", () => {
    const world = new World();
    world.trackChanges(C);
    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    expect(world.added(C)).toEqual([e1]);
    expect(world.added(C)).toEqual([e1]);
  });
});

describe("Change tracking: callbacks fire inside flush", () => {
  it("onAdded fires after structural settle, in registration then dense order", () => {
    const world = new World();
    const seen: Entity[] = [];
    world.onAdded(C, (e) => {
      expect(world.has(e, C)).toBe(true);
      seen.push(e);
    });
    const e1 = world.spawn();
    const e2 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.add(e2, C, { hp: 2 });
    expect(seen).toHaveLength(0);
    world.flush();
    expect(seen).toEqual([e1, e2]);
  });

  it("onRemoved fires inside flush for despawned entities", () => {
    const world = new World();
    const seen: Entity[] = [];
    world.onRemoved(C, (e) => {
      expect(world.isAlive(e)).toBe(false);
      seen.push(e);
    });
    const e = world.spawn();
    world.add(e, C, { hp: 1 });
    world.despawn(e);
    world.flush();
    expect(seen).toEqual([e]);
  });

  it("onAdded fires on a frame with adds but no despawns", () => {
    const world = new World();
    const seen: Entity[] = [];
    world.onAdded(C, (e) => seen.push(e));
    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.flush();
    expect(seen).toEqual([e1]);
  });

  it("clear() drops registered callbacks but keeps tracking", () => {
    const world = new World();
    const seen: Entity[] = [];
    world.onAdded(C, (e) => seen.push(e));
    world.clear();
    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.flush();
    expect(seen).toHaveLength(0);
    expect(world.store(C).isTracking()).toBe(true);
    expect(world.added(C)).toEqual([e1]);
  });
});

describe("Change tracking: callbacks fire once per transition across flushes", () => {
  it("onAdded/onRemoved do not re-fire on repeated flush() before clearChanges()", () => {
    const world = new World();
    const added: Entity[] = [];
    const removed: Entity[] = [];
    world.onAdded(C, (e) => added.push(e));
    world.onRemoved(C, (e) => removed.push(e));

    const e1 = world.spawn();
    world.add(e1, C, { hp: 1 });
    world.flush();
    world.flush();
    world.flush();
    expect(added).toEqual([e1]);

    world.despawn(e1);
    world.flush();
    world.flush();
    expect(removed).toEqual([e1]);

    world.clearChanges();
    const e2 = world.spawn();
    world.add(e2, C, { hp: 2 });
    world.flush();
    world.flush();
    expect(added).toEqual([e1, e2]);
  });
});
