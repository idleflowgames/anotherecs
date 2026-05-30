import {
  type CommandBuffer,
  type Entity,
  type EntityRef,
  NULL_REF,
} from "@idleflowgames/anotherecs";
import {
  Ai,
  BotBrain,
  BotIntent,
  BotPerception,
  Damage,
  Enemy,
  Health,
  Lifetime,
  Owner,
  Pickup,
  PickupValue,
  Player,
  Position,
  Projectile,
  Radius,
  Renderable,
  Rotation,
  Spark,
  Velocity,
  Weapon,
} from "./components";
import type { Rng } from "./random";
import type { ArenaData, MetricsData } from "./resources";

export function spawnPlayer(
  worldSpawn: () => Entity,
  commands: CommandBuffer,
  arena: ArenaData,
): Entity {
  const entity = worldSpawn();
  commands
    .addComponent(entity, Position, {
      x: arena.width * 0.5,
      y: arena.height * 0.56,
    })
    .addComponent(entity, Velocity)
    .addComponent(entity, Rotation)
    .addComponent(entity, Radius, { value: 17 })
    .addComponent(entity, Health, { hp: 8, max: 8 })
    .addComponent(entity, Weapon, { cadence: 0.075, spread: 0.18 })
    .addComponent(entity, BotBrain)
    .addComponent(entity, BotPerception)
    .addComponent(entity, BotIntent)
    .addComponent(entity, Renderable, {
      kind: "player",
      radius: 22,
      tint: 0x8be9ff,
      alpha: 1,
      pulse: 0,
    })
    .add(entity, Player, true);
  return entity;
}

export function spawnEnemy(
  worldSpawn: () => Entity,
  commands: CommandBuffer,
  rng: Rng,
  arena: ArenaData,
  wave: number,
  metrics: MetricsData,
): Entity {
  const entity = worldSpawn();
  const side = rng.int(0, 4);
  const margin = 56;
  const x =
    side === 0
      ? -margin
      : side === 1
        ? arena.width + margin
        : rng.range(0, arena.width);
  const y =
    side === 2
      ? -margin
      : side === 3
        ? arena.height + margin
        : rng.range(0, arena.height);
  const radius = rng.range(11, 18 + Math.min(wave, 8));
  const hp = 2 + Math.floor(wave * 0.45 + radius / 12);
  const tint = rng.next() < 0.55 ? 0xff5d73 : 0xffb347;

  commands
    .addComponent(entity, Position, { x, y })
    .addComponent(entity, Velocity)
    .addComponent(entity, Rotation, {
      angle: rng.range(0, Math.PI * 2),
      spin: rng.range(-1.6, 1.6),
    })
    .addComponent(entity, Radius, { value: radius })
    .addComponent(entity, Health, { hp, max: hp })
    .addComponent(entity, Ai, {
      speed: rng.range(54, 88 + wave * 4),
      orbit: rng.sign() * rng.range(0.18, 0.46),
      phase: rng.range(0, Math.PI * 2),
    })
    .addComponent(entity, Renderable, {
      kind: "enemy",
      radius,
      tint,
      alpha: 1,
      pulse: rng.range(0, Math.PI * 2),
    })
    .add(entity, Enemy, true);
  metrics.spawned++;
  return entity;
}

export function spawnProjectile(
  entity: Entity,
  commands: CommandBuffer,
  x: number,
  y: number,
  vx: number,
  vy: number,
  owner: EntityRef,
  metrics: MetricsData,
): Entity {
  commands
    .addComponent(entity, Position, { x, y })
    .addComponent(entity, Velocity, { x: vx, y: vy })
    .addComponent(entity, Rotation, {
      angle: Math.atan2(vy, vx),
      spin: 0,
    })
    .addComponent(entity, Radius, { value: 4 })
    .addComponent(entity, Damage, { value: 1 })
    .addComponent(entity, Lifetime, { remaining: 1.7, initial: 1.7 })
    .addComponent(entity, Owner, { ref: owner })
    .addComponent(entity, Renderable, {
      kind: "projectile",
      radius: 5,
      tint: 0xf7f36b,
      alpha: 1,
      pulse: 0,
    })
    .add(entity, Projectile, true);
  metrics.spawned++;
  return entity;
}

export function spawnPickup(
  worldSpawn: () => Entity,
  commands: CommandBuffer,
  x: number,
  y: number,
  value: number,
  metrics: MetricsData,
): Entity {
  const entity = worldSpawn();
  commands
    .addComponent(entity, Position, { x, y })
    .addComponent(entity, Velocity, {
      x: Math.sin(x * 0.013) * 12,
      y: Math.cos(y * 0.011) * 12,
    })
    .addComponent(entity, Rotation, { angle: 0, spin: 2.2 })
    .addComponent(entity, Radius, { value: 10 })
    .addComponent(entity, PickupValue, { value })
    .addComponent(entity, Lifetime, { remaining: 12, initial: 12 })
    .addComponent(entity, Renderable, {
      kind: "pickup",
      radius: 10,
      tint: 0x7dffb2,
      alpha: 1,
      pulse: 0,
    })
    .add(entity, Pickup, true);
  metrics.spawned++;
  return entity;
}

export function spawnSpark(
  worldSpawn: () => Entity,
  commands: CommandBuffer,
  x: number,
  y: number,
  vx: number,
  vy: number,
  tint: number,
  ttl: number,
  radius: number,
  metrics: MetricsData,
): Entity {
  const entity = worldSpawn();
  commands
    .addComponent(entity, Position, { x, y })
    .addComponent(entity, Velocity, { x: vx, y: vy })
    .addComponent(entity, Rotation, {
      angle: Math.atan2(vy, vx),
      spin: 0,
    })
    .addComponent(entity, Radius, { value: radius })
    .addComponent(entity, Lifetime, { remaining: ttl, initial: ttl })
    .addComponent(entity, Renderable, {
      kind: radius > 3.5 ? "spark" : "trail",
      radius,
      tint,
      alpha: 1,
      pulse: 0,
    })
    .add(entity, Spark, true);
  metrics.spawned++;
  return entity;
}

export function spawnBurst(
  worldSpawn: () => Entity,
  commands: CommandBuffer,
  rng: Rng,
  x: number,
  y: number,
  tint: number,
  count: number,
  metrics: MetricsData,
): void {
  for (let i = 0; i < count; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const speed = rng.range(42, 220);
    spawnSpark(
      worldSpawn,
      commands,
      x,
      y,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
      tint,
      rng.range(0.24, 0.72),
      rng.range(2, 5.5),
      metrics,
    );
  }
}

export function noOwner(): EntityRef {
  return NULL_REF;
}
