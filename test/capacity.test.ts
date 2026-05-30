import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ENTITIES,
  defineComponent,
  type Entity,
  World,
} from "../src/index";

interface Mark {
  n: number;
}
const CMark = defineComponent<Mark>("CapMark");

describe("entity capacity", () => {
  it("defaults to DEFAULT_MAX_ENTITIES and spawns freely under it", () => {
    expect(DEFAULT_MAX_ENTITIES).toBe(65536);
    const w = new World();
    expect(() => {
      for (let i = 0; i < 1000; i++) w.spawn();
    }).not.toThrow();
  });

  it("spawning past a small maxEntities throws (not a silent no-op)", () => {
    const w = new World({ maxEntities: 4 });
    w.spawn();
    w.spawn();
    w.spawn();
    expect(() => w.spawn()).toThrow(/exceeds maxEntities/);
  });

  it("lazily-created stores honor the configured capacity", () => {
    const w = new World({ maxEntities: 8 });
    const e = w.spawn();
    w.add(e, CMark, { n: 1 });
    const store = w.getStoreRaw(CMark);
    expect(store.has(e)).toBe(true);
    expect(store.has(8 as Entity)).toBe(false);
    expect(store.has(99 as Entity)).toBe(false);
  });

  it("recycling keeps ids under the cap (no spurious overflow)", () => {
    const w = new World({ maxEntities: 4 });
    const a = w.spawn();
    const b = w.spawn();
    const c = w.spawn();
    expect(c).toBe(3 as Entity);
    w.despawn(a);
    w.despawn(b);
    w.flush();
    expect(() => {
      w.spawn();
      w.spawn();
    }).not.toThrow();
  });
});
