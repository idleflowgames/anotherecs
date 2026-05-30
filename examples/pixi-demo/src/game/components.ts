import {
  defineComponent,
  defineTag,
  type EntityRef,
  NULL_REF,
} from "@idleflowgames/anotherecs";

export type ActorKind =
  | "player"
  | "enemy"
  | "projectile"
  | "pickup"
  | "spark"
  | "trail";

export interface PositionData {
  x: number;
  y: number;
}

export interface VelocityData {
  x: number;
  y: number;
}

export interface RotationData {
  angle: number;
  spin: number;
}

export interface RadiusData {
  value: number;
}

export interface HealthData {
  hp: number;
  max: number;
  flash: number;
}

export interface DamageData {
  value: number;
}

export interface LifetimeData {
  remaining: number;
  initial: number;
}

export interface AiData {
  speed: number;
  orbit: number;
  phase: number;
}

export interface WeaponData {
  cooldown: number;
  cadence: number;
  spread: number;
}

export interface RenderableData {
  kind: ActorKind;
  radius: number;
  tint: number;
  alpha: number;
  pulse: number;
}

export interface PickupData {
  value: number;
}

export interface OwnerData {
  ref: EntityRef;
}

export type BotGoal = "engage" | "collect" | "evade" | "kite";

export interface BotBrainData {
  goal: BotGoal;
  enemyRef: EntityRef;
  pickupRef: EntityRef;
  threatRef: EntityRef;
  aggression: number;
  caution: number;
  spaceBias: number;
}

export interface BotPerceptionData {
  enemyDistance: number;
  enemyX: number;
  enemyY: number;
  pickupDistance: number;
  pickupX: number;
  pickupY: number;
  threatDistance: number;
  threatX: number;
  threatY: number;
  openX: number;
  openY: number;
  openScore: number;
  confidence: number;
}

export interface BotIntentData {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  reason: BotGoal;
}

export const Position = defineComponent<PositionData>(
  "Demo.Position",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);

export const Velocity = defineComponent<VelocityData>(
  "Demo.Velocity",
  () => ({ x: 0, y: 0 }),
  (c) => {
    c.x = 0;
    c.y = 0;
  },
);

export const Rotation = defineComponent<RotationData>(
  "Demo.Rotation",
  () => ({ angle: 0, spin: 0 }),
  (c) => {
    c.angle = 0;
    c.spin = 0;
  },
);

export const Radius = defineComponent<RadiusData>(
  "Demo.Radius",
  () => ({ value: 0 }),
  (c) => {
    c.value = 0;
  },
);

export const Health = defineComponent<HealthData>(
  "Demo.Health",
  () => ({ hp: 1, max: 1, flash: 0 }),
  (c) => {
    c.hp = 1;
    c.max = 1;
    c.flash = 0;
  },
);

export const Damage = defineComponent<DamageData>(
  "Demo.Damage",
  () => ({ value: 1 }),
  (c) => {
    c.value = 1;
  },
);

export const Lifetime = defineComponent<LifetimeData>(
  "Demo.Lifetime",
  () => ({ remaining: 0, initial: 0 }),
  (c) => {
    c.remaining = 0;
    c.initial = 0;
  },
);

export const Ai = defineComponent<AiData>(
  "Demo.Ai",
  () => ({ speed: 0, orbit: 0, phase: 0 }),
  (c) => {
    c.speed = 0;
    c.orbit = 0;
    c.phase = 0;
  },
);

export const Weapon = defineComponent<WeaponData>(
  "Demo.Weapon",
  () => ({ cooldown: 0, cadence: 0.1, spread: 0 }),
  (c) => {
    c.cooldown = 0;
    c.cadence = 0.1;
    c.spread = 0;
  },
);

export const Renderable = defineComponent<RenderableData>(
  "Demo.Renderable",
  () => ({
    kind: "spark",
    radius: 1,
    tint: 0xffffff,
    alpha: 1,
    pulse: 0,
  }),
  (c) => {
    c.kind = "spark";
    c.radius = 1;
    c.tint = 0xffffff;
    c.alpha = 1;
    c.pulse = 0;
  },
);

export const PickupValue = defineComponent<PickupData>(
  "Demo.PickupValue",
  () => ({ value: 1 }),
  (c) => {
    c.value = 1;
  },
);

export const Owner = defineComponent<OwnerData>(
  "Demo.Owner",
  () => ({ ref: NULL_REF }),
  (c) => {
    c.ref = NULL_REF;
  },
);

export const BotBrain = defineComponent<BotBrainData>(
  "Demo.BotBrain",
  () => ({
    goal: "engage",
    enemyRef: NULL_REF,
    pickupRef: NULL_REF,
    threatRef: NULL_REF,
    aggression: 0.72,
    caution: 0.86,
    spaceBias: 1.14,
  }),
  (c) => {
    c.goal = "engage";
    c.enemyRef = NULL_REF;
    c.pickupRef = NULL_REF;
    c.threatRef = NULL_REF;
    c.aggression = 0.72;
    c.caution = 0.86;
    c.spaceBias = 1.14;
  },
);

export const BotPerception = defineComponent<BotPerceptionData>(
  "Demo.BotPerception",
  () => ({
    enemyDistance: 99999,
    enemyX: 0,
    enemyY: 0,
    pickupDistance: 99999,
    pickupX: 0,
    pickupY: 0,
    threatDistance: 99999,
    threatX: 0,
    threatY: 0,
    openX: 0,
    openY: 0,
    openScore: 0,
    confidence: 0,
  }),
  (c) => {
    c.enemyDistance = 99999;
    c.enemyX = 0;
    c.enemyY = 0;
    c.pickupDistance = 99999;
    c.pickupX = 0;
    c.pickupY = 0;
    c.threatDistance = 99999;
    c.threatX = 0;
    c.threatY = 0;
    c.openX = 0;
    c.openY = 0;
    c.openScore = 0;
    c.confidence = 0;
  },
);

export const BotIntent = defineComponent<BotIntentData>(
  "Demo.BotIntent",
  () => ({
    moveX: 0,
    moveY: 0,
    aimX: 1,
    aimY: 0,
    fire: false,
    reason: "engage",
  }),
  (c) => {
    c.moveX = 0;
    c.moveY = 0;
    c.aimX = 1;
    c.aimY = 0;
    c.fire = false;
    c.reason = "engage";
  },
);

export const Player = defineTag("Demo.Player");
export const Enemy = defineTag("Demo.Enemy");
export const Projectile = defineTag("Demo.Projectile");
export const Pickup = defineTag("Demo.Pickup");
export const Spark = defineTag("Demo.Spark");
export const Dead = defineTag("Demo.Dead");
