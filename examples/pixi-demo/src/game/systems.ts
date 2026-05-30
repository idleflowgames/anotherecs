import {
  type Entity,
  type EntityRef,
  NULL_REF,
  type System,
  World,
} from "@idleflowgames/anotherecs";
import {
  type BotGoal,
  Dead,
  Enemy,
  Health,
  Pickup,
  PickupValue,
  Player,
  Position,
  Radius,
  Rotation,
} from "./components";
import type { DemoQueries } from "./queries";
import {
  Arena,
  BotGoalEvent,
  BurstEvent,
  CollisionScratch,
  Commands,
  DamageEvent,
  Game,
  Input,
  KilledThisFrame,
  Metrics,
  PickupEvent,
  Random,
  Space,
  WaveEvent,
} from "./resources";
import { createDemoSerializer, summarizeSerializableWorld } from "./serializer";
import {
  spawnBurst,
  spawnEnemy,
  spawnPickup,
  spawnProjectile,
  spawnSpark,
} from "./spawn";

const PLAYER_SPEED = 250;
const PROJECTILE_SPEED = 560;
const PULSE_INTERVAL = 10;
const PULSE_SIZE = 300;

export interface DemoSystems {
  beginFrame: System;
  botSense: System;
  botThink: System;
  botApply: System;
  input: System;
  weapons: System;
  spawner: System;
  pulse: System;
  enemyAi: System;
  movement: System;
  lifetime: System;
  spatialIndex: System;
  collisions: System;
  effects: System;
  waveProgress: System;
  serializeProbe: System;
  metrics: System;
}

export function createSystems(queries: DemoQueries): DemoSystems {
  return {
    beginFrame: (world, dt) => beginFrameSystem(world, dt),
    botSense: (world) => botSenseSystem(world, queries),
    botThink: (world) => botThinkSystem(world, queries),
    botApply: (world) => botApplySystem(world, queries),
    input: (world) => inputSystem(world, queries),
    weapons: (world, dt) => weaponSystem(world, queries, dt),
    spawner: (world, dt) => spawnerSystem(world, queries, dt),
    pulse: (world, dt) => pulseSystem(world, queries, dt),
    enemyAi: (world, dt) => enemyAiSystem(world, queries, dt),
    movement: (world, dt) => movementSystem(world, queries, dt),
    lifetime: (world, dt) => lifetimeSystem(world, queries, dt),
    spatialIndex: (world) => spatialIndexSystem(world, queries),
    collisions: (world) => collisionSystem(world, queries),
    effects: (world) => effectsSystem(world),
    waveProgress: (world) => waveProgressSystem(world, queries),
    serializeProbe: (world) => serializeProbeSystem(world),
    metrics: (world) => metricsSystem(world, queries),
  };
}

function beginFrameSystem(world: World, dt: number): void {
  world.events.clearAll();
  world.clearChanges();
  const game = world.getResource(Game);
  const metrics = world.getResource(Metrics);
  const killed = world.local(KilledThisFrame);

  game.frame++;
  game.time += dt;
  game.lastEvent = "";
  killed.clear();

  metrics.spawned = 0;
  metrics.despawned = 0;
  metrics.hits = 0;
  metrics.pickups = 0;
  metrics.pulseSpawned = 0;
  metrics.spatialCandidates = 0;
  metrics.commandBufferPeak = 0;
}

