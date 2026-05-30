import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, Schedule, type System, World } from "../src/index";

const CPos = defineComponent(
  "SPos",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);

let world: World;

beforeEach(() => {
  world = new World();
});

describe("Group ordering", () => {
  it("runs groups and systems within groups in registration order", () => {
    const order: string[] = [];
    const make =
      (label: string): System =>
      () =>
        order.push(label);
    new Schedule()
      .addGroup("g1", make("a"), make("b"))
      .addGroup("g2", make("c"))
      .run(world);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("getGroupLabels reflects registration", () => {
    const s = new Schedule().addGroup("first").addGroup("second");
    expect(s.getGroupLabels()).toEqual(["first", "second"]);
  });
});

describe("dt threading", () => {
  it("passes dt to systems, defaulting to 1", () => {
    let seen = -1;
    const s = new Schedule().addGroup("g", (_w, dt) => {
      seen = dt;
    });
    s.run(world);
    expect(seen).toBe(1);
    s.run(world, 0.5);
    expect(seen).toBe(0.5);
  });
});

describe("flushBetweenGroups policy", () => {
  it("default true: despawns become visible after each group", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    let aliveInG2 = true;

    new Schedule()
      .addGroup("destroy", (w) => w.despawn(e))
      .addGroup("observe", (w) => {
        aliveInG2 = w.isAlive(e);
      })
      .run(world);

    expect(aliveInG2).toBe(false);
  });

  it("false: despawns are NOT flushed between groups (single-flush model)", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    let aliveInObserve = false;

    new Schedule({ flushBetweenGroups: false })
      .addGroup("destroy", (w) => w.despawn(e))
      .addGroup("observe", (w) => {
        aliveInObserve = w.isAlive(e);
      })
      .addGroup("cleanup", (w) => w.flush())
      .run(world);

    expect(aliveInObserve).toBe(true);
    expect(world.isAlive(e)).toBe(false);
  });
});

describe("runUpTo / runFrom", () => {
  it("runUpTo runs through the named group then stops", () => {
    const order: string[] = [];
    const make =
      (label: string): System =>
      () =>
        order.push(label);
    new Schedule()
      .addGroup("a", make("a"))
      .addGroup("b", make("b"))
      .addGroup("c", make("c"))
      .runUpTo(world, "b");
    expect(order).toEqual(["a", "b"]);
  });

  it("runFrom runs groups after (exclusive) the named group", () => {
    const order: string[] = [];
    const make =
      (label: string): System =>
      () =>
        order.push(label);
    new Schedule()
      .addGroup("a", make("a"))
      .addGroup("b", make("b"))
      .addGroup("c", make("c"))
      .runFrom(world, "a");
    expect(order).toEqual(["b", "c"]);
  });

  it("runUpTo / runFrom thread dt", () => {
    let up = -1;
    let from = -1;
    new Schedule()
      .addGroup("a", (_w, dt) => {
        up = dt;
      })
      .addGroup("b", (_w, dt) => {
        from = dt;
      })
      .runUpTo(world, "a", 0.25);
    new Schedule()
      .addGroup("a", () => {})
      .addGroup("b", (_w, dt) => {
        from = dt;
      })
      .runFrom(world, "a", 0.75);
    expect(up).toBe(0.25);
    expect(from).toBe(0.75);
  });
});

describe("fromPriorityList", () => {
  it("orders systems by ascending priority, stable on ties", () => {
    const order: string[] = [];
    const sys = (label: string, priority: number) => ({
      priority,
      update: (() => order.push(label)) as System,
    });
    const schedule = Schedule.fromPriorityList([
      sys("late", 100),
      sys("early", 10),
      sys("mid-a", 50),
      sys("mid-b", 50),
    ]);
    expect(schedule.getGroupLabels()).toEqual(["main"]);
    schedule.run(world);
    expect(order).toEqual(["early", "mid-a", "mid-b", "late"]);
  });

  it("defaults to flushBetweenGroups=false (single-flush model)", () => {
    const e = world.spawn();
    world.addComponent(e, CPos);
    let aliveAtObserve = false;
    const schedule = Schedule.fromPriorityList([
      { priority: 10, update: (w) => w.despawn(e) },
      {
        priority: 20,
        update: (w) => {
          aliveAtObserve = w.isAlive(e);
        },
      },
      { priority: 120, update: (w) => w.flush() },
    ]);
    schedule.run(world);
    expect(aliveAtObserve).toBe(true);
    expect(world.isAlive(e)).toBe(false);
  });
});
