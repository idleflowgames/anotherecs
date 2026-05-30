import { describe, expect, it } from "vitest";
import {
  CommandBuffer,
  defineComponent,
  type Entity,
  Schedule,
  World,
} from "../src/index";

const CData = defineComponent<{ lane: number }>("CBData");
const CPooled = defineComponent<{ hp: number }>(
  "CBPooled",
  () => ({ hp: 0 }),
  (c) => {
    c.hp = 0;
  },
);

describe("CommandBuffer: flushInto replays in record order", () => {
  it("replays add/remove/addComponent/despawn against the world, in record order", () => {
    const world = new World();
    const eA = world.spawn();
    const eB = world.spawn();
    const eC = world.spawn();
    world.add(eC, CData, { lane: 9 });

    const buf = new CommandBuffer();
    buf
      .add(eA, CData, { lane: 1 })
      .addComponent(eB, CPooled, { hp: 3 })
      .remove(eA, CData)
      .despawn(eC);

    expect(world.has(eA, CData)).toBe(false);
    expect(world.has(eB, CPooled)).toBe(false);
    expect(buf.size()).toBe(4);

    world.applyCommands(buf);

    expect(world.has(eA, CData)).toBe(false);
    expect(world.get(eB, CPooled)).toEqual({ hp: 3 });
    expect(world.isAlive(eC)).toBe(true);
    expect(world.store(CData).size()).toBe(1);
    expect(buf.isEmpty()).toBe(true);
    expect(buf.size()).toBe(0);
  });
});

describe("CommandBuffer: buffered despawn is deferred, not immediate", () => {
  it("surfaces only on the next flush(), matching immediate world.despawn timing", () => {
    const world = new World();
    const eX = world.spawn();
    world.add(eX, CData, { lane: 0 });

    const buf = new CommandBuffer();
    buf.despawn(eX);
    world.applyCommands(buf);

    expect(world.isAlive(eX)).toBe(true);
    expect(world.store(CData).size()).toBe(1);

    world.flush();

    expect(world.isAlive(eX)).toBe(false);
    expect(world.store(CData).size()).toBe(0);
  });
});

describe("CommandBuffer: Schedule applies recorded ops at the group boundary", () => {
  it("applies before the per-group flush (recorded add visible next group; recorded despawn flushed)", () => {
    const world = new World();
    const e = world.spawn();
    const eOld = world.spawn();
    world.add(eOld, CData, { lane: 7 });

    const buf = new CommandBuffer();
    const snapshots: { stage: string; size: number }[] = [];

    new Schedule({ commandBuffer: buf })
      .addGroup("tick", (w) => {
        buf.add(e, CData, { lane: 0 });
        buf.despawn(eOld);
        snapshots.push({ stage: "mid-tick", size: w.store(CData).size() });
      })
      .addGroup("effects", (w) => {
        snapshots.push({ stage: "effects", size: w.store(CData).size() });
      })
      .run(world);

    expect(snapshots[0]).toEqual({ stage: "mid-tick", size: 1 });
    expect(snapshots[1]).toEqual({ stage: "effects", size: 1 });
    expect(world.has(e, CData)).toBe(true);
    expect(world.isAlive(eOld)).toBe(false);
  });
});

describe("CommandBuffer: schedules without commandBuffer skip applyCommands", () => {
  it("buffered-then-applied at the boundary matches immediate mutation, per-group", () => {
    function runImmediate(): number[] {
      const world = new World();
      const sizes: number[] = [];
      new Schedule()
        .addGroup("tick", (w) => {
          const a = w.spawn();
          w.add(a, CData, { lane: 1 });
        })
        .addGroup("more", (w) => {
          const b = w.spawn();
          w.add(b, CData, { lane: 2 });
          sizes.push(w.store(CData).size());
        })
        .addGroup("read", (w) => {
          sizes.push(w.store(CData).size());
        })
        .run(world);
      return sizes;
    }

    function runBuffered(): number[] {
      const world = new World();
      const buf = new CommandBuffer();
      const sizes: number[] = [];
      new Schedule({ commandBuffer: buf })
        .addGroup("tick", (w) => {
          const a = w.spawn();
          buf.add(a, CData, { lane: 1 });
        })
        .addGroup("more", (w) => {
          const b = w.spawn();
          buf.add(b, CData, { lane: 2 });
          sizes.push(w.store(CData).size());
        })
        .addGroup("read", (w) => {
          sizes.push(w.store(CData).size());
        })
        .run(world);
      return sizes;
    }

    expect(runImmediate()).toEqual([2, 2]);
    expect(runBuffered()).toEqual([1, 2]);
  });

  it("a Schedule with no config never takes the applyCommands branch", () => {
    const world = new World();
    let applied = 0;
    const orig = world.applyCommands.bind(world);
    world.applyCommands = (b) => {
      applied++;
      orig(b);
    };
    new Schedule()
      .addGroup("a", (w) => {
        w.spawn();
      })
      .addGroup("b", () => {})
      .run(world);
    expect(applied).toBe(0);
  });
});