function botSenseSystem(world: World, queries: DemoQueries): void {
  const player = queries.player.first();
  const bot = queries.bot.first();
  if (player === null || bot === null) return;

  const [playerEntity, playerPosition] = player;
  const [, brain, perception] = bot;
  const metrics = world.getResource(Metrics);
  const arena = world.getResource(Arena);

  let enemy: Entity | null = null;
  let enemyDistance = 99999;
  let enemyX = playerPosition.x + 1;
  let enemyY = playerPosition.y;
  let threat: Entity | null = null;
  let bestThreatScore = 99999;
  let threatDistance = 99999;
  let threatX = playerPosition.x + 1;
  let threatY = playerPosition.y;
  let pickup: Entity | null = null;
  let pickupDistance = 99999;
  let pickupX = playerPosition.x;
  let pickupY = playerPosition.y;

  queries.activeEnemies.each((entity, position, velocity) => {
    const dx = position.x - playerPosition.x;
    const dy = position.y - playerPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance < enemyDistance) {
      enemy = entity;
      enemyDistance = distance;
      enemyX = position.x + velocity.x * 0.18;
      enemyY = position.y + velocity.y * 0.18;
    }
    const closing =
      distance > 0 ? -(dx * velocity.x + dy * velocity.y) / distance : 0;
    const threatScore = distance - Math.max(0, closing) * 0.55;
    if (threatScore < bestThreatScore) {
      threat = entity;
      bestThreatScore = threatScore;
      threatDistance = distance;
      threatX = position.x;
      threatY = position.y;
    }
  });

  queries.activePickups.each((entity, position) => {
    const dx = position.x - playerPosition.x;
    const dy = position.y - playerPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance < pickupDistance) {
      pickup = entity;
      pickupDistance = distance;
      pickupX = position.x;
      pickupY = position.y;
    }
  });

  const openSpace = openSpaceVector(
    playerPosition.x,
    playerPosition.y,
    arena.width,
    arena.height,
    queries,
  );

  brain.enemyRef = replaceRef(world, playerEntity, brain.enemyRef, enemy);
  brain.threatRef = replaceRef(world, playerEntity, brain.threatRef, threat);
  brain.pickupRef = replaceRef(world, playerEntity, brain.pickupRef, pickup);

  perception.enemyDistance = enemyDistance;
  perception.enemyX = enemyX;
  perception.enemyY = enemyY;
  perception.pickupDistance = pickupDistance;
  perception.pickupX = pickupX;
  perception.pickupY = pickupY;
  perception.threatDistance = threatDistance;
  perception.threatX = threatX;
  perception.threatY = threatY;
  perception.openX = openSpace.x;
  perception.openY = openSpace.y;
  perception.openScore = openSpace.score;
  perception.confidence =
    enemy === null ? 0 : clamp(1 - enemyDistance / 760, 0.15, 1);

  metrics.botTargetDistance = enemyDistance;
  metrics.botPickupDistance = pickupDistance;
  metrics.botThreatDistance = threatDistance;
}

