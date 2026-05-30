import type { Entity } from "@idleflowgames/anotherecs";
import {
  type Application,
  BitmapText,
  Container,
  Graphics,
  GraphicsContext,
  Rectangle,
} from "pixi.js";
import { type ActorKind, Renderable } from "../game/components";
import { Arena, Game, Metrics, Scenario } from "../game/resources";
import type { GameRuntime } from "../game/runtime";

interface ActorView {
  node: Graphics;
  kind: ActorKind;
}

const baseRadius: Record<ActorKind, number> = {
  player: 22,
  enemy: 16,
  projectile: 8,
  pickup: 12,
  spark: 5,
  trail: 3,
};

const zIndex: Record<ActorKind, number> = {
  trail: 1,
  pickup: 2,
  projectile: 3,
  enemy: 4,
  spark: 5,
  player: 6,
};

export class GameRenderer {
  private readonly actorLayer = new Container({
    label: "actors",
    sortableChildren: true,
  });
  private readonly background = new Graphics({
    label: "arena-background",
    roundPixels: true,
  });
  private readonly debugGrid = new Graphics({
    label: "debug-grid",
    roundPixels: true,
  });
  private readonly botOverlay = new Graphics({
    label: "bot-overlay",
    roundPixels: true,
  });
  private readonly hudLayer = new Container({
    label: "hud",
    isRenderGroup: true,
  });
  private readonly pool = new Map<ActorKind, Graphics[]>();
  private readonly root = new Container({
    label: "world",
    isRenderGroup: true,
  });
  private readonly scoreText = new BitmapText({
    text: "",
    style: { fontFamily: "Arial", fontSize: 22, fill: 0xf7fbff },
  });
  private readonly debugText = new BitmapText({
    text: "",
    style: { fontFamily: "Arial", fontSize: 15, fill: 0xb8d7e8 },
  });
  private readonly views = new Map<Entity, ActorView>();
  private readonly contexts = createContexts();
  private debugGridScale = -1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(
    private readonly app: Application,
    private readonly runtime: GameRuntime,
  ) {
    this.root.addChild(this.background);
    this.root.addChild(this.actorLayer);
    this.root.addChild(this.debugGrid);
    this.root.addChild(this.botOverlay);
    this.app.stage.addChild(this.root);
    this.app.stage.addChild(this.hudLayer);
    this.hudLayer.addChild(this.scoreText, this.debugText);
    this.resize();
  }