describe("CommandBuffer: record order is a pure function of the call sequence", () => {
  function scriptedBufferedOrder(): {
    entities: number[];
    pooled: { hp: number }[];
  } {
    const world = new World();
    const buf = new CommandBuffer();
    const ids: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const e = world.spawn();
      buf.add(e, CData, { lane: i });
      ids.push(e);
    }
    buf.addComponent(ids[1], CPooled, { hp: 11 });
    buf.addComponent(ids[4], CPooled, { hp: 44 });
    buf.remove(ids[2], CData);
    buf.remove(ids[0], CData);
    buf.remove(ids[5], CData);
    world.applyCommands(buf);
    return {
      entities: world
        .store(CData)
        .iterEntities()
        .map((e) => e as number),
      pooled: world
        .store(CPooled)
        .iterData()
        .map((d) => ({ hp: d.hp })),
    };
  }

  it("a fixed buffered script yields byte-identical dense order and data", () => {
    const a = scriptedBufferedOrder();
    const b = scriptedBufferedOrder();
    expect(a).toEqual(b);
  });
});

describe("CommandBuffer: clear() drops queued commands without applying", () => {
  it("leaves the world completely unmutated", () => {
    const world = new World();
    const e = world.spawn();
    const baseline = world.store(CData).size();

    const buf = new CommandBuffer();
    buf
      .add(e, CData, { lane: 1 })
      .addComponent(e, CPooled, { hp: 5 })
      .despawn(e);
    expect(buf.size()).toBe(3);

    buf.clear();
    expect(buf.size()).toBe(0);

    world.applyCommands(buf);
    expect(buf.size()).toBe(0);
    expect(world.store(CData).size()).toBe(baseline);
    expect(world.store(CPooled).size()).toBe(0);
    expect(world.isAlive(e)).toBe(true);
  });
});

describe("CommandBuffer: addComponent merge & pooling happen at apply time", () => {
  it("acquires the parked pooled object at apply time, not record time", () => {
    const world = new World();
    world.enablePooling(CPooled);

    const eOld = world.spawn();
    const parked = world.addComponent(eOld, CPooled, { hp: 99 });
    world.despawn(eOld);
    world.flush();
    expect(world.store(CPooled).pooledCount()).toBe(1);

    const eNew = world.spawn();
    const buf = new CommandBuffer();
    buf.addComponent(eNew, CPooled, { hp: 7 });

    expect(world.store(CPooled).pooledCount()).toBe(1);

    world.applyCommands(buf);

    const reused = world.get(eNew, CPooled);
    expect(reused).toBe(parked);
    expect(reused).toEqual({ hp: 7 });
    expect(world.store(CPooled).pooledCount()).toBe(0);
  });
});

describe("CommandBuffer: reusable across frames", () => {
  it("a second apply reflects only the second record set", () => {
    const world = new World();
    const e1 = world.spawn();
    const e2 = world.spawn();
    const buf = new CommandBuffer();

    buf.add(e1, CData, { lane: 1 });
    world.applyCommands(buf);
    expect(buf.isEmpty()).toBe(true);
    expect(world.store(CData).size()).toBe(1);

    buf.add(e2, CData, { lane: 2 });
    world.applyCommands(buf);
    expect(world.store(CData).size()).toBe(2);
    expect(world.get(e1, CData)).toEqual({ lane: 1 });
    expect(world.get(e2, CData)).toEqual({ lane: 2 });
  });
});