function botThinkSystem(world: World, queries: DemoQueries): void {
  const player = queries.player.first();
  const bot = queries.bot.first();
  if (player === null || bot === null) return;

  const [, playerPosition, , , health] = player;
  const [, brain, perception, intent] = bot;
  const metrics = world.getResource(Metrics);

  const arena = world.getResource(Arena);
  const game = world.getResource(Game);
  const healthRatio = health.hp / Math.max(1, health.max);
  const previousGoal = brain.goal;
  const trapPressure = arenaTrapPressure(
    playerPosition.x,
    playerPosition.y,
    arena.width,
    arena.height,
  );
  const crowdPressure = clamp(-perception.openScore / 2.8, 0, 0.75);
  const spacePressure = clamp(trapPressure + crowdPressure, 0, 1.45);
  const immediateThreat =
    perception.threatDistance < 138 ||
    (healthRatio < 0.5 && perception.threatDistance < 260);
  const hasPickup = world.deref(brain.pickupRef) !== null;
  const hasEnemy = world.deref(brain.enemyRef) !== null;
  const trappedWithEnemy =
    hasEnemy &&
    (trapPressure > 0.32 ||
      (perception.openScore < -0.2 && perception.enemyDistance < 460));
  let goal: BotGoal = "engage";

  if (immediateThreat && trapPressure < 0.52) goal = "evade";
  else if (trappedWithEnemy) goal = "kite";
  else if (immediateThreat) goal = "evade";
  else if (hasPickup && perception.pickupDistance < 230) goal = "collect";
  else if (hasEnemy && perception.enemyDistance < 260) goal = "kite";
  else if (hasEnemy) goal = "engage";

  let moveX = 0;
  let moveY = 0;
  const enemyDx = perception.enemyX - playerPosition.x;
  const enemyDy = perception.enemyY - playerPosition.y;
  const enemyLen = Math.hypot(enemyDx, enemyDy) || 1;
  const pickupDx = perception.pickupX - playerPosition.x;
  const pickupDy = perception.pickupY - playerPosition.y;
  const pickupLen = Math.hypot(pickupDx, pickupDy) || 1;
  const threatDx = perception.threatX - playerPosition.x;
  const threatDy = perception.threatY - playerPosition.y;
  const threatLen = Math.hypot(threatDx, threatDy) || 1;
  const openWeight = brain.spaceBias * (0.45 + spacePressure * 1.35);

  if (goal === "evade") {
    moveX += (-threatDx / threatLen) * 1.25 * brain.caution;
    moveY += (-threatDy / threatLen) * 1.25 * brain.caution;
    moveX += perception.openX * openWeight * 0.7;
    moveY += perception.openY * openWeight * 0.7;
  } else if (goal === "collect") {
    const pickupWeight = spacePressure > 0.45 ? 0.58 : 1.05;
    moveX += (pickupDx / pickupLen) * pickupWeight;
    moveY += (pickupDy / pickupLen) * pickupWeight;
    if (perception.threatDistance < 260) {
      moveX += (-threatDx / threatLen) * 0.45;
      moveY += (-threatDy / threatLen) * 0.45;
    }
    moveX += perception.openX * openWeight * 0.48;
    moveY += perception.openY * openWeight * 0.48;
  } else if (goal === "kite") {
    const strafe = game.frame % 180 < 90 ? 1 : -1;
    const strafeWeight = 0.56 * (1 - clamp(spacePressure, 0, 0.9) * 0.55);
    moveX += (-enemyDx / enemyLen) * 0.58;
    moveY += (-enemyDy / enemyLen) * 0.58;
    moveX += (-enemyDy / enemyLen) * strafeWeight * strafe;
    moveY += (enemyDx / enemyLen) * strafeWeight * strafe;
    moveX += perception.openX * openWeight * 1.18;
    moveY += perception.openY * openWeight * 1.18;
  } else {
    moveX += (enemyDx / enemyLen) * 0.38 * brain.aggression;
    moveY += (enemyDy / enemyLen) * 0.38 * brain.aggression;
    moveX += perception.openX * openWeight * 0.22;
    moveY += perception.openY * openWeight * 0.22;
  }

  const edge = edgeAvoidance(
    playerPosition.x,
    playerPosition.y,
    arena.width,
    arena.height,
  );
  moveX += edge.x * (1 + spacePressure * 0.6);
  moveY += edge.y * (1 + spacePressure * 0.6);
  const moveLen = Math.hypot(moveX, moveY) || 1;
  intent.moveX = moveX / moveLen;
  intent.moveY = moveY / moveLen;
  intent.aimX = hasEnemy ? enemyDx : Math.cos(game.time * 1.3);
  intent.aimY = hasEnemy ? enemyDy : Math.sin(game.time * 1.3);
  intent.fire =
    hasEnemy &&
    goal !== "collect" &&
    perception.enemyDistance < 720 &&
    perception.confidence > 0.18;
  intent.reason = goal;
  brain.goal = goal;

  metrics.botGoal = goal;
  metrics.botFire = intent.fire;
  if (previousGoal !== goal) {
    world.events.emit(BotGoalEvent, {
      goal,
      reason: goalReason(goal, perception),
    });
  }
}

function botApplySystem(world: World, queries: DemoQueries): void {
  const bot = queries.bot.first();
  if (bot === null) return;
  const [, brain, , intent] = bot;
  const input = world.getResource(Input);
  const metrics = world.getResource(Metrics);

  metrics.botGoal = brain.goal;
  metrics.botFire = intent.fire;

  input.moveX = intent.moveX;
  input.moveY = intent.moveY;
  input.aimX = intent.aimX;
  input.aimY = intent.aimY;
  input.fire = intent.fire;
}