  resize(): void {
    const arena = this.runtime.world.getResource(Arena);
    const screen = this.app.screen;
    this.scale = Math.min(
      screen.width / arena.width,
      screen.height / arena.height,
    );
    this.offsetX = Math.round((screen.width - arena.width * this.scale) * 0.5);
    this.offsetY = Math.round(
      (screen.height - arena.height * this.scale) * 0.5,
    );
    this.root.scale.set(this.scale);
    this.root.position.set(this.offsetX, this.offsetY);
    this.hudLayer.position.set(0, 0);
    this.scoreText.position.set(24, 18);
    this.debugText.position.set(24, 54);
    this.drawBackground();
    this.debugGridScale = -1;
  }

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.app.canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - this.offsetX) / this.scale,
      y: (clientY - bounds.top - this.offsetY) / this.scale,
    };
  }

  sync(): void {
    const { world, queries } = this.runtime;
    const metrics = world.getResource(Metrics);
    const game = world.getResource(Game);
    const scenario = world.getResource(Scenario);

    for (const entity of world.removed(Renderable)) {
      this.release(entity);
    }

    queries.renderables.each(
      (entity, position, renderable, rotation, health, lifetime) => {
        let view = this.views.get(entity);
        if (!view || view.kind !== renderable.kind) {
          if (view) this.release(entity);
          view = this.acquire(entity, renderable.kind);
        }

        const node = view.node;
        const flash = health?.flash ?? 0;
        const ttlAlpha =
          lifetime && lifetime.initial > 0
            ? Math.max(0, Math.min(1, lifetime.remaining / lifetime.initial))
            : 1;
        const pulse = 1 + Math.sin(game.time * 5 + renderable.pulse) * 0.035;
        const scale =
          (renderable.radius / baseRadius[renderable.kind]) *
          pulse *
          (1 + flash * 0.2);

        node.position.set(position.x, position.y);
        node.rotation = rotation?.angle ?? 0;
        node.scale.set(scale);
        node.alpha = renderable.alpha * ttlAlpha;
        node.tint =
          flash > 0
            ? mixColor(renderable.tint, 0xffffff, flash)
            : renderable.tint;
        node.visible = true;
      },
    );

    metrics.renderViews = this.views.size;
    this.updateHud(scenario.debug, scenario.hud);
    this.updateDebugGrid(scenario.debug);
    this.updateBotOverlay(scenario.debug);
  }

  private acquire(entity: Entity, kind: ActorKind): ActorView {
    const bucket = this.pool.get(kind);
    const node =
      bucket?.pop() ?? new Graphics({ context: this.contexts[kind] });
    node.label = `${kind}-${entity}`;
    node.zIndex = zIndex[kind];
    node.visible = true;
    this.actorLayer.addChild(node);
    const view = { node, kind };
    this.views.set(entity, view);
    return view;
  }

  private release(entity: Entity): void {
    const view = this.views.get(entity);
    if (!view) return;
    view.node.visible = false;
    view.node.alpha = 1;
    view.node.scale.set(1);
    this.views.delete(entity);
    const bucket = this.pool.get(view.kind);
    if (bucket) bucket.push(view.node);
    else this.pool.set(view.kind, [view.node]);
  }

  private drawBackground(): void {
    const arena = this.runtime.world.getResource(Arena);
    const lineWidth = 1 / this.scale;
    this.background.clear();
    this.background.rect(0, 0, arena.width, arena.height).fill(0x0a101b);

    for (let y = 0; y <= arena.height; y += arena.cellSize) {
      this.background.moveTo(0, y).lineTo(arena.width, y).stroke({
        width: lineWidth,
        color: 0x213147,
        alpha: 0.42,
        pixelLine: true,
      });
    }
    for (let x = 0; x <= arena.width; x += arena.cellSize) {
      this.background.moveTo(x, 0).lineTo(x, arena.height).stroke({
        width: lineWidth,
        color: 0x213147,
        alpha: 0.42,
        pixelLine: true,
      });
    }

    this.background
      .rect(12, 12, arena.width - 24, arena.height - 24)
      .stroke({ width: 2 / this.scale, color: 0x7fb7ff, alpha: 0.28 });
    this.background.cullArea = new Rectangle(0, 0, arena.width, arena.height);
  }

  private updateDebugGrid(enabled: boolean): void {
    this.debugGrid.visible = enabled;
    if (!enabled) {
      this.debugGrid.clear();
      this.debugGridScale = -1;
      return;
    }
    if (this.debugGridScale === this.scale) return;

    const arena = this.runtime.world.getResource(Arena);
    const stride = arena.cellSize * 2;
    const alpha = 0.24;
    const lineWidth = 1 / this.scale;
    this.debugGrid.clear();

    for (let y = 0; y < arena.height; y += stride) {
      for (let x = 0; x < arena.width; x += stride) {
        if ((x / stride + y / stride) % 3 !== 0) continue;
        this.debugGrid.rect(x + 3, y + 3, stride - 6, stride - 6).stroke({
          width: lineWidth,
          color: 0x5ff2d2,
          alpha,
          pixelLine: true,
        });
      }
    }
    this.debugGridScale = this.scale;
  }

  private updateHud(debug: boolean, hud: boolean): void {
    this.scoreText.visible = hud;
    this.debugText.visible = hud && debug;
    if (!hud) return;

    const game = this.runtime.world.getResource(Game);
    const metrics = this.runtime.world.getResource(Metrics);
    this.scoreText.text = `score ${game.score}  wave ${game.wave}  entities ${this.runtime.world.entityCount}`;

    if (debug) {
      this.debugText.text =
        `compiled ${metrics.activeEnemies}/${metrics.activeProjectiles}/${metrics.activePickups}` +
        `  incremental ${metrics.incrementalActors}` +
        `  bot ${metrics.botGoal} ${metrics.botFire ? "fire" : "hold"}` +
        ` e${formatDistance(metrics.botTargetDistance)}` +
        ` t${formatDistance(metrics.botThreatDistance)}` +
        ` p${formatDistance(metrics.botPickupDistance)}` +
        `  pulse ${
          metrics.pulseSpawned > 0
            ? `+${metrics.pulseSpawned}`
            : `${Math.ceil(game.nextPulseIn)}s`
        }` +
        `  spatial ${metrics.spatialCandidates}` +
        `  cmd ${metrics.commandBufferPeak}` +
        `  views ${metrics.renderViews}` +
        `  snapshot ${game.snapshotBytes}b ${game.restoreOk ? "ok" : "pending"}`;
    }
  }

  private updateBotOverlay(enabled: boolean): void {
    this.botOverlay.clear();
    this.botOverlay.visible = enabled;
    if (!enabled) return;

    const player = this.runtime.queries.player.first();
    const bot = this.runtime.queries.bot.first();
    if (player === null || bot === null) return;

    const [, playerPosition] = player;
    const [, brain, perception, intent] = bot;

    const lineWidth = 2 / this.scale;
    if (brain.goal === "kite") {
      const openEndX = playerPosition.x + perception.openX * 118;
      const openEndY = playerPosition.y + perception.openY * 118;
      this.botOverlay
        .moveTo(playerPosition.x, playerPosition.y)
        .lineTo(openEndX, openEndY)
        .stroke({
          width: lineWidth,
          color: 0xb8a7ff,
          alpha: 0.34,
          pixelLine: true,
        })
        .circle(openEndX, openEndY, 8 / this.scale)
        .stroke({
          width: lineWidth,
          color: 0xb8a7ff,
          alpha: 0.42,
          pixelLine: true,
        });
    }

    const moveEndX = playerPosition.x + intent.moveX * 92;
    const moveEndY = playerPosition.y + intent.moveY * 92;
    this.botOverlay
      .moveTo(playerPosition.x, playerPosition.y)
      .lineTo(moveEndX, moveEndY)
      .stroke({
        width: lineWidth,
        color: 0x56d7ff,
        alpha: 0.72,
        pixelLine: true,
      })
      .circle(moveEndX, moveEndY, 5 / this.scale)
      .fill({ color: 0x56d7ff, alpha: 0.85 });

    if (this.runtime.world.deref(brain.enemyRef) !== null) {
      this.botOverlay
        .moveTo(playerPosition.x, playerPosition.y)
        .lineTo(perception.enemyX, perception.enemyY)
        .stroke({
          width: lineWidth,
          color: 0xf7f36b,
          alpha: intent.fire ? 0.85 : 0.42,
          pixelLine: true,
        })
        .circle(perception.enemyX, perception.enemyY, 9 / this.scale)
        .stroke({
          width: lineWidth,
          color: 0xf7f36b,
          alpha: 0.62,
          pixelLine: true,
        });
    }

    if (this.runtime.world.deref(brain.pickupRef) !== null) {
      this.botOverlay
        .circle(perception.pickupX, perception.pickupY, 13 / this.scale)
        .stroke({
          width: lineWidth,
          color: 0x7dffb2,
          alpha: brain.goal === "collect" ? 0.82 : 0.34,
          pixelLine: true,
        });
    }

    if (this.runtime.world.deref(brain.threatRef) !== null) {
      this.botOverlay
        .circle(perception.threatX, perception.threatY, 20 / this.scale)
        .stroke({
          width: lineWidth,
          color: 0xff7aa8,
          alpha: brain.goal === "evade" ? 0.76 : 0.26,
          pixelLine: true,
        });
    }
  }
}

