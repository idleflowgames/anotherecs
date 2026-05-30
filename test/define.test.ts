import { describe, expect, it } from "vitest";
import {
  type Bitmask,
  type ComponentType,
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type Entity,
  TAG_VALUE,
  World,
} from "../src/index";

describe("defineComponent", () => {
  it("assigns unique, ascending ids", () => {
    const A = defineComponent("A");
    const B = defineComponent("B");
    const C = defineComponent("C");
    expect(B.id).toBe(A.id + 1);
    expect(C.id).toBe(B.id + 1);
  });

  it("stores the name", () => {
    expect(defineComponent("Widget").name).toBe("Widget");
  });

  it("direct style (name only): create/reset are undefined", () => {
    const D = defineComponent<{ hp: number }>("DirectStyle");
    expect(D.create).toBeUndefined();
    expect(D.reset).toBeUndefined();
  });

  it("factory style: create returns fresh instances, reset restores baseline", () => {
    const Pos = defineComponent(
      "FactoryStyle",
      () => ({ x: 0, y: 0 }),
      (c) => {
        c.x = 0;
        c.y = 0;
      },
    );
    const a = Pos.create?.();
    const b = Pos.create?.();
    expect(a).not.toBe(b);
    expect(a).toEqual({ x: 0, y: 0 });

    const mutated = { x: 9, y: -3 };
    Pos.reset?.(mutated);
    expect(mutated).toEqual({ x: 0, y: 0 });
  });
});

describe("defineTag (zero-sized presence-only components)", () => {
  it("assigns a component id from the shared counter and has no factory", () => {
    const Prev = defineComponent("TagSharedCounterPrev");
    const T = defineTag("TagShared");
    expect(T.id).toBe(Prev.id + 1);
    expect(T.tag).toBe(true);
    expect(T.create).toBeUndefined();
    expect(T.reset).toBeUndefined();
    expect(T.name).toBe("TagShared");
  });

  it("addTag stores presence with the shared TAG_VALUE and no allocation", () => {
    const world = new World();
    const T = defineTag("TagPresence");
    const e1 = world.spawn();
    const e2 = world.spawn();
    world.addTag(e1, T);
    world.addTag(e2, T);

    expect(world.hasTag(e1, T)).toBe(true);
    expect(world.has(e1, T)).toBe(true);
    expect(world.get(e1, T)).toBe(TAG_VALUE);
    expect(world.get(e1, T)).toBe(world.get(e2, T));
  });

  it("tags participate in queries exactly like components", () => {
    const world = new World();
    const CPos = defineComponent<{ x: number }>("TagQueryPos");
    const T = defineTag("TagQueryTag");
    const tagged = world.spawn();
    const plain = world.spawn();
    world.add(tagged, CPos, { x: 1 });
    world.add(plain, CPos, { x: 2 });
    world.addTag(tagged, T);

    const results = world.query(CPos, T);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe(tagged);
    expect(results[0][2]).toBe(TAG_VALUE);
  });

  it("addTag is idempotent on version; removeTag bumps only on real removal", () => {
    const world = new World();
    const T = defineTag("TagVersion");
    const e = world.spawn();

    const v0 = world.version;
    world.addTag(e, T);
    world.addTag(e, T);
    expect(world.version).toBe(v0 + 1);

    const v1 = world.version;
    world.removeTag(e, T);
    expect(world.version).toBe(v1 + 1);
    world.removeTag(e, T);
    expect(world.version).toBe(v1 + 1);
  });

  it("tag is removed on despawn/flush (row cleared, index stays enabled)", () => {
    const world = new World().enableBitmask();
    const T = defineTag("TagDespawn");
    const e = world.spawn();
    world.addTag(e, T);
    expect(world.store(T).size()).toBe(1);

    world.despawn(e);
    world.flush();

    expect(world.store(T).size()).toBe(0);
    expect(world.isBitmaskEnabled()).toBe(true);
    expect(world.hasMask(e, T)).toBe(false);
  });
});