function inputSystem(world: World, queries: DemoQueries): void {
  const player = queries.player.first();
  if (player === null) return;

  const input = world.getResource(Input);
  const [entity, , velocity, weapon] = player;

  const length = Math.hypot(input.moveX, input.moveY) || 1;
  velocity.x = (input.moveX / length) * PLAYER_SPEED;
  velocity.y = (input.moveY / length) * PLAYER_SPEED;
  weapon.cooldown = Math.max(weapon.cooldown, 0);

  const rotation = world.get(entity, Rotation);
  if (rotation) rotation.angle = Math.atan2(input.aimY, input.aimX);
}

function weaponSystem(world: World, queries: DemoQueries, dt: number): void {
  const input = world.getResource(Input);
  const commands = world.getResource(Commands);
  const metrics = world.getResource(Metrics);
  const rng = world.getResource(Random);

  queries.weapons.each((entity, weapon, position) => {
    weapon.cooldown -= dt;
    if (!input.fire || weapon.cooldown > 0) return;

    const aimLength = Math.hypot(input.aimX, input.aimY) || 1;
    const baseAngle = Math.atan2(
      input.aimY / aimLength,
      input.aimX / aimLength,
    );
    const shotCount = world.count(Enemy) > 26 ? 2 : 1;
    for (let i = 0; i < shotCount; i++) {
      const offset = (i - (shotCount - 1) * 0.5) * weapon.spread;
      const jitter = rng.range(-0.02, 0.02);
      const angle = baseAngle + offset + jitter;
      const projectile = world.spawn();
      const owner = world.ref(entity, projectile);
      spawnProjectile(
        projectile,
        commands,
        position.x + Math.cos(angle) * 24,
        position.y + Math.sin(angle) * 24,
        Math.cos(angle) * PROJECTILE_SPEED,
        Math.sin(angle) * PROJECTILE_SPEED,
        owner,
        metrics,
      );
    }
    weapon.cooldown += weapon.cadence;
    metrics.commandBufferPeak = Math.max(
      metrics.commandBufferPeak,
      commands.size(),
    );
  });
}

function spawnerSystem(world: World, queries: DemoQueries, dt: number): void {
  const game = world.getResource(Game);
  const commands = world.getResource(Commands);
  const arena = world.getResource(Arena);
  const rng = world.getResource(Random);
  const metrics = world.getResource(Metrics);
  const targetEnemies = Math.min(18 + game.wave * 5, 92);

  game.nextSpawnIn -= dt;
  while (
    queries.activeEnemies.count() + metrics.spawned < targetEnemies &&
    game.nextSpawnIn <= 0
  ) {
    spawnEnemy(() => world.spawn(), commands, rng, arena, game.wave, metrics);
    game.nextSpawnIn += Math.max(0.055, 0.22 - game.wave * 0.012);
  }
  metrics.commandBufferPeak = Math.max(
    metrics.commandBufferPeak,
    commands.size(),
  );
}

