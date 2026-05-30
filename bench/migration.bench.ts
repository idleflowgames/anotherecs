import { bench, describe } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  MigrationRegistry,
  type MigrationStep,
  Serializer,
  World,
} from "../src/index";

// Schema-migration overhead: the identity fast-path (storedVersion === current)
// vs a full 3-step chain, plus empty-registry restore overhead.

const N = 10000;

interface Box {
  a: number;
}
const CMigrate = defineComponent<Box>("BenchMigrate");

function threeStepRegistry(): MigrationRegistry {
  const reg = new MigrationRegistry();
  const s0: MigrationStep = (p) => ({ ...p, b: 1 });
  const s1: MigrationStep = (p) => ({ ...p, c: 2 });
  const s2: MigrationStep = (p) => ({ ...p, d: 3 });
  reg.register(CMigrate, [s0, s1, s2]);
  return reg;
}

describe("migration: migrate identity (storedVersion === current)", () => {
  const reg = threeStepRegistry();
  bench(
    "migrate at current version over N values (fast-path early return)",
    () => {
      for (let i = 0; i < N; i++) {
        reg.migrate(CMigrate.id, 3, { a: i });
      }
    },
  );
});

describe("migration: migrate full chain (v0 -> v3, 3 steps)", () => {
  const reg = threeStepRegistry();
  bench("migrate v0 over N values (apply 3 steps each)", () => {
    for (let i = 0; i < N; i++) {
      reg.migrate(CMigrate.id, 0, { a: i });
    }
  });
});

const SCALE = 5000;
interface Position {
  x: number;
  y: number;
}
const CPosition = defineComponent<Position>("BenchMigratePos");
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
  for (let i = 0; i < SCALE; i++) {
    world.add(world.spawn(), CPosition, { x: i, y: -i });
  }
  return world;
}

describe("migration: serializer restore, no migrations vs empty-registry", () => {
  const world = buildWorld();
  const buf = new Serializer()
    .register(CPosition, positionCodec)
    .snapshot(world);

  bench("restore (no options)", () => {
    new Serializer()
      .register(CPosition, positionCodec)
      .restore(new World(), buf);
  });

  bench("restore (empty MigrationRegistry)", () => {
    new Serializer({ migrations: new MigrationRegistry() })
      .register(CPosition, positionCodec)
      .restore(new World(), buf);
  });
});
