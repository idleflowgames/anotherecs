import { describe, expect, it } from "vitest";
import {
  defineComponent,
  defineEvent,
  defineTag,
  type Entity,
  EventBus,
  Schedule,
  type System,
  World,
} from "../src/index";

const CObstacle = defineComponent<{ lane: number }>("DetObstacle");

function scriptedIterationOrder(withBitmask = false): number[] {
  const world = new World();
  if (withBitmask) world.enableBitmask();
  const ids: Entity[] = [];
  for (let i = 0; i < 8; i++) {
    const e = world.spawn();
    world.add(e, CObstacle, { lane: i });
    ids.push(e);
  }
  world.remove(ids[2], CObstacle);
  world.remove(ids[0], CObstacle);
  world.remove(ids[5], CObstacle);
  return world
    .store(CObstacle)
    .iterEntities()
    .map((e) => e as number);
}

describe("Iteration order is deterministic (swap-delete)", () => {
  it("a fixed operation sequence yields a fixed dense order", () => {
    const a = scriptedIterationOrder();
    const b = scriptedIterationOrder();
    expect(a).toEqual(b);
  });

  it("enabling the bitmask index does not change dense iteration order", () => {
    const plain = scriptedIterationOrder(false);
    const indexed = scriptedIterationOrder(true);
    expect(indexed).toEqual(plain);
  });

  it("swap-delete moves the last element into the removed slot (pinned order)", () => {
    const world = new World();
    const e: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const id = world.spawn();
      world.add(id, CObstacle, { lane: i });
      e.push(id);
    }
    world.remove(e[1], CObstacle);
    const order = world
      .store(CObstacle)
      .iterEntities()
      .map((x) => x as number);
    expect(order).toEqual([e[0], e[3], e[2]] as number[]);
  });
});

describe("Flush timing is exact", () => {
  it("despawn does not change stores until flush()", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, CObstacle, { lane: 0 });
    world.despawn(e);
    expect(world.store(CObstacle).size()).toBe(1);
    expect(world.isAlive(e)).toBe(true);
    world.flush();
    expect(world.store(CObstacle).size()).toBe(0);
    expect(world.isAlive(e)).toBe(false);
  });

  it("Schedule (flushBetweenGroups=true) flushes after every group, never mid-group", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, CObstacle, { lane: 0 });

    const snapshots: { stage: string; size: number }[] = [];
    new Schedule()
      .addGroup(
        "tick",
        (w) => {
          w.despawn(e);
          snapshots.push({
            stage: "after-despawn",
            size: w.store(CObstacle).size(),
          });
        },
        (w) => {
          snapshots.push({
            stage: "same-group",
            size: w.store(CObstacle).size(),
          });
        },
      )
      .addGroup("effects", (w) => {
        snapshots.push({
          stage: "next-group",
          size: w.store(CObstacle).size(),
        });
      })
      .run(world);

    expect(snapshots).toEqual([
      { stage: "after-despawn", size: 1 },
      { stage: "same-group", size: 1 },
      { stage: "next-group", size: 0 },
    ]);
  });
});

describe("System execution order is exact (RNG-order proxy)", () => {
  it("systems run in the precise registered order across groups", () => {
    const world = new World();
    const calls: string[] = [];
    const tag =
      (label: string): System =>
      () =>
        calls.push(label);
    new Schedule()
      .addGroup("frame_setup", tag("input"), tag("difficulty"))
      .addGroup("game_tick", tag("spawner"), tag("collision"))
      .addGroup("effects", tag("render"))
      .run(world);
    expect(calls).toEqual([
      "input",
      "difficulty",
      "spawner",
      "collision",
      "render",
    ]);
  });
});

describe("Event lifecycle is exact (clear at frame start, non-destructive reads)", () => {
  const EBeat = defineEvent<{ i: number }>("DetBeat");

  it("clearAll drops the previous frame, fresh emits are readable, reads do not drain", () => {
    const bus = new EventBus();

    bus.emit(EBeat, { i: 1 });
    expect(bus.read(EBeat)).toHaveLength(1);

    bus.clearAll();
    expect(bus.read(EBeat)).toHaveLength(0);
    bus.emit(EBeat, { i: 2 });

    expect(bus.read(EBeat)).toEqual([{ i: 2 }]);
    expect(bus.read(EBeat)).toEqual([{ i: 2 }]);
  });
});

describe("Entity generations are deterministic (handles pin a fixed sequence)", () => {
  function scriptedHandles(): number[] {
    const world = new World();
    const handles: number[] = [];
    for (let round = 0; round < 6; round++) {
      const e = world.spawn();
      world.add(e, CObstacle, { lane: round });
      handles.push(world.handleOf(e) as unknown as number);
      if (round % 2 === 0) {
        world.despawn(e);
        world.flush();
      }
    }
    return handles;
  }

  it("a fixed spawn/despawn/flush script yields a fixed handle sequence", () => {
    const a = scriptedHandles();
    const b = scriptedHandles();
    expect(a).toEqual(b);
  });
});

describe("Change tracking is deterministic (fixed deltas for a fixed script)", () => {
  const CTrack = defineComponent<{ hp: number }>("DetTrack");

  function scriptedDeltas(): {
    added: number[];
    removed: number[];
    changed: number[];
  } {
    const world = new World();
    world.trackChanges(CTrack);
    const ids: Entity[] = [];
    for (let i = 0; i < 6; i++) {
      const e = world.spawn();
      world.add(e, CTrack, { hp: i });
      ids.push(e);
    }
    world.markChanged(ids[1], CTrack);
    world.markChanged(ids[4], CTrack);
    world.remove(ids[2], CTrack);
    world.despawn(ids[0]);
    world.flush();
    return {
      added: world.added(CTrack).map((e) => e as number),
      removed: world.removed(CTrack).map((e) => e as number),
      changed: world.changed(CTrack).map((e) => e as number),
    };
  }

  it("a fixed track+mutate sequence yields byte-identical deltas", () => {
    const a = scriptedDeltas();
    const b = scriptedDeltas();
    expect(a).toEqual(b);
  });
});

describe("Tags reuse the store path (no new ordering is introduced)", () => {
  const TFlag = defineTag("DetTagFlag");

  function scriptedTagOrder(): number[] {
    const world = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const e = world.spawn();
      world.addTag(e, TFlag);
      ids.push(e);
    }
    world.removeTag(ids[2], TFlag);
    world.removeTag(ids[0], TFlag);
    world.removeTag(ids[5], TFlag);
    return world
      .store(TFlag)
      .iterEntities()
      .map((e) => e as number);
  }

  it("a fixed tag add/remove sequence yields a fixed dense order", () => {
    const a = scriptedTagOrder();
    const b = scriptedTagOrder();
    expect(a).toEqual(b);
  });
});