function pulseSystem(world: World, queries: DemoQueries, dt: number): void {
  const game = world.getResource(Game);
  game.nextPulseIn -= dt;
  if (game.nextPulseIn > 0) return;

  const player = queries.player.first();
  if (player === null) {
    game.nextPulseIn += PULSE_INTERVAL;
    return;
  }

  const [, position] = player;
  const commands = world.getResource(Commands);
  const metrics = world.getResource(Metrics);
  const rng = world.getResource(Random);
  const arena = world.getResource(Arena);
  const palette = [0x56d7ff, 0x7dffb2, 0xf7f36b, 0xff7aa8];

  for (let i = 0; i < PULSE_SIZE; i++) {
    const ring = i % 3;
    const lane = Math.floor(i / 3);
    const angle =
      (lane / Math.ceil(PULSE_SIZE / 3)) * Math.PI * 2 +
      ring * 0.18 +
      game.wave * 0.09;
    const startRadius = 18 + ring * 10 + rng.range(-2, 2);
    const speed = 92 + ring * 54 + rng.range(-18, 42);
    const drift = Math.sin(i * 1.618 + game.time) * 0.22;
    const x = clamp(
      position.x + Math.cos(angle) * startRadius,
      -48,
      arena.width + 48,
    );
    const y = clamp(
      position.y + Math.sin(angle) * startRadius,
      -48,
      arena.height + 48,
    );

    spawnSpark(
      () => world.spawn(),
      commands,
      x,
      y,
      Math.cos(angle + drift) * speed,
      Math.sin(angle + drift) * speed,
      palette[(i + game.wave) % palette.length],
      4.4 + ring * 0.58 + rng.range(0, 0.65),
      3.2 + ring * 1.45,
      metrics,
    );
  }

  metrics.pulseSpawned += PULSE_SIZE;
  metrics.commandBufferPeak = Math.max(
    metrics.commandBufferPeak,
    commands.size(),
  );
  game.lastEvent = `pulse +${PULSE_SIZE}`;
  game.nextPulseIn += PULSE_INTERVAL;
}

function enemyAiSystem(world: World, queries: DemoQueries, _dt: number): void {
  const player = queries.player.first();
  if (player === null) return;
  const [, playerPosition] = player;
  const game = world.getResource(Game);

  queries.ai.each((_entity, position, velocity, ai) => {
    const dx = playerPosition.x - position.x;
    const dy = playerPosition.y - position.y;
    const distance = Math.hypot(dx, dy) || 1;
    const nx = dx / distance;
    const ny = dy / distance;
    const orbit = Math.sin(game.time * 1.6 + ai.phase) * ai.orbit;
    velocity.x = (nx - ny * orbit) * ai.speed;
    velocity.y = (ny + nx * orbit) * ai.speed;
  });
}

function movementSystem(world: World, queries: DemoQueries, dt: number): void {
  const arena = world.getResource(Arena);

  queries.moving.each((entity, position, velocity) => {
    position.x += velocity.x * dt;
    position.y += velocity.y * dt;

    if (world.has(entity, Player)) {
      position.x = clamp(position.x, 24, arena.width - 24);
      position.y = clamp(position.y, 24, arena.height - 24);
    } else if (world.has(entity, Enemy) || world.has(entity, Pickup)) {
      position.x = clamp(position.x, -72, arena.width + 72);
      position.y = clamp(position.y, -72, arena.height + 72);
    }

    const rotation = world.get(entity, Rotation);
    if (rotation) rotation.angle += rotation.spin * dt;
  });
}

function lifetimeSystem(world: World, queries: DemoQueries, dt: number): void {
  const commands = world.getResource(Commands);
  const metrics = world.getResource(Metrics);

  queries.lifetimes.each((entity, lifetime, renderable) => {
    lifetime.remaining -= dt;
    if (lifetime.initial > 0) {
      renderable.alpha = clamp(lifetime.remaining / lifetime.initial, 0, 1);
      renderable.pulse += dt * 9;
    }
    if (lifetime.remaining <= 0) {
      commands.despawn(entity);
      metrics.despawned++;
    }
  });
  metrics.commandBufferPeak = Math.max(
    metrics.commandBufferPeak,
    commands.size(),
  );
}

function spatialIndexSystem(world: World, queries: DemoQueries): void {
  const space = world.getResource(Space);
  space.clear();
  queries.spatialBodies.each((entity, position, radius) => {
    if (!world.has(entity, Dead))
      space.insert(entity, position.x, position.y, radius.value);
  });
}

