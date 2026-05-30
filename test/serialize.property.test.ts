import { describe, expect, it } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  type Entity,
  Serializer,
  World,
} from "../src/index";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pos {
  x: number;
  y: number;
}
const CPos = defineComponent<Pos>("PropPos");
const posCodec: ComponentCodec<Pos> = {
  write(view, offset, c) {
    view.setInt32(offset, c.x, true);
    view.setInt32(offset + 4, c.y, true);
    return offset + 8;
  },
  read(view, offset) {
    return {
      value: {
        x: view.getInt32(offset, true),
        y: view.getInt32(offset + 4, true),
      },
      offset: offset + 8,
    };
  },
};

interface Vel {
  vx: number;
}
const CVel = defineComponent<Vel>("PropVel");
const velCodec: ComponentCodec<Vel> = {
  write(view, offset, c) {
    view.setFloat64(offset, c.vx, true);
    return offset + 8;
  },
  read(view, offset) {
    return { value: { vx: view.getFloat64(offset, true) }, offset: offset + 8 };
  },
};

function newSerializer(): Serializer {
  return new Serializer().register(CPos, posCodec).register(CVel, velCodec);
}

function logicalState(world: World): Record<number, { pos?: Pos; vel?: Vel }> {
  const out: Record<number, { pos?: Pos; vel?: Vel }> = {};
  const slot = (id: number) => {
    let s = out[id];
    if (s === undefined) {
      s = {};
      out[id] = s;
    }
    return s;
  };
  for (const [e, p] of world.query(CPos)) slot(e as number).pos = p;
  for (const [e, v] of world.query(CVel)) slot(e as number).vel = v;
  return out;
}

describe("property: snapshot/restore preserves logical state (seeded fuzz)", () => {
  it("100 random worlds round-trip value-identically", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed);
      const world = new World();
      const live: Entity[] = [];
      const n = 1 + Math.floor(rng() * 30);
      for (let i = 0; i < n; i++) {
        const e = world.spawn();
        live.push(e);
        if (rng() < 0.8) {
          world.add(e, CPos, {
            x: Math.floor(rng() * 2000) - 1000,
            y: Math.floor(rng() * 2000) - 1000,
          });
        }
        if (rng() < 0.5) world.add(e, CVel, { vx: rng() * 100 - 50 });
      }
      for (let i = 0; i < live.length; i++) {
        if (rng() < 0.25) world.remove(live[i], CPos);
        if (rng() < 0.15) world.despawn(live[i]);
      }
      world.flush();

      const ser = newSerializer();
      const buf = ser.snapshot(world);
      const dest = new World();
      ser.restore(dest, buf);

      const srcPos = world
        .query(CPos)
        .map(([, p]) => p)
        .sort(byJson);
      const dstPos = dest
        .query(CPos)
        .map(([, p]) => p)
        .sort(byJson);
      expect(dstPos).toEqual(srcPos);
      const srcVel = world
        .query(CVel)
        .map(([, v]) => v)
        .sort(byJson);
      const dstVel = dest
        .query(CVel)
        .map(([, v]) => v)
        .sort(byJson);
      expect(dstVel).toEqual(srcVel);
      const srcWithComp = new Set<number>();
      for (const [e] of world.query(CPos)) srcWithComp.add(e as number);
      for (const [e] of world.query(CVel)) srcWithComp.add(e as number);
      expect(dest.entityCount).toBe(srcWithComp.size);
    }
  });
});

describe("property: snapshot bytes are canonical across op order (seeded fuzz)", () => {
  it("same logical content via different op histories yields identical bytes", () => {
    for (let seed = 101; seed <= 160; seed++) {
      const rng = mulberry32(seed);
      const k = 3 + Math.floor(rng() * 20);
      const keep = new Set<number>();
      for (let i = 1; i <= k; i++) if (rng() < 0.7) keep.add(i);

      const a = new World();
      for (let i = 1; i <= k; i++) {
        a.add(a.spawn(), CPos, { x: i, y: i * 3 });
      }
      for (let i = 1; i <= k; i++) {
        if (!keep.has(i)) a.remove(i as Entity, CPos);
      }

      const b = new World();
      for (let i = 1; i <= k; i++) {
        b.add(b.spawn(), CPos, { x: i, y: i * 3 });
      }
      for (let i = 1; i <= k; i++) {
        if (!keep.has(i)) b.despawn(i as Entity);
      }
      b.flush();

      expect(logicalState(b)).toEqual(logicalState(a));

      const snapA = newSerializer().snapshot(a);
      const snapB = newSerializer().snapshot(b);
      expect([...new Uint8Array(snapB)]).toEqual([...new Uint8Array(snapA)]);
    }
  });
});

function byJson(x: unknown, y: unknown): number {
  const sx = JSON.stringify(x);
  const sy = JSON.stringify(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}
