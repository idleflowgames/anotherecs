import {
  CommandBuffer,
  Schedule,
  SpatialHash,
  World,
} from "@idleflowgames/anotherecs";
import {
  Ai,
  BotBrain,
  BotIntent,
  BotPerception,
  Damage,
  Health,
  Lifetime,
  Owner,
  PickupValue,
  Position,
  Radius,
  Renderable,
  Rotation,
  Velocity,
  Weapon,
} from "./components";
import { createQueries, type DemoQueries } from "./queries";
import { Rng } from "./random";
import {
  Arena,
  type ArenaData,
  Commands,
  Game,
  type GameState,
  Input,
  type InputState,
  Metrics,
  type MetricsData,
  Random,
  Scenario,
  type ScenarioData,
  Space,
} from "./resources";
import { summarizeSerializableWorld } from "./serializer";
import { spawnEnemy, spawnPlayer } from "./spawn";
import { createSystems, type DemoSystems } from "./systems";

export const FIXED_DT = 1 / 60;
export const MAX_ENTITIES = 12000;

export interface RuntimeOptions {
  seed: number;
  scenario: string;
  debug: boolean;
  hud: boolean;
  captureFrame: number | null;
}

export interface GameRuntime {
  readonly commands: CommandBuffer;
  readonly queries: DemoQueries;
  readonly schedule: Schedule;
  readonly systems: DemoSystems;
  readonly world: World;
  runFrames(frames: number): void;
  step(dt?: number): void;
  summaryHash(): number;
}

export function createGameRuntime(options: RuntimeOptions): GameRuntime {
  const world = new World({ maxEntities: MAX_ENTITIES }).enableBitmask();
  world.enableBackrefs();

  world.enablePooling(Position);
  world.enablePooling(Velocity);
  world.enablePooling(Rotation);
  world.enablePooling(Radius);
  world.enablePooling(Health);
  world.enablePooling(Damage);
  world.enablePooling(Lifetime);
  world.enablePooling(Ai);
  world.enablePooling(BotBrain);
  world.enablePooling(BotPerception);
  world.enablePooling(BotIntent);
  world.enablePooling(Weapon);
  world.enablePooling(Renderable);
  world.enablePooling(PickupValue);
  world.enablePooling(Owner);
  world.trackChanges(Renderable);
  world.trackChanges(Health);

  const commands = new CommandBuffer();
  const arena: ArenaData = { width: 1280, height: 720, cellSize: 64 };
  const input: InputState = {
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    fire: false,
    requestSnapshot: false,
  };
  const game: GameState = {
    frame: 0,
    time: 0,
    score: 0,
    wave: options.scenario === "hero" ? 4 : 2,
    playerHits: 0,
    nextSpawnIn: 0,
    nextPulseIn: 2.4,
    snapshotBytes: 0,
    restoreOk: false,
    restoreHash: 0,
    lastEvent: "",
  };
  const metrics: MetricsData = {
    spawned: 0,
    despawned: 0,
    hits: 0,
    pickups: 0,
    pulseSpawned: 0,
    botGoal: "engage",
    botTargetDistance: 99999,
    botPickupDistance: 99999,
    botThreatDistance: 99999,
    botFire: false,
    spatialCandidates: 0,
    commandBufferPeak: 0,
    renderViews: 0,
    activeEnemies: 0,
    activeProjectiles: 0,
    activePickups: 0,
    incrementalActors: 0,
  };
  const scenario: ScenarioData = {
    name: options.scenario,
    seed: options.seed,
    debug: options.debug,
    hud: options.hud,
    captureFrame: options.captureFrame,
  };
  const rng = new Rng(options.seed);

  world.setResource(Arena, arena);
  world.setResource(Commands, commands);
  world.setResource(Game, game);
  world.setResource(Input, input);
  world.setResource(Metrics, metrics);
  world.setResource(Random, rng);
  world.setResource(Scenario, scenario);
  world.setResource(Space, new SpatialHash(arena.cellSize, MAX_ENTITIES));

  spawnPlayer(() => world.spawn(), commands, arena);
  seedScenarioEnemies(
    world,
    commands,
    rng,
    arena,
    game.wave,
    metrics,
    options.scenario,
  );
  world.applyCommands(commands);
  world.flush();
  world.clearChanges();

  const queries = createQueries(world);
  const systems = createSystems(queries);
  const schedule = new Schedule({ commandBuffer: commands })
    .addGroup("frameStart", systems.beginFrame)
    .addGroup("bot", systems.botSense, systems.botThink, systems.botApply)
    .addGroup(
      "input",
      systems.input,
      systems.weapons,
      systems.spawner,
      systems.pulse,
    )
    .addGroup("simulate", systems.enemyAi, systems.movement, systems.lifetime)
    .addGroup("broadphase", systems.spatialIndex)
    .addGroup("resolve", systems.collisions)
    .addGroup("effects", systems.effects)
    .addGroup(
      "hud",
      systems.waveProgress,
      systems.serializeProbe,
      systems.metrics,
    );

  return {
    commands,
    queries,
    schedule,
    systems,
    world,
    runFrames(frames: number): void {
      for (let i = 0; i < frames; i++) schedule.run(world, FIXED_DT);
    },
    step(dt = FIXED_DT): void {
      schedule.run(world, dt);
    },
    summaryHash(): number {
      return summarizeSerializableWorld(world);
    },
  };
}

function seedScenarioEnemies(
  world: World,
  commands: CommandBuffer,
  rng: Rng,
  arena: ArenaData,
  wave: number,
  metrics: MetricsData,
  scenario: string,
): void {
  const count = scenario === "debug" ? 34 : scenario === "restore" ? 28 : 48;
  for (let i = 0; i < count; i++) {
    spawnEnemy(() => world.spawn(), commands, rng, arena, wave, metrics);
  }
}
