import { test } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  type Entity,
  jsonCodec,
  Serializer,
  World,
} from "../src/index";

// Serialization throughput: full-world snapshot, restore, delta (10% churn),
// delta-vs-snapshot at 1% churn, and jsonCodec vs a hand-written binary codec.
// Mirrors storage.bench's N=5000 scale.

const N = 5000;

interface Position {
  x: number;
  y: number;
}
const CPosition = defineComponent<Position>("BenchSerPosition");
const positionCodec: ComponentCodec<Position> = {
  write(view, offset, c) {
    view.setFloat64(offset, c.x, true);
    view.setFloat64(offset + 8, c.y, true);
    return offset + 16;
  },
  read(view, offset) {
    return {
      value: {
        x: view.getFloat64(offset, true),
        y: view.getFloat64(offset + 8, true),
      },
      offset: offset + 16,
    };
  },
};

function buildWorld(): World {
  const world = new World();
  for (let i = 0; i < N; i++) {
    world.add(world.spawn(), CPosition, { x: i, y: -i });
  }
  return world;
}

function binarySerializer(): Serializer {
  return new Serializer().register(CPosition, positionCodec);
}

test("serialize: full-world snapshot", async ({ bench }) => {
  const world = buildWorld();
  const ser = binarySerializer();
  await bench("snapshot 5000 entities (binary Position codec)", () => {
    ser.snapshot(world);
  }).run();
});

test("serialize: full-world restore", async ({ bench }) => {
  const world = buildWorld();
  const ser = binarySerializer();
  const buf = ser.snapshot(world);
  await bench("restore 5000 entities (decode + re-spawn + idMap build)", () => {
    const dest = new World();
    binarySerializer().restore(dest, buf);
  }).run();
});

test("serialize: delta (10% churn)", async ({ bench }) => {
  await bench("delta after 500 changed + 50 spawned + 50 despawned", () => {
    const world = buildWorld();
    const ser = binarySerializer();
    const ids: Entity[] = world.query(CPosition).map(([e]) => e);
    ser.snapshot(world);
    for (let i = 0; i < 500; i++) world.add(ids[i], CPosition, { x: i, y: i });
    for (let i = 0; i < 50; i++) {
      world.add(world.spawn(), CPosition, { x: 0, y: 0 });
    }
    for (let i = 0; i < 50; i++) world.despawn(ids[N - 1 - i]);
    world.flush();
    ser.delta(world);
  }).run();
});

test("serialize: delta vs full snapshot at 1% churn", async ({ bench }) => {
  await bench.compare(
    bench("delta (1% changed)", () => {
      const world = buildWorld();
      const ser = binarySerializer();
      const ids: Entity[] = world.query(CPosition).map(([e]) => e);
      ser.snapshot(world);
      for (let i = 0; i < 50; i++) world.add(ids[i], CPosition, { x: i, y: i });
      ser.delta(world);
    }),
    bench("full snapshot (for comparison)", () => {
      const world = buildWorld();
      const ser = binarySerializer();
      ser.snapshot(world);
      const ids: Entity[] = world.query(CPosition).map(([e]) => e);
      for (let i = 0; i < 50; i++) world.add(ids[i], CPosition, { x: i, y: i });
      ser.snapshot(world);
    }),
  );
});

test("serialize: jsonCodec vs binary codec", async ({ bench }) => {
  const world = buildWorld();
  await bench.compare(
    bench("snapshot 5000 entities (jsonCodec)", () => {
      new Serializer()
        .register(CPosition, jsonCodec<Position>())
        .snapshot(world);
    }),
    bench("snapshot 5000 entities (binary codec)", () => {
      binarySerializer().snapshot(world);
    }),
  );
});
