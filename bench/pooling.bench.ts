import { bench, describe } from "vitest";
import { defineComponent, type Entity, World } from "../src/index";

// Spawn/add/despawn churn: a high-component-turnover pattern
// every frame (projectiles, enemies, XP orbs). Pooling reuses reset objects
// instead of allocating fresh ones; throughput here is a GC-pressure proxy.

const CEnemy = defineComponent(
  "BpEnemy",
  () => ({ hp: 0, x: 0, y: 0, vx: 0, vy: 0 }),
  (c) => {
    c.hp = 0;
    c.x = 0;
    c.y = 0;
    c.vx = 0;
    c.vy = 0;
  },
);
const FRAMES = 50;
const PER_FRAME = 100;

function churn(pooling: boolean): void {
  const w = new World();
  if (pooling) w.enablePooling(CEnemy);
  const ids: Entity[] = [];
  for (let f = 0; f < FRAMES; f++) {
    ids.length = 0;
    for (let i = 0; i < PER_FRAME; i++) {
      const e = w.spawn();
      w.addComponent(e, CEnemy, { hp: i, x: i, y: i });
      ids.push(e);
    }
    for (const e of ids) w.despawn(e);
    w.flush();
  }
}

describe("spawn/add/despawn churn (component-object GC pressure)", () => {
  bench("pooling OFF (fresh object per addComponent)", () => churn(false));
  bench("pooling ON (reused, reset objects)", () => churn(true));
});
