import { bench, describe } from "vitest";
import { defineComponent, type Entity, World, without } from "../src/index";

// 5+-component each() falls to the cap-lifted variadic overload, whose callback
// args are typed `never` (no per-slot inference beyond 4; the documented
// ceiling). The runtime values are real component objects; cast for the bench.
type N = { n: number };

const CA = defineComponent<{ x: number }>("QfbA");
const CB = defineComponent<{ y: number }>("QfbB");
const CDead = defineComponent<{ at: number }>("QfbDead");
const C1 = defineComponent<{ n: number }>("Qfb1");
const C2 = defineComponent<{ n: number }>("Qfb2");
const C3 = defineComponent<{ n: number }>("Qfb3");
const C4 = defineComponent<{ n: number }>("Qfb4");
const C5 = defineComponent<{ n: number }>("Qfb5");
const C6 = defineComponent<{ n: number }>("Qfb6");

const N = 2000;

function build() {
  const w = new World();
  for (let i = 0; i < N; i++) {
    const e = w.spawn();
    w.add(e, CA, { x: i });
    if (i % 3 === 0) w.add(e, CB, { y: i });
    if (i % 5 === 0) w.add(e, CDead, { at: i });
    w.add(e, C1, { n: i });
    w.add(e, C2, { n: i });
    w.add(e, C3, { n: i });
    w.add(e, C4, { n: i });
    if (i % 2 === 0) {
      w.add(e, C5, { n: i });
      w.add(e, C6, { n: i });
    }
  }
  return w;
}

describe("select(A) vs query(A) parity (shared-cache delegation is free)", () => {
  const w = build();
  bench("world.select(CA).results() (pure-with shared cache)", () => {
    let s = 0;
    for (const [, a] of w.select(CA).results()) s += a.x;
    if (s < 0) throw new Error("unreachable");
  });
  bench("world.query(CA) (baseline)", () => {
    let s = 0;
    for (const [, a] of w.query(CA)) s += a.x;
    if (s < 0) throw new Error("unreachable");
  });
});

describe("select(A, without(Dead)) vs manual query(A)+has(Dead) filter", () => {
  const w = build();
  const filtered = w.select(CA, without(CDead));
  bench(
    "world.select(CA, without(CDead)).each (engine-level exclusion)",
    () => {
      let s = 0;
      filtered.each((_e, a) => {
        s += (a as { x: number }).x;
      });
      if (s < 0) throw new Error("unreachable");
    },
  );
  bench("world.query(CA) + manual has(CDead) skip (hand-rolled)", () => {
    let s = 0;
    for (const [e, a] of w.query(CA)) {
      if (w.has(e, CDead)) continue;
      s += a.x;
    }
    if (s < 0) throw new Error("unreachable");
  });
});

describe("each 6 components (generic scratch lane) vs 4 (fast switch)", () => {
  const w = build();
  bench("world.each(C1..C6) (generic scratch lane, cap lifted)", () => {
    let s = 0;
    world6Each(w, (n) => {
      s += n;
    });
    if (s < 0) throw new Error("unreachable");
  });
  bench("world.each(C1..C4) (fast switch, <=4)", () => {
    let s = 0;
    w.each(C1, C2, C3, C4, (_e, a, b, c, d) => {
      s += a.n + b.n + c.n + d.n;
    });
    if (s < 0) throw new Error("unreachable");
  });
});

function world6Each(w: World, sink: (n: number) => void) {
  w.each(C1, C2, C3, C4, C5, C6, (_e, a, b, c, d, f, g) => {
    const [pa, pb, pc, pd, pf, pg] = [a, b, c, d, f, g] as N[];
    sink(pa.n + pb.n + pc.n + pd.n + pf.n + pg.n);
  });
}

describe("pairs() over N matched entities vs nested world.query loop", () => {
  function buildPairs(n: number) {
    const w = new World();
    const ents: Entity[] = [];
    for (let i = 0; i < n; i++) {
      const e = w.spawn();
      w.add(e, CA, { x: i });
      ents.push(e);
    }
    return { w, ents };
  }
  const { w } = buildPairs(150);
  const q = w.select(CA);
  bench("compiled select(CA).pairs() (cached entity list)", () => {
    let s = 0;
    q.pairs((_a, _b, posA) => {
      s += posA.x;
    });
    if (s < 0) throw new Error("unreachable");
  });
  bench("nested world.query(CA) loop (manual i<j broadphase)", () => {
    let s = 0;
    const list = w.query(CA);
    for (let i = 0; i < list.length; i++) {
      const ai = list[i][1].x;
      for (let j = i + 1; j < list.length; j++) {
        s += ai + list[j][1].x;
      }
    }
    if (s < 0) throw new Error("unreachable");
  });
});
