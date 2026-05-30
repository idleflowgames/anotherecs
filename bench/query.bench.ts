import { bench, describe } from "vitest";
import {
  type ComponentType,
  defineComponent,
  defineTag,
  type Entity,
  World,
} from "../src/index";
import { ReferenceWorld } from "../test/support/reference-world";

const CA = defineComponent(
  "BqA",
  () => ({ x: 0 }),
  (c) => {
    c.x = 0;
  },
);
const CB = defineComponent(
  "BqB",
  () => ({ y: 0 }),
  (c) => {
    c.y = 0;
  },
);
const Marker = defineComponent(
  "BqMarker",
  () => ({}),
  () => {},
);
const N = 2000;

function build() {
  const w = new World();
  const r = new ReferenceWorld();
  let sample = 1 as Entity;
  for (let i = 0; i < N; i++) {
    const e = w.spawn();
    const re = r.spawn();
    w.addComponent(e, CA, { x: i });
    r.add(re, CA, { x: i });
    if (i % 3 === 0) {
      w.addComponent(e, CB, { y: i });
      r.add(re, CB, { y: i });
    }
    if (i === 0) sample = e;
  }
  return { w, r, sample };
}

function invalidate(w: World, e: Entity) {
  w.addComponent(e, Marker);
  w.removeComponent(e, Marker);
}

describe("query A,B: read-heavy, no structural change", () => {
  const { w, r } = build();
  bench("world.query (cached, allocation-stable)", () => {
    let s = 0;
    for (const [, a, b] of w.query(CA, CB)) s += a.x + b.y;
    if (s < 0) throw new Error("unreachable");
  });
  bench("ReferenceWorld.queryTuples (rebuild tuples each call)", () => {
    let s = 0;
    for (const t of r.queryTuples(CA, CB)) {
      s += (t[1] as { x: number }).x + (t[2] as { y: number }).y;
    }
    if (s < 0) throw new Error("unreachable");
  });
});

describe("iterate A,B: per-frame invalidation (each vs query tuple churn)", () => {
  const { w, sample } = build();
  bench("world.each (no per-call tuples)", () => {
    invalidate(w, sample);
    let s = 0;
    w.each(CA, CB, (_e, a, b) => {
      s += a.x + b.y;
    });
    if (s < 0) throw new Error("unreachable");
  });
  bench("world.query then iterate (rebuilds tuples)", () => {
    invalidate(w, sample);
    let s = 0;
    for (const [, a, b] of w.query(CA, CB)) s += a.x + b.y;
    if (s < 0) throw new Error("unreachable");
  });
});

describe("iterate A,B: compiled handle vs entry point", () => {
  const { w, sample } = build();
  const q = w.compileQuery(CA, CB);
  bench("compileQuery().each (no per-call key/slice)", () => {
    invalidate(w, sample);
    let s = 0;
    q.each((_e, a, b) => {
      s += a.x + b.y;
    });
    if (s < 0) throw new Error("unreachable");
  });
  bench("world.each (per-call key + args.slice)", () => {
    invalidate(w, sample);
    let s = 0;
    w.each(CA, CB, (_e, a, b) => {
      s += a.x + b.y;
    });
    if (s < 0) throw new Error("unreachable");
  });
});

const MN = 5000;

const BmComps = Array.from({ length: 8 }, (_, i) =>
  defineComponent<{ v: number }>(`BmC${i}`),
);
const BmA = BmComps[0];
const BmB = BmComps[3];
const BmC = BmComps[6];

function buildBitmaskWorld() {
  const w = new World().enableBitmask();
  const ents: Entity[] = [];
  for (let i = 0; i < MN; i++) {
    const e = w.spawn();
    for (let c = 0; c < BmComps.length; c++) {
      if ((i + c) % 5 !== 0) w.add(e, BmComps[c], { v: i });
    }
    ents.push(e);
  }
  return { w, ents };
}

describe("bitmask hasMask vs world.has (single-word read)", () => {
  const { w, ents } = buildBitmaskWorld();
  bench("world.hasMask (single-word read)", () => {
    let n = 0;
    for (let i = 0; i < ents.length; i++) if (w.hasMask(ents[i], BmA)) n++;
    if (n < 0) throw new Error("unreachable");
  });
  bench("world.has (sparse lookup)", () => {
    let n = 0;
    for (let i = 0; i < ents.length; i++) if (w.has(ents[i], BmA)) n++;
    if (n < 0) throw new Error("unreachable");
  });
});