describe("component bitmask index (opt-in)", () => {
  it("is disabled by default and the mask methods throw", () => {
    const world = new World();
    const CA = defineComponent<{ x: number }>("MaskDefaultA");
    expect(world.isBitmaskEnabled()).toBe(false);
    expect(() => world.hasMask(1 as Entity, CA)).toThrow();
    expect(() =>
      world.hasAllMask(1 as Entity, [CA] as ComponentType<unknown>[]),
    ).toThrow();
  });

  it("enableBitmask back-fills existing membership", () => {
    const world = new World();
    const CA = defineComponent<{ x: number }>("MaskBackfillA");
    const CB = defineComponent<{ y: number }>("MaskBackfillB");
    const CC = defineComponent<{ z: number }>("MaskBackfillC");
    const ents: Entity[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.spawn();
      world.add(e, CA, { x: i });
      if (i % 2 === 0) world.add(e, CB, { y: i });
      ents.push(e);
    }
    world.enableBitmask();
    for (const e of ents) {
      expect(world.hasMask(e, CA)).toBe(world.has(e, CA));
      expect(world.hasMask(e, CB)).toBe(world.has(e, CB));
      expect(world.hasMask(e, CC)).toBe(false);
    }
  });

  it("hasMask tracks add/remove/addComponent/removeComponent/despawn", () => {
    const world = new World().enableBitmask();
    const CData = defineComponent<{ x: number }>("MaskTrackData");
    const CPool = defineComponent(
      "MaskTrackPool",
      () => ({ n: 0 }),
      (c) => {
        c.n = 0;
      },
    );
    const e = world.spawn();

    world.add(e, CData, { x: 1 });
    expect(world.hasMask(e, CData)).toBe(world.has(e, CData));
    expect(world.hasMask(e, CData)).toBe(true);

    world.remove(e, CData);
    expect(world.hasMask(e, CData)).toBe(world.has(e, CData));
    expect(world.hasMask(e, CData)).toBe(false);

    world.addComponent(e, CPool, { n: 2 });
    expect(world.hasMask(e, CPool)).toBe(world.has(e, CPool));
    expect(world.hasMask(e, CPool)).toBe(true);

    world.removeComponent(e, CPool);
    expect(world.hasMask(e, CPool)).toBe(world.has(e, CPool));
    expect(world.hasMask(e, CPool)).toBe(false);

    world.addComponent(e, CPool, { n: 3 });
    world.despawn(e);
    world.flush();
    expect(world.hasMask(e, CPool)).toBe(false);
  });

  it("hasMask agrees with has across a scripted op sequence (parity)", () => {
    const world = new World().enableBitmask();
    const CA = defineComponent<{ x: number }>("MaskParityA");
    const CB = defineComponent<{ y: number }>("MaskParityB");
    const T = defineTag("MaskParityT");
    const comps: ComponentType<unknown>[] = [
      CA as ComponentType<unknown>,
      CB as ComponentType<unknown>,
      T as ComponentType<unknown>,
    ];
    const ents: Entity[] = [];
    for (let i = 0; i < 8; i++) ents.push(world.spawn());

    world.add(ents[0], CA, { x: 0 });
    world.add(ents[1], CA, { x: 1 });
    world.add(ents[1], CB, { y: 1 });
    world.addTag(ents[2], T);
    world.add(ents[3], CB, { y: 3 });
    world.addTag(ents[3], T);
    world.remove(ents[1], CA);
    world.add(ents[4], CA, { x: 4 });
    world.removeTag(ents[3], T);
    world.despawn(ents[0]);
    world.flush();
    world.add(ents[5], CB, { y: 5 });
    world.addTag(ents[6], T);

    for (const e of ents) {
      for (const c of comps) {
        expect(world.hasMask(e, c)).toBe(world.has(e, c));
      }
    }
  });

  it("hasAllMask matches the conjunction of has() and caches the signature", () => {
    const world = new World().enableBitmask();
    const CA = defineComponent<{ x: number }>("MaskAllA");
    const CB = defineComponent<{ y: number }>("MaskAllB");
    const T = defineTag("MaskAllT");
    const ents: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      const e = world.spawn();
      if (i % 2 === 0) world.add(e, CA, { x: i });
      if (i % 3 === 0) world.add(e, CB, { y: i });
      if (i % 2 === 1) world.addTag(e, T);
      ents.push(e);
    }

    const conj = [CA, CB] as ComponentType<unknown>[];
    for (const e of ents) {
      expect(world.hasAllMask(e, conj)).toBe(
        world.has(e, CA) && world.has(e, CB),
      );
    }
    world.hasAllMask(ents[0], conj);
    const sigs = (world as unknown as { maskSigs: Map<string, Uint32Array> })
      .maskSigs;
    expect(sigs.size).toBe(1);
  });

  it("survives high component ids (word growth) preserving low-id rows", () => {
    const world = new World();
    const CLow = defineComponent<{ x: number }>("MaskGrowLow");
    const e = world.spawn();
    world.add(e, CLow, { x: 1 });
    world.enableBitmask();
    const bm = (world as unknown as { bitmask: Bitmask }).bitmask;
    expect(bm.wordsPerEntity).toBe(1);

    let CHigh = defineComponent<{ v: number }>("MaskGrowFiller0");
    while (CHigh.id < 32) {
      CHigh = defineComponent<{ v: number }>(`MaskGrowFiller${CHigh.id}`);
    }
    world.add(e, CHigh, { v: 9 });

    expect(world.hasMask(e, CHigh)).toBe(true);
    expect(world.hasMask(e, CLow)).toBe(true);
    expect(bm.wordsPerEntity).toBeGreaterThanOrEqual(2);
  });

  it("clear() with bitmask enabled drops all bits but stays enabled", () => {
    const world = new World().enableBitmask();
    const CA = defineComponent<{ x: number }>("MaskClearA");
    const T = defineTag("MaskClearT");
    const old = world.spawn();
    world.add(old, CA, { x: 1 });
    world.addTag(old, T);
    expect(world.hasMask(old, CA)).toBe(true);

    world.clear();
    expect(world.isBitmaskEnabled()).toBe(true);
    expect(world.hasMask(old, CA)).toBe(false);

    const fresh = world.spawn();
    world.addTag(fresh, T);
    expect(world.hasMask(fresh, T)).toBe(true);
    expect(world.hasMask(fresh, CA)).toBe(false);
  });

  it("enableBitmask is idempotent (keeps the same index)", () => {
    const world = new World();
    const CA = defineComponent<{ x: number }>("MaskIdempotentA");
    const e = world.spawn();
    world.add(e, CA, { x: 1 });
    world.enableBitmask();
    const first = (world as unknown as { bitmask: Bitmask }).bitmask;
    world.enableBitmask();
    const second = (world as unknown as { bitmask: Bitmask }).bitmask;
    expect(second).toBe(first);
    expect(world.hasMask(e, CA)).toBe(true);
  });
});

