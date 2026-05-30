import { describe, expect, it } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

const CTag = defineComponent<{ v: number }>("GenTag");

describe("Entity handles round-trip while live", () => {
  it("handleOf round-trips to the same live entity", () => {
    const world = new World();
    const e = world.spawn();
    const h = world.handleOf(e);
    expect(world.resolve(h)).toBe(e);
    expect(world.isHandleValid(h)).toBe(true);
  });
});

describe("Handles invalidate exactly when despawn is applied", () => {
  it("handle stays valid until flush(), then becomes invalid", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, CTag, { v: 1 });
    const h = world.handleOf(e);

    world.despawn(e);
    expect(world.resolve(h)).toBe(e);
    expect(world.isHandleValid(h)).toBe(true);

    world.flush();
    expect(world.resolve(h)).toBeNull();
    expect(world.isHandleValid(h)).toBe(false);
  });
});

describe("Generation guards index reuse", () => {
  it("a stale handle does not alias a recycled-then-reused index", () => {
    const world = new World();
    const e1 = world.spawn();
    const h1 = world.handleOf(e1);
    world.despawn(e1);
    world.flush();

    const e2 = world.spawn();
    expect(e2).toBe(e1);

    expect(world.resolve(h1)).toBeNull();
    expect(world.resolve(world.handleOf(e2))).toBe(e2);
  });

  it("a fresh handle on the reused index is valid and distinct from the stale one", () => {
    const world = new World();
    const e1 = world.spawn();
    const h1 = world.handleOf(e1);
    world.despawn(e1);
    world.flush();

    const e2 = world.spawn();
    expect(e2).toBe(e1);
    const h2 = world.handleOf(e2);
    expect(world.resolve(h2)).toBe(e2);
    expect(h2).not.toBe(h1);
    expect(world.isHandleValid(h1)).toBe(false);
  });
});

describe("Generation only tracks applied despawns", () => {
  it("component churn and a queued despawn do not bump the generation", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, CTag, { v: 1 });
    const h = world.handleOf(e);

    world.remove(e, CTag);
    world.add(e, CTag, { v: 2 });
    expect(world.resolve(h)).toBe(e);

    world.despawn(e);
    expect(world.resolve(h)).toBe(e);

    world.flush();
    expect(world.resolve(h)).toBeNull();
  });
});

describe("clear() invalidates handles via the alive set", () => {
  it("handle survives clear() as invalid (alive set cleared, generations retained)", () => {
    const world = new World();
    const e = world.spawn();
    const h = world.handleOf(e);
    expect(world.resolve(h)).toBe(e);

    world.clear();
    expect(world.resolve(h)).toBeNull();
    expect(world.isHandleValid(h)).toBe(false);
  });
});

describe("Encoding is reversible without overflow or aliasing", () => {
  it("recovers (index, generation) across many generations and stays pairwise distinct", () => {
    const world = new World();
    const indexBits = Math.max(1, Math.ceil(Math.log2(65536)));
    const indexMask = 2 ** indexBits - 1;
    const radix = indexMask + 1;

    const handles: number[] = [];
    const stamped: { index: number; gen: number }[] = [];
    let prevIndex = -1;
    let genOfPrevIndex = 0;

    for (let i = 0; i < 1000; i++) {
      const e = world.spawn();
      const index = e as number;
      const gen = index === prevIndex ? genOfPrevIndex : 0;

      const h = world.handleOf(e) as unknown as number;
      handles.push(h);
      stamped.push({ index, gen });

      const decodedIndex = h & indexMask;
      const decodedGen = Math.floor(h / radix);
      expect(decodedIndex).toBe(index);
      expect(decodedGen).toBe(gen);
      expect(Number.isSafeInteger(h)).toBe(true);

      world.despawn(e);
      world.flush();
      prevIndex = index;
      genOfPrevIndex = gen + 1;
    }

    expect(new Set(handles).size).toBe(handles.length);
    expect(stamped).toHaveLength(1000);
  });
});

describe("clear() recovers the id space", () => {
  it("repeated spawn+clear cycles do not exhaust ids", () => {
    const world = new World({ maxEntities: 16 });
    for (let cycle = 0; cycle < 100; cycle++) {
      for (let i = 0; i < 4; i++) world.spawn();
      world.clear();
    }
    expect(world.entityCount).toBe(0);
    expect(() => world.spawn()).not.toThrow();
  });

  it("a pre-clear handle does not alias a reused id after clear", () => {
    const world = new World({ maxEntities: 16 });
    const e1 = world.spawn();
    const h1 = world.handleOf(e1);

    world.clear();
    const e2 = world.spawn();
    expect(e2).toBe(e1); // id reissued from 1
    expect(world.resolve(h1)).toBeNull(); // stale handle must not resolve to e2
    expect(world.resolve(world.handleOf(e2))).toBe(e2);
  });
});

describe("Handle encoding safe-integer ceiling", () => {
  it("rejects maxEntities above 2^21", () => {
    expect(() => new World({ maxEntities: 2 ** 21 })).not.toThrow();
    expect(() => new World({ maxEntities: 2 ** 21 + 1 })).toThrow(
      /maxEntities/,
    );
  });
});

describe("Custom maxEntities adjusts the bit split", () => {
  it("round-trips and invalidates under a non-default capacity (indexBits=10)", () => {
    const world = new World({ maxEntities: 1024 });
    let e: Entity = world.spawn();
    const firstIndex = e as number;
    let h = world.handleOf(e);
    for (let i = 0; i < 5; i++) {
      world.despawn(e);
      world.flush();
      expect(world.resolve(h)).toBeNull();
      e = world.spawn();
      expect(e as number).toBe(firstIndex);
      h = world.handleOf(e);
      expect(world.resolve(h)).toBe(e);
    }
    expect(world.isHandleValid(h)).toBe(true);
  });
});