describe("bitmask hasAllMask vs three sparse has() lookups", () => {
  const { w, ents } = buildBitmaskWorld();
  const conj = [BmA, BmB, BmC] as ComponentType<unknown>[];
  bench("world.hasAllMask (cached signature AND)", () => {
    let n = 0;
    for (let i = 0; i < ents.length; i++) if (w.hasAllMask(ents[i], conj)) n++;
    if (n < 0) throw new Error("unreachable");
  });
  bench("world.has x3 (three sparse lookups)", () => {
    let n = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (w.has(e, BmA) && w.has(e, BmB) && w.has(e, BmC)) n++;
    }
    if (n < 0) throw new Error("unreachable");
  });
});

const ChurnTag = defineTag("BmChurnTag");
const ChurnMarker = defineComponent(
  "BmChurnMarker",
  () => ({}),
  () => {},
);

describe("tag add/remove churn (zero-alloc) vs empty-object component", () => {
  const { w, ents } = (() => {
    const world = new World();
    const arr: Entity[] = [];
    for (let i = 0; i < MN; i++) arr.push(world.spawn());
    return { w: world, ents: arr };
  })();
  bench("addTag/removeTag cycle (no allocation)", () => {
    for (let i = 0; i < ents.length; i++) {
      w.addTag(ents[i], ChurnTag);
      w.removeTag(ents[i], ChurnTag);
    }
  });
  bench("addComponent/removeComponent empty-object idiom", () => {
    for (let i = 0; i < ents.length; i++) {
      w.addComponent(ents[i], ChurnMarker);
      w.removeComponent(ents[i], ChurnMarker);
    }
  });
});
const PvA = defineComponent<{ v: number }>("PvBenchA");
const PvB = defineComponent<{ v: number }>("PvBenchB");
describe("per-store versioning: unrelated mutation is a cache hit", () => {
  const { w, qA, ents } = (() => {
    const world = new World();
    const arr: Entity[] = [];
    for (let i = 0; i < MN; i++) {
      const e = world.spawn();
      world.add(e, PvA, { v: i });
      world.add(e, PvB, { v: i });
      arr.push(e);
    }
    return { w: world, qA: world.compileQuery(PvA), ents: arr };
  })();
  let k = 0;
  bench("iterate A; churn unrelated B each call (no rebuild)", () => {
    const e = ents[k++ % ents.length];
    w.remove(e, PvB);
    w.add(e, PvB, { v: k });
    let s = 0;
    qA.each((_e, a) => {
      s += a.v;
    });
    if (s < 0) throw new Error("unreachable");
  });
  bench("iterate A; churn A itself each call (rebuilds every call)", () => {
    const e = ents[k++ % ents.length];
    w.remove(e, PvA);
    w.add(e, PvA, { v: k });
    let s = 0;
    qA.each((_e, a) => {
      s += a.v;
    });
    if (s < 0) throw new Error("unreachable");
  });
});
const Bm5 = Array.from({ length: 5 }, (_, i) =>
  defineComponent<{ v: number }>(`Bm5_${i}`),
);
describe("bitmask-accelerated rebuild (5-component join)", () => {
  const makeWorld = (mask: boolean) => {
    const world = new World();
    if (mask) world.enableBitmask();
    const arr: Entity[] = [];
    for (let i = 0; i < MN; i++) {
      const e = world.spawn();
      for (const d of Bm5) world.add(e, d, { v: i });
      arr.push(e);
    }
    return { world, q: world.compileQuery(...Bm5), ents: arr };
  };
  const off = makeWorld(false);
  const on = makeWorld(true);
  let k = 0;
  bench("rebuild via has()-loop (bitmask OFF)", () => {
    const e = off.ents[k++ % off.ents.length];
    off.world.remove(e, Bm5[0]);
    off.world.add(e, Bm5[0], { v: k });
    if (off.q.count() < 0) throw new Error("unreachable");
  });
  bench("rebuild via signature AND (bitmask ON)", () => {
    const e = on.ents[k++ % on.ents.length];
    on.world.remove(e, Bm5[0]);
    on.world.add(e, Bm5[0], { v: k });
    if (on.q.count() < 0) throw new Error("unreachable");
  });
});
