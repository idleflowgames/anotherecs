import type {
  CompiledQuery,
  IncrementalQuery,
  World,
} from "@idleflowgames/anotherecs";
import { maybe, without } from "@idleflowgames/anotherecs";
import {
  Ai,
  type AiData,
  BotBrain,
  type BotBrainData,
  BotIntent,
  type BotIntentData,
  BotPerception,
  type BotPerceptionData,
  Damage,
  type DamageData,
  Dead,
  Enemy,
  Health,
  type HealthData,
  Lifetime,
  type LifetimeData,
  Owner,
  type OwnerData,
  Pickup,
  type PickupData,
  PickupValue,
  Player,
  Position,
  type PositionData,
  Projectile,
  Radius,
  type RadiusData,
  Renderable,
  type RenderableData,
  Rotation,
  type RotationData,
  Velocity,
  type VelocityData,
  Weapon,
  type WeaponData,
} from "./components";

export interface DemoQueries {
  activeEnemies: CompiledQuery<[PositionData, VelocityData, true]>;
  activeProjectiles: CompiledQuery<
    [PositionData, RadiusData, DamageData, OwnerData, true]
  >;
  activePickups: CompiledQuery<[PositionData, RadiusData, PickupData, true]>;
  ai: CompiledQuery<[PositionData, VelocityData, AiData, true]>;
  bot: CompiledQuery<[BotBrainData, BotPerceptionData, BotIntentData]>;
  lifetimes: CompiledQuery<[LifetimeData, RenderableData]>;
  moving: CompiledQuery<[PositionData, VelocityData]>;
  player: CompiledQuery<
    [PositionData, VelocityData, WeaponData, HealthData, true]
  >;
  renderables: CompiledQuery<
    [
      PositionData,
      RenderableData,
      RotationData | undefined,
      HealthData | undefined,
      LifetimeData | undefined,
    ]
  >;
  spatialBodies: CompiledQuery<[PositionData, RadiusData]>;
  weapons: CompiledQuery<[WeaponData, PositionData, true]>;
  incrementalActors: IncrementalQuery;
}

export function createQueries(world: World): DemoQueries {
  return {
    activeEnemies: typed<[PositionData, VelocityData, true]>(
      world.select(Position, Velocity, Enemy, without(Dead)),
    ),
    activeProjectiles: typed<
      [PositionData, RadiusData, DamageData, OwnerData, true]
    >(world.select(Position, Radius, Damage, Owner, Projectile, without(Dead))),
    activePickups: typed<[PositionData, RadiusData, PickupData, true]>(
      world.select(Position, Radius, PickupValue, Pickup, without(Dead)),
    ),
    ai: world.compileQuery(Position, Velocity, Ai, Enemy),
    bot: world.compileQuery(BotBrain, BotPerception, BotIntent),
    lifetimes: world.compileQuery(Lifetime, Renderable),
    moving: world.compileQuery(Position, Velocity),
    player: typed<[PositionData, VelocityData, WeaponData, HealthData, true]>(
      world.compileQuery(Position, Velocity, Weapon, Health, Player),
    ),
    renderables: typed<
      [
        PositionData,
        RenderableData,
        RotationData | undefined,
        HealthData | undefined,
        LifetimeData | undefined,
      ]
    >(
      world.select(
        Position,
        Renderable,
        maybe(Rotation),
        maybe(Health),
        maybe(Lifetime),
        without(Dead),
      ),
    ),
    spatialBodies: world.compileQuery(Position, Radius),
    weapons: world.compileQuery(Weapon, Position, Player),
    incrementalActors: world.compileIncremental(
      Position,
      Renderable,
      without(Dead),
    ),
  };
}

function typed<T extends unknown[]>(
  query: CompiledQuery<unknown[]>,
): CompiledQuery<T> {
  return query as CompiledQuery<T>;
}