function collisionSystem(world: World, queries: DemoQueries): void {
  const space = world.getResource(Space);
  const scratch = world.local(CollisionScratch);
  const killed = world.local(KilledThisFrame);
  const commands = world.getResource(Commands);
  const metrics = world.getResource(Metrics);
  const game = world.getResource(Game);

  queries.activeProjectiles.each(
    (projectile, position, radius, damage, owner) => {
      space.queryRadius(
        position.x,
        position.y,
        radius.value + 18,
        (candidate) => world.get(candidate, Position),
        (candidate) => world.get(candidate, Radius)?.value ?? 0,
        scratch,
      );
      metrics.spatialCandidates += scratch.length;
      for (const candidate of scratch) {
        if (candidate === projectile) continue;
        if (!world.has(candidate, Enemy) || world.has(candidate, Dead))
          continue;
        if (world.deref(owner.ref) === candidate) continue;

        const health = world.get(candidate, Health);
        const targetPosition = world.get(candidate, Position);
        if (!health || !targetPosition) continue;

        health.hp -= damage.value;
        health.flash = 1;
        world.markChanged(candidate, Health);
        world.events.emit(DamageEvent, {
          target: candidate,
          amount: damage.value,
          x: targetPosition.x,
          y: targetPosition.y,
        });
        metrics.hits++;
        commands.despawn(projectile);
        metrics.despawned++;

        if (health.hp <= 0 && !killed.has(candidate)) {
          killed.add(candidate);
          commands.add(candidate, Dead, true);
          commands.despawn(candidate);
          metrics.despawned++;
          game.score += 10;
          spawnPickup(
            () => world.spawn(),
            commands,
            targetPosition.x,
            targetPosition.y,
            3 + Math.floor(health.max),
            metrics,
          );
          world.events.emit(BurstEvent, {
            x: targetPosition.x,
            y: targetPosition.y,
            tint: 0xffb347,
            count: 12,
          });
        }
        break;
      }
    },
  );

  const player = queries.player.first();
  if (player !== null) {
    const [playerEntity, playerPosition, , , playerHealth] = player;
    collectPickups(
      world,
      queries,
      playerEntity,
      playerPosition.x,
      playerPosition.y,
    );
    damagePlayer(world, playerEntity, playerPosition, playerHealth);
  }

  metrics.commandBufferPeak = Math.max(
    metrics.commandBufferPeak,
    commands.size(),
  );
}

function collectPickups(
  world: World,
  queries: DemoQueries,
  playerEntity: Entity,
  playerX: number,
  playerY: number,
): void {
  const space = world.getResource(Space);
  const scratch = world.local(CollisionScratch);
  const game = world.getResource(Game);
  const commands = world.getResource(Commands);
  const metrics = world.getResource(Metrics);

  space.queryRadius(
    playerX,
    playerY,
    30,
    (candidate) => world.get(candidate, Position),
    (candidate) => world.get(candidate, Radius)?.value ?? 0,
    scratch,
  );
  metrics.spatialCandidates += scratch.length;
  for (const candidate of scratch) {
    if (candidate === playerEntity) continue;
    if (!world.has(candidate, Pickup)) continue;
    const pickup = world.get(candidate, PickupValue);
    const position = world.get(candidate, Position);
    if (!pickup || !position) continue;

    game.score += pickup.value;
    metrics.pickups++;
    commands.despawn(candidate);
    metrics.despawned++;
    world.events.emit(PickupEvent, {
      entity: candidate,
      value: pickup.value,
      x: position.x,
      y: position.y,
    });
  }

  metrics.activePickups = queries.activePickups.count();
}

function damagePlayer(
  world: World,
  playerEntity: Entity,
  playerPosition: { x: number; y: number },
  playerHealth: { hp: number; flash: number },
): void {
  const space = world.getResource(Space);
  const scratch = world.local(CollisionScratch);
  const metrics = world.getResource(Metrics);
  const game = world.getResource(Game);

  space.queryRadius(
    playerPosition.x,
    playerPosition.y,
    20,
    (candidate) => world.get(candidate, Position),
    (candidate) => world.get(candidate, Radius)?.value ?? 0,
    scratch,
  );
  metrics.spatialCandidates += scratch.length;
  for (const candidate of scratch) {
    if (candidate === playerEntity) continue;
    if (!world.has(candidate, Enemy) || world.has(candidate, Dead)) continue;
    playerHealth.hp = Math.max(1, playerHealth.hp - 0.015);
    playerHealth.flash = 1;
    game.playerHits++;
    break;
  }
}

