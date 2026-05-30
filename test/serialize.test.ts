import { describe, expect, it } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  defineResource,
  type Entity,
  jsonCodec,
  type ResourceCodec,
  Serializer,
  World,
} from "../src/index";

interface Position {
  x: number;
  y: number;
}
const CPosition = defineComponent<Position>("SerPosition");
const positionCodec: ComponentCodec<Position> = {
  write(view, offset, c) {
    view.setFloat64(offset, c.x, true);
    view.setFloat64(offset + 8, c.y, true);
    return offset + 16;
  },
  read(view, offset) {
    return {
      value: {
        x: view.getFloat64(offset, true),
        y: view.getFloat64(offset + 8, true),
      },
      offset: offset + 16,
    };
  },
};

interface Health {
  hp: number;
}
const CHealth = defineComponent<Health>("SerHealth");
const healthCodec: ComponentCodec<Health> = {
  write(view, offset, c) {
    view.setInt32(offset, c.hp, true);
    return offset + 4;
  },
  read(view, offset) {
    return { value: { hp: view.getInt32(offset, true) }, offset: offset + 4 };
  },
};

interface Link {
  target: number;
}
const CLink = defineComponent<Link>("SerLink");
const linkCodec: ComponentCodec<Link> = {
  write(view, offset, c) {
    view.setUint32(offset, c.target >>> 0, true);
    return offset + 4;
  },
  read(view, offset) {
    return {
      value: { target: view.getUint32(offset, true) },
      offset: offset + 4,
    };
  },
  refFields: ["target"],
};

function buildSerializer(): Serializer {
  return new Serializer()
    .register(CPosition, positionCodec)
    .register(CHealth, healthCodec)
    .register(CLink, linkCodec);
}

function bytesOf(buf: ArrayBuffer): number[] {
  return [...new Uint8Array(buf)];
}

describe("snapshot / restore round-trip", () => {
  it("reproduces store membership and component values", () => {
    const world = new World();
    const ser = buildSerializer();
    const ids: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const e = world.spawn();
      world.add(e, CPosition, { x: i, y: i * 2 });
      if (i % 2 === 0) world.add(e, CHealth, { hp: 100 + i });
      ids.push(e);
    }

    const buf = ser.snapshot(world);
    const dest = new World();
    ser.restore(dest, buf);

    expect(dest.entityCount).toBe(8);
    const posMembers = dest
      .query(CPosition)
      .map(([e]) => e as number)
      .sort((a, b) => a - b);
    expect(posMembers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [e, p] of dest.query(CPosition)) {
      const i = (e as number) - 1;
      expect(p).toEqual({ x: i, y: i * 2 });
    }
    expect(dest.count(CHealth)).toBe(4);
    for (const [e, h] of dest.query(CHealth)) {
      const i = (e as number) - 1;
      expect(h).toEqual({ hp: 100 + i });
    }
  });
});

describe("snapshot bytes are canonical regardless of swap-delete order", () => {
  it("two op orders reaching the same logical membership produce identical bytes", () => {
    const ser = buildSerializer();

    // World A: spawn ids 1..5 each with value keyed to its id, then remove id 3
    // via a direct store remove (swap-delete moves the last dense element into
    // id 3's slot, so A's dense store order is now 1,2,5,4).
    const a = new World();
    for (let i = 1; i <= 5; i++) a.add(a.spawn(), CPosition, { x: i, y: -i });
    a.remove(3 as Entity, CPosition);

    // World B: identical final logical set {1,2,4,5} keyed by id, but reached via
    // a despawn+flush route (a different operation path / dense order than A's).
    const b = new World();
    for (let i = 1; i <= 5; i++) b.add(b.spawn(), CPosition, { x: i, y: -i });
    b.despawn(3 as Entity);
    b.flush();

    // Despite different op histories and dense orders, the snapshots are byte
    // identical because entities are emitted in ascending index order.
    const snapA = ser.snapshot(a);
    const snapB = ser.snapshot(b);
    expect(bytesOf(snapB)).toEqual(bytesOf(snapA));
  });
});

