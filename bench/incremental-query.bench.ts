import { bench, describe } from "vitest";
import { defineComponent, World } from "../src/index";

// The ddmills "Velocity" pattern: every frame spawns an entity (add Position +
// Velocity), then runs a movement system that iterates ALL matching entities.
// The match set grows each frame, so iteration is unavoidably O(n) per frame,
// but the version-cached compileQuery ALSO rebuilds the match set O(n) every
// frame (the world changed), whereas the incremental query maintains it in O(1)
// per add. This isolates the rebuild cost the incremental path removes.

const N = 2000;
const Pos = defineComponent<{ x: number }>("IqbPos");
const Vel = defineComponent<{ x: number }>("IqbVel");

describe("mutate-then-query every frame (Velocity pattern)", () => {
  bench("compileQuery().each: rebuilds the match set every frame", () => {
    const w = new World();
    const q = w.compileQuery(Pos, Vel);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const e = w.spawn();
      w.add(e, Pos, { x: 0 });
      w.add(e, Vel, { x: 1 });
      q.each((_e, p, v) => {
        p.x += v.x;
        acc++;
      });
    }
    if (acc < 0) throw new Error("unreachable");
  });

  bench("compileIncremental().each: maintained, no rebuild", () => {
    const w = new World();
    const q = w.compileIncremental(Pos, Vel);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const e = w.spawn();
      w.add(e, Pos, { x: 0 });
      w.add(e, Vel, { x: 1 });
      q.each((_e, p, v) => {
        (p as { x: number }).x += (v as { x: number }).x;
        acc++;
      });
    }
    if (acc < 0) throw new Error("unreachable");
  });
});
