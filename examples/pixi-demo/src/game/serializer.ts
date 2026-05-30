import {
  type ComponentCodec,
  Serializer,
  type World,
} from "@idleflowgames/anotherecs";
import {
  type ActorKind,
  Ai,
  type AiData,
  Damage,
  type DamageData,
  Dead,
  Enemy,
  Health,
  type HealthData,
  Lifetime,
  type LifetimeData,
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
  Spark,
  Velocity,
  type VelocityData,
  Weapon,
  type WeaponData,
} from "./components";
import { hashStep } from "./random";

const kindToId: Record<ActorKind, number> = {
  player: 0,
  enemy: 1,
  projectile: 2,
  pickup: 3,
  spark: 4,
  trail: 5,
};

const idToKind: ActorKind[] = [
  "player",
  "enemy",
  "projectile",
  "pickup",
  "spark",
  "trail",
];

const tagCodec: ComponentCodec<true> = {
  write: (_view, offset) => offset,
  read: (_view, offset) => ({ value: true, offset }),
};

const positionCodec: ComponentCodec<PositionData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.x, true);
    view.setFloat64(offset + 8, c.y, true);
    return offset + 16;
  },
  read: (view, offset) => ({
    value: {
      x: view.getFloat64(offset, true),
      y: view.getFloat64(offset + 8, true),
    },
    offset: offset + 16,
  }),
};

const velocityCodec: ComponentCodec<VelocityData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.x, true);
    view.setFloat64(offset + 8, c.y, true);
    return offset + 16;
  },
  read: (view, offset) => ({
    value: {
      x: view.getFloat64(offset, true),
      y: view.getFloat64(offset + 8, true),
    },
    offset: offset + 16,
  }),
};

const rotationCodec: ComponentCodec<RotationData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.angle, true);
    view.setFloat64(offset + 8, c.spin, true);
    return offset + 16;
  },
  read: (view, offset) => ({
    value: {
      angle: view.getFloat64(offset, true),
      spin: view.getFloat64(offset + 8, true),
    },
    offset: offset + 16,
  }),
};

const radiusCodec: ComponentCodec<RadiusData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.value, true);
    return offset + 8;
  },
  read: (view, offset) => ({
    value: { value: view.getFloat64(offset, true) },
    offset: offset + 8,
  }),
};

const healthCodec: ComponentCodec<HealthData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.hp, true);
    view.setFloat64(offset + 8, c.max, true);
    view.setFloat64(offset + 16, c.flash, true);
    return offset + 24;
  },
  read: (view, offset) => ({
    value: {
      hp: view.getFloat64(offset, true),
      max: view.getFloat64(offset + 8, true),
      flash: view.getFloat64(offset + 16, true),
    },
    offset: offset + 24,
  }),
};

const damageCodec: ComponentCodec<DamageData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.value, true);
    return offset + 8;
  },
  read: (view, offset) => ({
    value: { value: view.getFloat64(offset, true) },
    offset: offset + 8,
  }),
};

const lifetimeCodec: ComponentCodec<LifetimeData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.remaining, true);
    view.setFloat64(offset + 8, c.initial, true);
    return offset + 16;
  },
  read: (view, offset) => ({
    value: {
      remaining: view.getFloat64(offset, true),
      initial: view.getFloat64(offset + 8, true),
    },
    offset: offset + 16,
  }),
};

const aiCodec: ComponentCodec<AiData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.speed, true);
    view.setFloat64(offset + 8, c.orbit, true);
    view.setFloat64(offset + 16, c.phase, true);
    return offset + 24;
  },
  read: (view, offset) => ({
    value: {
      speed: view.getFloat64(offset, true),
      orbit: view.getFloat64(offset + 8, true),
      phase: view.getFloat64(offset + 16, true),
    },
    offset: offset + 24,
  }),
};

const weaponCodec: ComponentCodec<WeaponData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.cooldown, true);
    view.setFloat64(offset + 8, c.cadence, true);
    view.setFloat64(offset + 16, c.spread, true);
    return offset + 24;
  },
  read: (view, offset) => ({
    value: {
      cooldown: view.getFloat64(offset, true),
      cadence: view.getFloat64(offset + 8, true),
      spread: view.getFloat64(offset + 16, true),
    },
    offset: offset + 24,
  }),
};

const pickupCodec: ComponentCodec<PickupData> = {
  write: (view, offset, c) => {
    view.setFloat64(offset, c.value, true);
    return offset + 8;
  },
  read: (view, offset) => ({
    value: { value: view.getFloat64(offset, true) },
    offset: offset + 8,
  }),
};

const renderableCodec: ComponentCodec<RenderableData> = {
  write: (view, offset, c) => {
    view.setUint8(offset, kindToId[c.kind]);
    view.setUint32(offset + 1, c.tint, true);
    view.setFloat64(offset + 5, c.radius, true);
    view.setFloat64(offset + 13, c.alpha, true);
    view.setFloat64(offset + 21, c.pulse, true);
    return offset + 29;
  },
  read: (view, offset) => ({
    value: {
      kind: idToKind[view.getUint8(offset)] ?? "spark",
      tint: view.getUint32(offset + 1, true),
      radius: view.getFloat64(offset + 5, true),
      alpha: view.getFloat64(offset + 13, true),
      pulse: view.getFloat64(offset + 21, true),
    },
    offset: offset + 29,
  }),
};

export function createDemoSerializer(): Serializer {
  return new Serializer()
    .register(Position, positionCodec)
    .register(Velocity, velocityCodec)
    .register(Rotation, rotationCodec)
    .register(Radius, radiusCodec)
    .register(Health, healthCodec)
    .register(Damage, damageCodec)
    .register(Lifetime, lifetimeCodec)
    .register(Ai, aiCodec)
    .register(Weapon, weaponCodec)
    .register(Renderable, renderableCodec)
    .register(PickupValue, pickupCodec)
    .register(Player, tagCodec)
    .register(Enemy, tagCodec)
    .register(Projectile, tagCodec)
    .register(Pickup, tagCodec)
    .register(Spark, tagCodec)
    .register(Dead, tagCodec);
}

export function summarizeSerializableWorld(world: World): number {
  let hash = 2166136261;
  const positions = world
    .query(Position)
    .map(([, position]) => ({
      x: Math.round(position.x * 1000),
      y: Math.round(position.y * 1000),
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  for (const position of positions) {
    hash = hashStep(hash, position.x / 1000);
    hash = hashStep(hash, position.y / 1000);
  }
  hash = hashStep(hash, world.count(Enemy));
  hash = hashStep(hash, world.count(Projectile));
  hash = hashStep(hash, world.count(Pickup));
  hash = hashStep(hash, world.count(Spark));
  return hash >>> 0;
}