describe("refFields remap on restore", () => {
  it("remaps to freshly-spawned ids; 0 stays 0; unmapped becomes 0", () => {
    const world = new World();
    const ser = buildSerializer();
    const e1 = world.spawn();
    const e2 = world.spawn();
    const e3 = world.spawn();
    world.add(e1, CLink, { target: e2 as number });
    world.add(e2, CLink, { target: 0 });
    world.add(e3, CLink, { target: 999 });

    const buf = ser.snapshot(world);

    const dest = new World();
    for (let i = 0; i < 5; i++) dest.spawn();
    dest.clear();
    ser.restore(dest, buf);

    const newIds = dest
      .query(CLink)
      .map(([e]) => e as number)
      .sort((a, b) => a - b);
    const [n1, n2, n3] = newIds;
    expect(dest.get(n1 as Entity, CLink)?.target).toBe(n2);
    expect(dest.get(n2 as Entity, CLink)?.target).toBe(0);
    expect(dest.get(n3 as Entity, CLink)?.target).toBe(0);
  });
});

describe("restore clears the destination world first", () => {
  it("existing entities, components, and resources are gone", () => {
    const Score = defineResource<{ score: number }>("SerScoreClear");
    const scoreCodec: ResourceCodec<{ score: number }> = {
      write(view, offset, v) {
        view.setInt32(offset, v.score, true);
        return offset + 4;
      },
      read(view, offset) {
        return {
          value: { score: view.getInt32(offset, true) },
          offset: offset + 4,
        };
      },
    };

    const src = new World();
    const ser = buildSerializer().registerResource(Score, scoreCodec);
    const e = src.spawn();
    src.add(e, CPosition, { x: 1, y: 1 });
    src.setResource(Score, { score: 7 });
    const buf = ser.snapshot(src);

    const dest = new World();
    const stray = dest.spawn();
    dest.add(stray, CHealth, { hp: 5 });
    dest.setResource("loose", 42);

    ser.restore(dest, buf);

    expect(dest.count(CHealth)).toBe(0);
    expect(dest.count(CPosition)).toBe(1);
    expect(dest.getResource(Score)).toEqual({ score: 7 });
    expect(dest.getResource("loose")).toBeUndefined();
  });
});

describe("delta emits only changed/added/removed since baseline", () => {
  it("applyDelta reproduces the live world; unchanged world emits an empty body", () => {
    const live = buildSerializer();
    const clone = buildSerializer();

    const a = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const e = a.spawn();
      a.add(e, CPosition, { x: i, y: i });
      ids.push(e);
    }
    const baseline = live.snapshot(a);

    const b = new World();
    clone.restore(b, baseline);

    const empty = live.delta(a);
    const er = new DataView(empty);
    expect(er.getUint32(0, true)).toBe(0x41454353);
    expect(er.getUint32(4, true)).toBe(2);
    expect(er.getUint32(12, true)).toBe(0);
    expect(er.getUint32(16, true)).toBe(0);
    clone.applyDelta(b, empty);

    a.add(ids[0], CPosition, { x: 100, y: 100 });
    const spawned = a.spawn();
    a.add(spawned, CPosition, { x: 9, y: 9 });
    a.despawn(ids[3]);
    a.flush();

    const d = live.delta(a);
    clone.applyDelta(b, d);

    expectWorldsEqual(b, a);
  });
});

describe("delta output is independent of whether change-tracking is enabled", () => {
  it("a shadow-only and a change-tracked world emit identical delta bytes", () => {
    function run(track: boolean): ArrayBuffer {
      const world = new World();
      if (track) {
        world.trackChanges(CPosition);
        world.trackChanges(CHealth);
      }
      const ser = buildSerializer();
      const ids: Entity[] = [];
      for (let i = 0; i < 5; i++) {
        const e = world.spawn();
        world.add(e, CPosition, { x: i, y: i });
        ids.push(e);
      }
      ser.snapshot(world);
      world.add(ids[1], CPosition, { x: 50, y: 50 });
      world.add(ids[2], CHealth, { hp: 30 });
      world.remove(ids[3], CPosition);
      if (track) world.clearChanges();
      return ser.delta(world);
    }

    const plain = run(false);
    const tracked = run(true);
    expect(bytesOf(tracked)).toEqual(bytesOf(plain));
  });
});