function effectsSystem(world: World): void {
  const commands = world.getResource(Commands);
  const rng = world.getResource(Random);
  const metrics = world.getResource(Metrics);

  for (const event of world.events.read(DamageEvent)) {
    spawnBurst(
      () => world.spawn(),
      commands,
      rng,
      event.x,
      event.y,
      0xfff36b,
      Math.min(6, 2 + Math.ceil(event.amount * 2)),
      metrics,
    );
  }

  for (const event of world.events.read(PickupEvent)) {
    spawnBurst(
      () => world.spawn(),
      commands,
      rng,
      event.x,
      event.y,
      0x7dffb2,
      8 + Math.min(event.value, 8),
      metrics,
    );
  }

  for (const event of world.events.read(BurstEvent)) {
    spawnBurst(
      () => world.spawn(),
      commands,
      rng,
      event.x,
      event.y,
      event.tint,
      event.count,
      metrics,
    );
  }

  const player = world.query(Position, Player)[0];
  if (player && world.getResource(Game).frame % 2 === 0) {
    const [, position] = player;
    spawnSpark(
      () => world.spawn(),
      commands,
      position.x,
      position.y,
      rng.range(-18, 18),
      rng.range(36, 84),
      0x56d7ff,
      0.36,
      2.2,
      metrics,
    );
  }
}

function waveProgressSystem(world: World, queries: DemoQueries): void {
  const game = world.getResource(Game);
  const metrics = world.getResource(Metrics);
  const activeEnemies = queries.activeEnemies.count();
  metrics.activeEnemies = activeEnemies;
  metrics.activeProjectiles = queries.activeProjectiles.count();

  if (game.frame > 60 && activeEnemies === 0 && game.nextSpawnIn > 0.4) {
    game.wave++;
    game.nextSpawnIn = 0.05;
    game.lastEvent = `wave ${game.wave}`;
    world.events.emit(WaveEvent, { wave: game.wave });
  }
}

function serializeProbeSystem(world: World): void {
  const game = world.getResource(Game);
  const input = world.getResource(Input);
  const shouldProbe = input.requestSnapshot || game.frame % 150 === 0;
  input.requestSnapshot = false;
  if (!shouldProbe) return;

  const serializer = createDemoSerializer();
  const snapshot = serializer.snapshot(world);
  const clone = new World({ maxEntities: 12000 });
  createDemoSerializer().restore(clone, snapshot);
  const liveHash = summarizeSerializableWorld(world);
  const cloneHash = summarizeSerializableWorld(clone);

  game.snapshotBytes = snapshot.byteLength;
  game.restoreHash = cloneHash;
  game.restoreOk = liveHash === cloneHash;
  game.lastEvent = game.restoreOk ? "snapshot restored" : "snapshot mismatch";
}

