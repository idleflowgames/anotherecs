import {
  type CommandBuffer,
  defineEvent,
  defineLocal,
  defineResource,
  type Entity,
  type SpatialHash,
} from "@idleflowgames/anotherecs";
import type { BotGoal } from "./components";
import type { Rng } from "./random";

export interface ArenaData {
  width: number;
  height: number;
  cellSize: number;
}

export interface InputState {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  requestSnapshot: boolean;
}

export interface GameState {
  frame: number;
  time: number;
  score: number;
  wave: number;
  playerHits: number;
  nextSpawnIn: number;
  nextPulseIn: number;
  snapshotBytes: number;
  restoreOk: boolean;
  restoreHash: number;
  lastEvent: string;
}

export interface ScenarioData {
  name: string;
  seed: number;
  debug: boolean;
  hud: boolean;
  captureFrame: number | null;
}

export interface MetricsData {
  spawned: number;
  despawned: number;
  hits: number;
  pickups: number;
  pulseSpawned: number;
  botGoal: BotGoal;
  botTargetDistance: number;
  botPickupDistance: number;
  botThreatDistance: number;
  botFire: boolean;
  spatialCandidates: number;
  commandBufferPeak: number;
  renderViews: number;
  activeEnemies: number;
  activeProjectiles: number;
  activePickups: number;
  incrementalActors: number;
}

export interface DamageEventData {
  target: Entity;
  amount: number;
  x: number;
  y: number;
}

export interface PickupEventData {
  entity: Entity;
  value: number;
  x: number;
  y: number;
}

export interface BurstEventData {
  x: number;
  y: number;
  tint: number;
  count: number;
}

export interface BotGoalEventData {
  goal: BotGoal;
  reason: string;
}

export const Arena = defineResource<ArenaData>("Demo.Arena");
export const Commands = defineResource<CommandBuffer>("Demo.Commands");
export const Game = defineResource<GameState>("Demo.Game");
export const Input = defineResource<InputState>("Demo.Input");
export const Metrics = defineResource<MetricsData>("Demo.Metrics");
export const Random = defineResource<Rng>("Demo.Random");
export const Scenario = defineResource<ScenarioData>("Demo.Scenario");
export const Space = defineResource<SpatialHash>("Demo.Space");

export const DamageEvent = defineEvent<DamageEventData>("Demo.DamageEvent");
export const PickupEvent = defineEvent<PickupEventData>("Demo.PickupEvent");
export const BurstEvent = defineEvent<BurstEventData>("Demo.BurstEvent");
export const BotGoalEvent = defineEvent<BotGoalEventData>("Demo.BotGoalEvent");
export const WaveEvent = defineEvent<{ wave: number }>("Demo.WaveEvent");

export const CollisionScratch = defineLocal<Entity[]>(
  "Demo.CollisionScratch",
  () => [],
);

export const KilledThisFrame = defineLocal<Set<Entity>>(
  "Demo.KilledThisFrame",
  () => new Set<Entity>(),
);
