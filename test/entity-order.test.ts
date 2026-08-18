import { describe, expect, it } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  type Entity,
  Serializer,
  World,
} from "../src/index";

interface Marker {
  n: number;
}
const CMarker = defineComponent<Marker>("EntityOrderMarker");
const markerCodec: ComponentCodec<Marker> = {
  write(view, offset, c) {
    view.setFloat64(offset, c.n, true);
    return offset + 8;
  },
  read(view, offset) {
    return { value: { n: view.getFloat64(offset, true) }, offset: offset + 8 };
  },
};

interface Extra {
  v: number;
}
const CExtra = defineComponent<Extra>("EntityOrderExtra");
const extraCodec: ComponentCodec<Extra> = {
  write(view, offset, c) {
    view.setFloat64(offset, c.v, true);
    return offset + 8;
  },
  read(view, offset) {
    return { value: { v: view.getFloat64(offset, true) }, offset: offset + 8 };
  },
};

function scrambledWorld(): World {
  const world = new World();
  const ids: Entity[] = [];
  for (let i = 0; i < 8; i++) {
    const e = world.spawn();
    world.add(e, CMarker, { n: i });
    if (i % 3 === 0) world.add(e, CExtra, { v: i * 10 });
    ids.push(e);
  }
  // Swap-delete twice so the dense order diverges from ascending-id order.
  world.despawn(ids[1]);
  world.despawn(ids[4]);
  world.flush();
  return world;
}

function denseMarkers(world: World): number[] {
  const store = world.getStoreRaw(CMarker);
  return [...store.iterEntities()].map(
    (e) => (store.getUnsafe(e as Entity) as Marker).n,
  );
}

describe("SerializerOptions.entityOrder", () => {
  it("preserves a store's dense order across snapshot -> restore", () => {
    const world = scrambledWorld();
    const liveDense = denseMarkers(world);
    expect(liveDense).not.toEqual([...liveDense].sort((a, b) => a - b));

    const ser = new Serializer({
      entityOrder: (w) => {
        const dense = [...w.getStoreRaw(CMarker).iterEntities()];
        return dense as Entity[];
      },
    })
      .register(CMarker, markerCodec)
      .register(CExtra, extraCodec);

    const buf = ser.snapshot(world);
    const restored = new World();
    ser.restore(restored, buf);
    expect(denseMarkers(restored)).toEqual(liveDense);
  });

  it("without entityOrder, restore rebuilds ascending order (the old behavior)", () => {
    const world = scrambledWorld();
    const liveDense = denseMarkers(world);
    const ser = new Serializer()
      .register(CMarker, markerCodec)
      .register(CExtra, extraCodec);
    const restored = new World();
    ser.restore(restored, ser.snapshot(world));
    expect(denseMarkers(restored)).toEqual(
      [...liveDense].sort((a, b) => a - b),
    );
  });

  it("an ascending entityOrder is byte-identical to the default", () => {
    const world = scrambledWorld();
    const plain = new Serializer()
      .register(CMarker, markerCodec)
      .register(CExtra, extraCodec);
    const ascending = new Serializer({
      entityOrder: (w) =>
        [...w.getStoreRaw(CMarker).iterEntities()].sort(
          (a, b) => (a as number) - (b as number),
        ) as Entity[],
    })
      .register(CMarker, markerCodec)
      .register(CExtra, extraCodec);
    expect([...new Uint8Array(ascending.snapshot(world))]).toEqual([
      ...new Uint8Array(plain.snapshot(world)),
    ]);
  });

  it("rejects a non-permutation: short, duplicated, or foreign", () => {
    const world = scrambledWorld();
    const dense = [...world.getStoreRaw(CMarker).iterEntities()] as Entity[];
    const make = (order: readonly Entity[]): Serializer =>
      new Serializer({ entityOrder: () => order })
        .register(CMarker, markerCodec)
        .register(CExtra, extraCodec);
    expect(() => make(dense.slice(1)).snapshot(world)).toThrow(/alive/);
    expect(() =>
      make([dense[0], ...dense.slice(0, dense.length - 1)]).snapshot(world),
    ).toThrow(/duplicate/);
    expect(() =>
      make([9999 as Entity, ...dense.slice(1)]).snapshot(world),
    ).toThrow(/omitted/);
  });
});
