import { NULL_REF } from "@idleflowgames/anotherecs";
import { describe, expect, it } from "vitest";
import { BotBrain, BotIntent, Health, Position } from "./components";
import { Game, Input, Metrics } from "./resources";
import { createGameRuntime } from "./runtime";

function run(
  seed: number,
  frames: number,
): ReturnType<typeof createGameRuntime> {
  const runtime = createGameRuntime({
    seed,
    scenario: "test",
    debug: false,
    hud: false,
    captureFrame: null,
  });
  runtime.runFrames(frames);
  return runtime;
}

describe("Pixi demo simulation", () => {
  it("is deterministic for a fixed seed and frame count", () => {
    const a = run(11, 240);
    const b = run(11, 240);
    expect(a.summaryHash()).toBe(b.summaryHash());
    expect(a.world.getResource(Game).score).toBe(
      b.world.getResource(Game).score,
    );
  });

  it("changes state for different seeds", () => {
    const a = run(11, 180);
    const b = run(12, 180);
    expect(a.summaryHash()).not.toBe(b.summaryHash());
  });

  it("drains command-buffered structural changes at schedule boundaries", () => {
    const runtime = run(21, 90);
    expect(runtime.commands.isEmpty()).toBe(true);
    expect(runtime.world.entityCount).toBeGreaterThan(20);
  });

  it("spawns cohesive 300-entity seven-component pulses", () => {
    const runtime = run(51, 1);
    let metrics = runtime.world.getResource(Metrics);
    for (let frame = 0; frame < 240 && metrics.pulseSpawned === 0; frame++) {
      runtime.step();
      metrics = runtime.world.getResource(Metrics);
    }
    const game = runtime.world.getResource(Game);
    expect(metrics.pulseSpawned).toBe(300);
    expect(metrics.commandBufferPeak).toBeGreaterThanOrEqual(300 * 7);
    expect(game.lastEvent).toBe("pulse +300");
  });

  it("runs the player bot as ECS components with valid refs", () => {
    const runtime = run(61, 90);
    const bot = runtime.queries.bot.single();
    const [, brain, perception, intent] = bot;
    expect(intent.reason).toBe(brain.goal);
    expect(perception.confidence).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(perception.openScore)).toBe(true);
    if (brain.enemyRef !== NULL_REF) {
      expect(runtime.world.deref(brain.enemyRef)).not.toBeNull();
    }
    if (brain.pickupRef !== NULL_REF) {
      expect(runtime.world.deref(brain.pickupRef)).not.toBeNull();
    }
    if (brain.threatRef !== NULL_REF) {
      expect(runtime.world.deref(brain.threatRef)).not.toBeNull();
    }
  });

  it("switches the bot to evade when a threat is forced close", () => {
    const runtime = run(71, 1);
    const [playerEntity, playerPosition] = runtime.queries.player.single();
    const enemy = runtime.queries.activeEnemies.first();
    expect(enemy).not.toBeNull();
    if (enemy === null) throw new Error("expected an enemy");
    const [enemyEntity, enemyPosition] = enemy;
    enemyPosition.x = playerPosition.x + 32;
    enemyPosition.y = playerPosition.y;
    runtime.world.getOrThrow(playerEntity, Health).hp = 2;
    runtime.world.markChanged(enemyEntity, Position);
    runtime.step();
    const brain = runtime.world.getOrThrow(playerEntity, BotBrain);
    const intent = runtime.world.getOrThrow(playerEntity, BotIntent);
    expect(brain.goal).toBe("evade");
    expect(intent.moveX).toBeLessThan(0);
  });

  it("fights out of corner space while kiting", () => {
    const runtime = run(91, 1);
    const [playerEntity, playerPosition] = runtime.queries.player.single();
    playerPosition.x = 48;
    playerPosition.y = 48;
    runtime.world.markChanged(playerEntity, Position);

    let foundEnemy = false;
    runtime.queries.activeEnemies.each((entity, position) => {
      if (!foundEnemy) {
        position.x = 340;
        position.y = 260;
        foundEnemy = true;
      } else {
        position.x = 1160;
        position.y = 640;
      }
      runtime.world.markChanged(entity, Position);
    });

    expect(foundEnemy).toBe(true);
    runtime.step();

    const brain = runtime.world.getOrThrow(playerEntity, BotBrain);
    const intent = runtime.world.getOrThrow(playerEntity, BotIntent);
    expect(brain.goal).toBe("kite");
    expect(intent.moveX).toBeGreaterThan(0.35);
    expect(intent.moveY).toBeGreaterThan(0.35);
    expect(intent.fire).toBe(true);
  });

  it("keeps play commands owned by the bot", () => {
    const runtime = run(81, 2);
    const input = runtime.world.getResource(Input);
    input.moveX = -9;
    input.moveY = 9;
    input.aimX = 0;
    input.aimY = -1;
    input.fire = false;
    runtime.step();
    const [, , , intent] = runtime.queries.bot.single();
    expect(input.moveX).toBeCloseTo(intent.moveX);
    expect(input.moveY).toBeCloseTo(intent.moveY);
    expect(input.aimX).toBeCloseTo(intent.aimX);
    expect(input.aimY).toBeCloseTo(intent.aimY);
    expect(input.fire).toBe(intent.fire);
  });

  it("exercises spatial collisions and typed events through gameplay", () => {
    const runtime = run(31, 360);
    const metrics = runtime.world.getResource(Metrics);
    expect(
      metrics.hits + runtime.world.getResource(Game).score,
    ).toBeGreaterThan(0);
    expect(metrics.spatialCandidates).toBeGreaterThan(0);
  });

  it("snapshot-restores an equivalent serializable state", () => {
    const runtime = run(41, 30);
    runtime.world.getResource(Input).requestSnapshot = true;
    runtime.step();
    const game = runtime.world.getResource(Game);
    expect(game.snapshotBytes).toBeGreaterThan(0);
    expect(game.restoreOk).toBe(true);
  });
});
