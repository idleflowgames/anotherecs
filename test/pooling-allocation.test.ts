import { describe, expect, it } from "vitest";
import {
  defineComponent,
  type Entity,
  type PooledComponentType,
  World,
} from "../src/index";

const FRAMES = 20;
const PER_FRAME = 50;

function churnCountingAllocations(
  world: World,
  C: PooledComponentType<{ hp: number }>,
): void {
  for (let f = 0; f < FRAMES; f++) {
    const ids: Entity[] = [];
    for (let i = 0; i < PER_FRAME; i++) {
      const e = world.spawn();
      world.addComponent(e, C, { hp: i });
      ids.push(e);
    }
    for (const e of ids) world.despawn(e);
    world.flush();
  }
}

describe("component pooling reduces allocations", () => {
  it("with pooling: allocates ~one frame's worth, then reuses", () => {
    let created = 0;
    const CEnemy = defineComponent(
      "AllocEnemyPooled",
      () => {
        created++;
        return { hp: 0 };
      },
      (c) => {
        c.hp = 0;
      },
    );
    const w = new World();
    w.enablePooling(CEnemy);
    churnCountingAllocations(w, CEnemy);
    expect(created).toBe(PER_FRAME);
  });

  it("without pooling: every addComponent allocates", () => {
    let created = 0;
    const CEnemy = defineComponent(
      "AllocEnemyPlain",
      () => {
        created++;
        return { hp: 0 };
      },
      (c) => {
        c.hp = 0;
      },
    );
    const w = new World();
    churnCountingAllocations(w, CEnemy);
    expect(created).toBe(FRAMES * PER_FRAME);
  });
});