describe("applyDelta round-trips across multiple frames", () => {
  it("three successive (mutate; delta) frames keep B equal to A", () => {
    const liveSer = buildSerializer();
    const cloneSer = buildSerializer();

    const a = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      const e = a.spawn();
      a.add(e, CPosition, { x: i, y: i });
      ids.push(e);
    }
    const baseline = liveSer.snapshot(a);
    const b = new World();
    cloneSer.restore(b, baseline);

    for (let frame = 0; frame < 3; frame++) {
      a.add(ids[frame], CPosition, { x: 1000 + frame, y: -frame });
      const spawned = a.spawn();
      a.add(spawned, CHealth, { hp: frame });
      if (frame === 1) {
        a.despawn(ids[5]);
        a.flush();
      }
      const d = liveSer.delta(a);
      cloneSer.applyDelta(b, d);
      expectWorldsEqual(b, a);
    }
  });

  it("union model: losing the last registered component drops the entity; a remaining component persists it", () => {
    const a = new World();
    const liveSer = buildSerializer();
    const solo = a.spawn();
    a.add(solo, CPosition, { x: 1, y: 2 });
    const both = a.spawn();
    a.add(both, CPosition, { x: 3, y: 4 });
    a.add(both, CHealth, { hp: 9 });
    const baseline = liveSer.snapshot(a);

    const b = new World();
    const cloneSer = buildSerializer();
    cloneSer.restore(b, baseline);
    expect(b.entityCount).toBe(2);

    a.remove(solo, CPosition);
    a.remove(both, CPosition);
    cloneSer.applyDelta(b, liveSer.delta(a));

    expect(b.entityCount).toBe(1);
    expect(b.count(CPosition)).toBe(0);
    expect(b.count(CHealth)).toBe(1);
  });
});

describe("jsonCodec round-trips plain data including refFields", () => {
  interface Labelled {
    label: string;
    n: number;
    target: number;
  }
  const CLabelled = defineComponent<Labelled>("SerLabelled");

  it("string + number exact, target remapped, identical state is byte-identical", () => {
    const ser = new Serializer().register(
      CLabelled,
      jsonCodec<Labelled>(["target"]),
    );
    const world = new World();
    const e1 = world.spawn();
    const e2 = world.spawn();
    world.add(e1, CLabelled, { label: "alpha", n: 7, target: e2 as number });
    world.add(e2, CLabelled, { label: "beta", n: -3, target: 0 });

    const buf1 = ser.snapshot(world);
    const buf2 = new Serializer()
      .register(CLabelled, jsonCodec<Labelled>(["target"]))
      .snapshot(world);
    expect(bytesOf(buf2)).toEqual(bytesOf(buf1));

    const dest = new World();
    ser.restore(dest, buf1);
    const ids = dest
      .query(CLabelled)
      .map(([e]) => e as number)
      .sort((a, b) => a - b);
    const [n1, n2] = ids;
    expect(dest.get(n1 as Entity, CLabelled)).toEqual({
      label: "alpha",
      n: 7,
      target: n2,
    });
    expect(dest.get(n2 as Entity, CLabelled)).toEqual({
      label: "beta",
      n: -3,
      target: 0,
    });
  });
});

describe("bad magic / format throws", () => {
  it("applyDelta on a snapshot buffer throws; restore on a delta buffer throws", () => {
    const ser = buildSerializer();
    const world = new World();
    world.add(world.spawn(), CPosition, { x: 1, y: 1 });

    const snap = ser.snapshot(world);
    const delta = ser.delta(world);

    expect(() => ser.applyDelta(new World(), snap)).toThrow(/format/);
    expect(() => ser.restore(new World(), delta)).toThrow(/format/);

    const corrupt = snap.slice(0);
    new DataView(corrupt).setUint32(0, 0xdeadbeef, true);
    expect(() => ser.restore(new World(), corrupt)).toThrow(/magic|format/);
  });
});