describe("defineResource / defineEvent", () => {
  it("resources get unique ascending ids and keep their name", () => {
    const a = defineResource<number>("ra");
    const b = defineResource<string>("rb");
    expect(b.id).toBe(a.id + 1);
    expect(a.name).toBe("ra");
  });

  it("events get unique ascending ids and keep their name", () => {
    const a = defineEvent<number>("ea");
    const b = defineEvent("eb");
    expect(b.id).toBe(a.id + 1);
    expect(a.name).toBe("ea");
  });
});

describe("Bitmask: bit-31 conjunctions (signed-int32 coercion guard)", () => {
  it("hasAllMask is correct for a component on bit 31 of its word", () => {
    const world = new World();
    // Pad the module-global id counter until a def lands on bit 31 of its word
    // (id % 32 === 31): the high bit makes the signature word 0x80000000, which
    // a naive `&` compares as a negative int32.
    let C31 = defineComponent("pad31");
    while (C31.id % 32 !== 31) C31 = defineComponent("pad31");
    const CLow = defineComponent("lowbit");

    world.enableBitmask();
    const e = world.spawn();
    world.add(e, C31, { v: 1 });
    world.add(e, CLow, { v: 2 });

    expect(world.hasMask(e, C31)).toBe(true);
    expect(world.hasAllMask(e, [C31])).toBe(true);
    expect(world.hasAllMask(e, [C31, CLow])).toBe(true);
    expect(world.hasAllMask(e, [C31, CLow])).toBe(
      world.has(e, C31) && world.has(e, CLow),
    );
  });
});
