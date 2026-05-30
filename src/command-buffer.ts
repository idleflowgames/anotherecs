// CommandBuffer: opt-in deferred structural mutation
// Records add / remove / addComponent / despawn and replays them in strict record
// order at a single point chosen by the consumer: an explicit
// `world.applyCommands(buf)`, or a Schedule with a `commandBuffer` (applied at
// each group boundary). Systems enqueue mutations that take effect only after
// iteration finishes, removing mid-iteration structural-mutation hazards.
//
// World, Schedule, and this module reference each other as types only, so there
// is no runtime import cycle.
//
// Caller rules (determinism contract):
//   - Commands replay FIFO (index 0..n-1). The effect is a pure function of the
//     record sequence: no map iteration, sort, RNG, or time.
//   - Do NOT record into a buffer during its own flushInto. The supported entry
//     points (a Schedule group boundary or applyCommands) run no system during
//     apply, so this cannot arise in supported usage.
//   - addComponent stores its `data` Partial by reference and merges at apply
//     time; do not mutate `data` between record and apply (the same
//     read-only-until-applied contract the query result arrays carry).
//   - spawn is NOT buffered: it must return an id synchronously. A system spawns
//     immediately, then records component adds against the returned id, keeping id
//     allocation and recycle order identical to the immediate path.
//   - A recorded despawn defers to the next world.flush() (like world.despawn): a
//     later recorded add writes, then flush() strips it, identical to the
//     equivalent immediate world.* calls.

import type { ComponentType, Entity, PooledComponentType } from "./types";
import type { World } from "./world";

/**
 * A recorded structural mutation. Discriminated by a numeric `kind` (0..3) so the
 * apply switch is a jump table and no string is allocated. Tag plus payload only,
 * no behavior, so the buffer is a pure ordered log that World replays verbatim.
 */
export type Command =
  | { kind: 0; type: ComponentType<unknown>; entity: Entity; data: unknown } // add
  | { kind: 1; type: ComponentType<unknown>; entity: Entity } // remove
  | {
      kind: 2;
      type: PooledComponentType<object>;
      entity: Entity;
      data?: object;
    } // addComponent
  | { kind: 3; entity: Entity }; // despawn

/**
 * Records add/remove/addComponent/despawn and replays them, in record order, when
 * the consumer flushes the buffer (via `world.applyCommands(buf)` or a Schedule
 * configured with `commandBuffer`). Mirrors the World mutation surface so call
 * sites read identically to immediate mutation.
 */
export class CommandBuffer {
  private readonly commands: Command[] = [];

  /** Queue `world.add(entity, type, data)` for replay. Mirrors World.add. */
  add<T>(entity: Entity, type: ComponentType<T>, data: T): this {
    this.commands.push({
      kind: 0,
      type: type as ComponentType<unknown>,
      entity,
      data,
    });
    return this;
  }

  /** Queue `world.remove(entity, type)` for replay. Mirrors World.remove. */
  remove<T>(entity: Entity, type: ComponentType<T>): this {
    this.commands.push({
      kind: 1,
      type: type as ComponentType<unknown>,
      entity,
    });
    return this;
  }

  /**
   * Queue `world.addComponent(entity, def, data)` for replay. The factory/pool
   * acquisition and the Object.assign merge happen at APPLY time, not record time,
   * so a pooled object is never aliased while still recorded. The `data` Partial
   * is held by reference; do not mutate it between record and apply.
   */
  addComponent<T extends object>(
    entity: Entity,
    def: PooledComponentType<T>,
    data?: Partial<T>,
  ): this {
    this.commands.push({
      kind: 2,
      type: def as unknown as PooledComponentType<object>,
      entity,
      data: data as object | undefined,
    });
    return this;
  }

  /** Queue `world.despawn(entity)` for replay (it then defers to the next flush). */
  despawn(entity: Entity): this {
    this.commands.push({ kind: 3, entity });
    return this;
  }

  /** Number of queued commands (for tests/metrics). */
  size(): number {
    return this.commands.length;
  }

  /** Whether any command is queued. */
  isEmpty(): boolean {
    return this.commands.length === 0;
  }

  /** Drop all queued commands without applying them. */
  clear(): void {
    this.commands.length = 0;
  }

  /**
   * Apply every queued command against `world` in record order, then clear.
   * Equivalent to calling the matching `world.*` method for each, in order.
   * Idempotent on an empty buffer (no-op). Reused after apply (the array is
   * truncated, not reallocated).
   *
   * Iterated forward, index-based; record order is the contract. Each branch
   * delegates to the existing World method verbatim, so all version-bump /
   * pooling / deferred-despawn semantics are inherited unchanged.
   */
  flushInto(world: World): void {
    const commands = this.commands;
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      switch (c.kind) {
        case 0:
          world.add(c.entity, c.type, c.data);
          break;
        case 1:
          world.remove(c.entity, c.type);
          break;
        case 2:
          world.addComponent(c.entity, c.type, c.data);
          break;
        case 3:
          world.despawn(c.entity);
          break;
      }
    }
    this.commands.length = 0;
  }
}
