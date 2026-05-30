import { beforeEach, describe, expect, it } from "vitest";
import { ComponentStore, DEFAULT_MAX_ENTITIES } from "../src/store";
import type { Entity } from "../src/types";

function eid(n: number): Entity {
  return n as Entity;
}

interface Pos {
  x: number;
  y: number;
}

let store: ComponentStore<Pos>;

beforeEach(() => {
  store = new ComponentStore<Pos>();
});

describe("ComponentStore basics", () => {
  it("set then has/get/getUnsafe", () => {
    store.set(eid(1), { x: 1, y: 2 });
    expect(store.has(eid(1))).toBe(true);
    expect(store.get(eid(1))).toEqual({ x: 1, y: 2 });
    expect(store.getUnsafe(eid(1))).toEqual({ x: 1, y: 2 });
    expect(store.size()).toBe(1);
  });

  it("has/get on absent entity", () => {
    expect(store.has(eid(7))).toBe(false);
    expect(store.get(eid(7))).toBeUndefined();
  });

  it("set on existing entity overwrites in place, size unchanged", () => {
    store.set(eid(1), { x: 1, y: 1 });
    store.set(eid(1), { x: 9, y: 9 });
    expect(store.get(eid(1))).toEqual({ x: 9, y: 9 });
    expect(store.size()).toBe(1);
  });

  it("remove on absent entity is a no-op", () => {
    store.remove(eid(3));
    expect(store.size()).toBe(0);
  });
});

describe("swap-delete keeps arrays dense (iteration-order contract)", () => {
  it("removing a middle entity swaps the last into its slot", () => {
    store.set(eid(1), { x: 1, y: 0 });
    store.set(eid(2), { x: 2, y: 0 });
    store.set(eid(3), { x: 3, y: 0 });
    store.set(eid(4), { x: 4, y: 0 });
    expect([...store.iterEntities()]).toEqual([eid(1), eid(2), eid(3), eid(4)]);

    store.remove(eid(2));
    expect([...store.iterEntities()]).toEqual([eid(1), eid(4), eid(3)]);
    expect(store.size()).toBe(3);
    expect(store.iterData().map((d) => d.x)).toEqual([1, 4, 3]);
    expect(store.get(eid(4))).toEqual({ x: 4, y: 0 });
    expect(store.has(eid(2))).toBe(false);
  });

  it("removing the last entity does not reorder", () => {
    store.set(eid(1), { x: 1, y: 0 });
    store.set(eid(2), { x: 2, y: 0 });
    store.remove(eid(2));
    expect([...store.iterEntities()]).toEqual([eid(1)]);
  });

  it("dense arrays stay correct after interleaved add/remove", () => {
    for (let i = 1; i <= 6; i++) store.set(eid(i), { x: i, y: 0 });
    store.remove(eid(1));
    store.remove(eid(3));
    const ents = [...store.iterEntities()];
    expect(ents).toEqual([eid(6), eid(2), eid(5), eid(4)]);
    for (const e of ents) {
      expect(store.getUnsafe(e).x).toBe(e as number);
    }
  });
});

describe("clear", () => {
  it("empties the store and resets size", () => {
    store.set(eid(1), { x: 1, y: 1 });
    store.set(eid(2), { x: 2, y: 2 });
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.has(eid(1))).toBe(false);
    expect([...store.iterEntities()]).toEqual([]);
  });

  it("set after clear works", () => {
    store.set(eid(1), { x: 1, y: 1 });
    store.clear();
    store.set(eid(2), { x: 2, y: 2 });
    expect(store.get(eid(2))).toEqual({ x: 2, y: 2 });
    expect(store.size()).toBe(1);
  });
});

describe("capacity", () => {
  it("defaults to DEFAULT_MAX_ENTITIES", () => {
    expect(DEFAULT_MAX_ENTITIES).toBe(65536);
    const big = new ComponentStore<Pos>();
    big.set(eid(65535), { x: 1, y: 1 });
    expect(big.has(eid(65535))).toBe(true);
  });

  it("has() returns false for ids at/over a custom capacity", () => {
    const small = new ComponentStore<Pos>(4);
    small.set(eid(3), { x: 1, y: 1 });
    expect(small.has(eid(3))).toBe(true);
    expect(small.has(eid(4))).toBe(false);
    expect(small.has(eid(99))).toBe(false);
  });

  it("set/remove/markChanged throw for ids at/over capacity", () => {
    const small = new ComponentStore<Pos>(4);
    expect(() => small.set(eid(4), { x: 1, y: 1 })).toThrow(/exceeds capacity/);
    expect(() => small.remove(eid(4))).toThrow(/exceeds capacity/);
    expect(() => small.markChanged(eid(9))).toThrow(/exceeds capacity/);
    expect(() => small.set(eid(3), { x: 1, y: 1 })).not.toThrow();
  });
});

describe("pooling (opt-in)", () => {
  it("is OFF by default: remove does not reset, acquire returns undefined", () => {
    expect(store.isPooling()).toBe(false);
    const obj = { x: 5, y: 5 };
    store.set(eid(1), obj);
    store.remove(eid(1));
    expect(obj.x).toBe(5);
    expect(store.acquire()).toBeUndefined();
    expect(store.pooledCount()).toBe(0);
  });

  it("when enabled: remove resets and parks the object, acquire hands it back", () => {
    store.enablePooling((c) => {
      c.x = 0;
      c.y = 0;
    });
    expect(store.isPooling()).toBe(true);

    const obj = { x: 5, y: 7 };
    store.set(eid(1), obj);
    store.remove(eid(1));

    expect(obj).toEqual({ x: 0, y: 0 });
    expect(store.pooledCount()).toBe(1);

    const reused = store.acquire();
    expect(reused).toBe(obj);
    expect(store.pooledCount()).toBe(0);
    expect(store.acquire()).toBeUndefined();
  });

  it("pooling captures the removed object even on a swap-delete", () => {
    store.enablePooling((c) => {
      c.x = -1;
      c.y = -1;
    });
    const a = { x: 1, y: 1 };
    const b = { x: 2, y: 2 };
    store.set(eid(1), a);
    store.set(eid(2), b);
    store.remove(eid(1));
    expect(a).toEqual({ x: -1, y: -1 });
    expect(store.get(eid(2))).toBe(b);
    expect(store.acquire()).toBe(a);
  });

  it("clear() empties the free list too", () => {
    store.enablePooling((c) => {
      c.x = 0;
      c.y = 0;
    });
    store.set(eid(1), { x: 1, y: 1 });
    store.remove(eid(1));
    expect(store.pooledCount()).toBe(1);
    store.clear();
    expect(store.pooledCount()).toBe(0);
  });
});
