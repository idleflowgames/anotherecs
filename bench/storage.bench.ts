import { bench, describe } from "vitest";
import { ComponentStore, type Entity } from "../src/index";

// Sparse-set ComponentStore vs a plain Map<Entity, T>: bulk add, dense iterate,
// strided remove. Quantifies the dense-storage win.

const N = 5000;

describe("storage: bulk add + dense iterate + strided remove", () => {
  bench("ComponentStore (sparse-set, swap-delete)", () => {
    const s = new ComponentStore<{ x: number }>();
    for (let i = 0; i < N; i++) s.set(i as Entity, { x: i });
    let sum = 0;
    const data = s.iterData();
    for (let i = 0; i < data.length; i++) sum += data[i].x;
    for (let i = 0; i < N; i += 2) s.remove(i as Entity);
    if (sum < 0) throw new Error("unreachable");
  });

  bench("Map<Entity, T>", () => {
    const m = new Map<number, { x: number }>();
    for (let i = 0; i < N; i++) m.set(i, { x: i });
    let sum = 0;
    for (const v of m.values()) sum += v.x;
    for (let i = 0; i < N; i += 2) m.delete(i);
    if (sum < 0) throw new Error("unreachable");
  });
});
