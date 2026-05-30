import { bench, describe } from "vitest";
import {
  defineLocal,
  defineResource,
  type LocalType,
  World,
} from "../src/index";

const N = 5000;
const M = 200;

describe("local state: init + hot access", () => {
  bench("world.local() warm read + mutate", () => {
    const L = defineLocal<{ n: number }>("benchHot", () => ({ n: 0 }));
    const world = new World();
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const s = world.local(L);
      s.n++;
      sum += s.n;
    }
    if (sum < 0) throw new Error("unreachable");
  });

  bench("world.getResource() warm read + mutate", () => {
    const R = defineResource<{ n: number }>("benchHotRes");
    const world = new World();
    world.setResource(R, { n: 0 });
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const s = world.getResource(R);
      s.n++;
      sum += s.n;
    }
    if (sum < 0) throw new Error("unreachable");
  });
});

const tokens: LocalType<{ n: number }>[] = [];
for (let i = 0; i < M; i++) {
  tokens.push(defineLocal<{ n: number }>(`benchCold${i}`, () => ({ n: i })));
}

describe("local state: cold init across many distinct tokens", () => {
  bench("fresh World + first local() for M tokens", () => {
    const world = new World();
    let sum = 0;
    for (let i = 0; i < M; i++) {
      sum += world.local(tokens[i]).n;
    }
    if (sum < 0) throw new Error("unreachable");
  });
});
