import { bench, describe } from "vitest";
import {
  CommandBuffer,
  defineComponent,
  type Entity,
  World,
} from "../src/index";

// CommandBuffer (record then flushInto) vs direct immediate world mutation.
// Quantifies the per-command overhead of buffering (push + switch dispatch)
// against the direct path. Matches bench/storage.bench.ts shape.

const N = 5000;

const CData = defineComponent<{ lane: number }>("BenchCBData");
const CPooled = defineComponent<{ hp: number }>(
  "BenchCBPooled",
  () => ({ hp: 0 }),
  (c) => {
    c.hp = 0;
  },
);

describe("command-buffer: N adds, buffered flushInto vs immediate", () => {
  bench("CommandBuffer.record(N) + flushInto", () => {
    const world = new World();
    const buf = new CommandBuffer();
    const ids: Entity[] = [];
    for (let i = 0; i < N; i++) ids.push(world.spawn());
    for (let i = 0; i < N; i++) buf.add(ids[i], CData, { lane: i });
    world.applyCommands(buf);
    if (world.store(CData).size() !== N) throw new Error("unreachable");
  });

  bench("immediate world.add(N)", () => {
    const world = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < N; i++) ids.push(world.spawn());
    for (let i = 0; i < N; i++) world.add(ids[i], CData, { lane: i });
    if (world.store(CData).size() !== N) throw new Error("unreachable");
  });
});

describe("command-buffer: mixed ops, buffered flushInto vs immediate", () => {
  bench(
    "CommandBuffer mixed add+remove+addComponent+despawn + flushInto",
    () => {
      const world = new World();
      const buf = new CommandBuffer();
      const ids: Entity[] = [];
      for (let i = 0; i < N; i++) ids.push(world.spawn());
      for (let i = 0; i < N; i++) {
        buf.add(ids[i], CData, { lane: i });
        buf.addComponent(ids[i], CPooled, { hp: i });
        if (i % 2 === 0) buf.remove(ids[i], CData);
        if (i % 3 === 0) buf.despawn(ids[i]);
      }
      world.applyCommands(buf);
      world.flush();
      if (world.store(CPooled).size() < 0) throw new Error("unreachable");
    },
  );

  bench("immediate mixed add+remove+addComponent+despawn", () => {
    const world = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < N; i++) ids.push(world.spawn());
    for (let i = 0; i < N; i++) {
      world.add(ids[i], CData, { lane: i });
      world.addComponent(ids[i], CPooled, { hp: i });
      if (i % 2 === 0) world.remove(ids[i], CData);
      if (i % 3 === 0) world.despawn(ids[i]);
    }
    world.flush();
    if (world.store(CPooled).size() < 0) throw new Error("unreachable");
  });
});