function metricsSystem(world: World, queries: DemoQueries): void {
  const metrics = world.getResource(Metrics);
  const commands = world.getResource(Commands);
  metrics.commandBufferPeak = Math.max(
    metrics.commandBufferPeak,
    commands.size(),
  );
  metrics.incrementalActors = queries.incrementalActors.count();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function replaceRef(
  world: World,
  holder: Entity,
  previous: EntityRef,
  target: Entity | null,
): EntityRef {
  const current = previous === NULL_REF ? null : world.deref(previous);
  if (current === target && previous !== NULL_REF) return previous;
  if (previous !== NULL_REF) world.unref(previous, holder);
  return target === null ? NULL_REF : world.ref(target, holder);
}

function edgeAvoidance(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const margin = 168;
  let avoidX = 0;
  let avoidY = 0;
  if (x < margin) avoidX += ((margin - x) / margin) ** 1.2;
  if (x > width - margin) avoidX -= ((x - (width - margin)) / margin) ** 1.2;
  if (y < margin) avoidY += ((margin - y) / margin) ** 1.2;
  if (y > height - margin) avoidY -= ((y - (height - margin)) / margin) ** 1.2;
  return { x: avoidX * 1.15, y: avoidY * 1.15 };
}

function arenaTrapPressure(
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const margin = 190;
  const horizontal = Math.max(
    clamp((margin - x) / margin, 0, 1),
    clamp((x - (width - margin)) / margin, 0, 1),
  );
  const vertical = Math.max(
    clamp((margin - y) / margin, 0, 1),
    clamp((y - (height - margin)) / margin, 0, 1),
  );
  return clamp(
    Math.max(horizontal, vertical) * 0.65 + horizontal * vertical,
    0,
    1.45,
  );
}

const OPEN_SPACE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

function openSpaceVector(
  x: number,
  y: number,
  width: number,
  height: number,
  queries: DemoQueries,
): { x: number; y: number; score: number } {
  let bestX = 0;
  let bestY = 0;
  let bestScore = -Infinity;
  const sampleDistance = 198;
  const farDistance = 316;

  for (const [dirX, dirY] of OPEN_SPACE_DIRECTIONS) {
    const sampleX = clamp(x + dirX * sampleDistance, 54, width - 54);
    const sampleY = clamp(y + dirY * sampleDistance, 54, height - 54);
    const farX = clamp(x + dirX * farDistance, 54, width - 54);
    const farY = clamp(y + dirY * farDistance, 54, height - 54);
    const midX = clamp(x + dirX * 112, 54, width - 54);
    const midY = clamp(y + dirY * 112, 54, height - 54);
    const score =
      openSpaceScore(sampleX, sampleY, width, height, queries) +
      openSpaceScore(farX, farY, width, height, queries) * 0.5 -
      dangerPressureAt(midX, midY, queries) * 0.45;
    if (score > bestScore) {
      bestScore = score;
      bestX = dirX;
      bestY = dirY;
    }
  }

  return { x: bestX, y: bestY, score: bestScore };
}

function openSpaceScore(
  x: number,
  y: number,
  width: number,
  height: number,
  queries: DemoQueries,
): number {
  const edgeClearance = Math.min(x, y, width - x, height - y);
  const centerDistance = Math.hypot(x - width / 2, y - height / 2);
  const maxCenterDistance = Math.hypot(width / 2, height / 2);
  let score =
    clamp((edgeClearance - 48) / 220, -0.7, 1) * 1.05 +
    clamp(1 - centerDistance / maxCenterDistance, 0, 1) * 0.38 -
    arenaTrapPressure(x, y, width, height) * 1.1;

  score -= dangerPressureAt(x, y, queries);
  return score;
}

function dangerPressureAt(x: number, y: number, queries: DemoQueries): number {
  let pressure = 0;
  queries.activeEnemies.each((_, position) => {
    const distance = Math.hypot(position.x - x, position.y - y);
    if (distance >= 380) return;
    const enemyPressure = 1 - distance / 380;
    pressure += enemyPressure * enemyPressure * 1.45;
  });

  queries.activeProjectiles.each((_, position) => {
    const distance = Math.hypot(position.x - x, position.y - y);
    if (distance >= 240) return;
    const projectilePressure = 1 - distance / 240;
    pressure += projectilePressure * projectilePressure * 1.9;
  });

  return pressure;
}

function goalReason(
  goal: BotGoal,
  perception: {
    enemyDistance: number;
    pickupDistance: number;
    threatDistance: number;
  },
): string {
  switch (goal) {
    case "evade":
      return `threat ${Math.round(perception.threatDistance)}`;
    case "collect":
      return `pickup ${Math.round(perception.pickupDistance)}`;
    case "kite":
      return `enemy close ${Math.round(perception.enemyDistance)}`;
    case "engage":
      return `target ${Math.round(perception.enemyDistance)}`;
  }
}
