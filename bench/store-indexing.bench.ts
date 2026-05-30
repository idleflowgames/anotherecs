import { bench, describe } from "vitest";
import { ComponentStore, type Entity } from "../src/index";

// Array-indexed component stores compared with a Map lookup baseline. Store
// resolution happens per access to match the World hot path.

interface V {
  v: number;
}

function make(numTypes: number, numEntities: number) {
  const map = new Map<number, ComponentStore<V>>();
  const arr: ComponentStore<V>[] = [];
  for (let id = 0; id < numTypes; id++) {
    const s = new ComponentStore<V>();
    for (let e = 0; e < numEntities; e++) s.set(e as Entity, { v: e });
    map.set(id, s);
    arr[id] = s;
  }
  return { map, arr };
}

function scenario(name: string, numTypes: number, numEntities: number) {
  const { map, arr } = make(numTypes, numEntities);
  describe(name, () => {
    bench("Map<number, Store>: stores.get(id).get(e)", () => {
      let sum = 0;
      for (let id = 0; id < numTypes; id++) {
        for (let e = 0; e < numEntities; e++) {
          const s = map.get(id);
          if (s) {
            const c = s.get(e as Entity);
            if (c) sum += c.v;
          }
        }
      }
      if (sum < 0) throw new Error("unreachable");
    });
    bench("Store[]: stores[id].get(e)", () => {
      let sum = 0;
      for (let id = 0; id < numTypes; id++) {
        for (let e = 0; e < numEntities; e++) {
          const c = arr[id].get(e as Entity);
          if (c) sum += c.v;
        }
      }
      if (sum < 0) throw new Error("unreachable");
    });
  });
}

scenario("small: 12 types x 12 entities", 12, 12);
scenario("large: 50 types x 2000 entities", 50, 2000);