describe("resources are snapshotted and restored when registered", () => {
  const Score = defineResource<{ score: number }>("SerScore");
  const scoreCodec: ResourceCodec<{ score: number }> = {
    write(view, offset, v) {
      view.setInt32(offset, v.score, true);
      return offset + 4;
    },
    read(view, offset) {
      return {
        value: { score: view.getInt32(offset, true) },
        offset: offset + 4,
      };
    },
  };

  it("registered resource round-trips; an unregistered resource is absent", () => {
    const ser = buildSerializer().registerResource(Score, scoreCodec);
    const world = new World();
    world.setResource(Score, { score: 42 });
    const Other = defineResource<number>("SerOther");
    world.setResource(Other, 99);

    const buf = ser.snapshot(world);
    const dest = new World();
    ser.restore(dest, buf);

    expect(dest.tryGetResource(Score)).toEqual({ score: 42 });
    expect(dest.tryGetResource(Other)).toBeUndefined();
  });

  it("a resource unset between baselines is dropped on the replica via delta", () => {
    const live = buildSerializer().registerResource(Score, scoreCodec);
    const clone = buildSerializer().registerResource(Score, scoreCodec);

    const a = new World();
    a.setResource(Score, { score: 7 });
    const baseline = live.snapshot(a);

    const b = new World();
    clone.restore(b, baseline);
    expect(b.tryGetResource(Score)).toEqual({ score: 7 });

    a.unsetResource(Score);
    clone.applyDelta(b, live.delta(a));

    expect(b.tryGetResource(Score)).toBeUndefined();
  });
});

describe("applyDelta integrity (tail check)", () => {
  it("throws when the buffer has a trailing-byte mismatch", () => {
    const live = buildSerializer();
    const clone = buildSerializer();

    const a = new World();
    const e = a.spawn();
    a.add(e, CPosition, { x: 1, y: 1 });
    const baseline = live.snapshot(a);

    const b = new World();
    clone.restore(b, baseline);

    a.add(e, CPosition, { x: 2, y: 2 });
    const d = live.delta(a);
    const tampered = new Uint8Array(d.byteLength + 1);
    tampered.set(new Uint8Array(d));

    expect(() => clone.applyDelta(b, tampered.buffer)).toThrow(
      /applyDelta consumed/,
    );
  });
});

describe("large component beyond the default slab grows the writer", () => {
  interface Blob {
    data: number[];
  }
  const CBlob = defineComponent<Blob>("SerBlob");
  const blobCodec: ComponentCodec<Blob> = {
    write(view, offset, c) {
      view.setUint32(offset, c.data.length, true);
      let o = offset + 4;
      for (let i = 0; i < c.data.length; i++) {
        view.setFloat64(o, c.data[i], true);
        o += 8;
      }
      return o;
    },
    read(view, offset) {
      const len = view.getUint32(offset, true);
      let o = offset + 4;
      const data: number[] = [];
      for (let i = 0; i < len; i++) {
        data.push(view.getFloat64(o, true));
        o += 8;
      }
      return { value: { data }, offset: o };
    },
  };

  it("a 5000-element Float64 component round-trips with a raised ceiling", () => {
    const ser = new Serializer({ maxComponentBytes: 65536 }).register(
      CBlob,
      blobCodec,
    );
    const world = new World();
    const e = world.spawn();
    const data = Array.from({ length: 5000 }, (_, i) => i * 1.5);
    world.add(e, CBlob, { data });

    const buf = ser.snapshot(world);
    const dest = new World();
    ser.restore(dest, buf);

    const restored = dest.getFirst(CBlob);
    expect(restored.data).toEqual(data);
  });
});

function expectWorldsEqual(b: World, a: World): void {
  expect(b.entityCount).toBe(a.entityCount);
  for (const def of [CPosition, CHealth]) {
    const av = a
      .query(def)
      .map(([, v]) => v)
      .sort(byJson);
    const bv = b
      .query(def)
      .map(([, v]) => v)
      .sort(byJson);
    expect(bv).toEqual(av);
  }
}

function byJson(x: unknown, y: unknown): number {
  const sx = JSON.stringify(x);
  const sy = JSON.stringify(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}