function createContexts(): Record<ActorKind, GraphicsContext> {
  return {
    player: new GraphicsContext()
      .poly([24, 0, -16, -15, -9, 0, -16, 15], true)
      .fill(0xffffff)
      .stroke({ width: 2, color: 0xbaf5ff, alpha: 0.8 }),
    enemy: new GraphicsContext()
      .regularPoly(0, 0, 16, 4, Math.PI * 0.25)
      .fill(0xffffff)
      .stroke({ width: 2, color: 0xfff0c8, alpha: 0.5 }),
    projectile: new GraphicsContext()
      .roundRect(-8, -2.5, 16, 5, 2.5)
      .fill(0xffffff)
      .circle(8, 0, 3)
      .fill(0xffffff),
    pickup: new GraphicsContext()
      .star(0, 0, 5, 12, 5, -Math.PI * 0.5)
      .fill(0xffffff)
      .stroke({ width: 1.5, color: 0xd8ffe7, alpha: 0.8 }),
    spark: new GraphicsContext().circle(0, 0, 5).fill(0xffffff),
    trail: new GraphicsContext().circle(0, 0, 3).fill(0xffffff),
  };
}

function mixColor(a: number, b: number, amount: number): number {
  const t = Math.max(0, Math.min(1, amount));
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function formatDistance(distance: number): string {
  return distance >= 9999 ? "-" : String(Math.round(distance));
}
