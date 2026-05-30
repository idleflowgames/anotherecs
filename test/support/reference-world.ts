import type { Entity } from "../../src/types";

/** Minimal component token; the oracle only needs the id. */
type Token = { readonly id: number };

/**
 * A deliberately naive ECS used as (a) a brute-force oracle for differential
 * tests and (b) a baseline for benchmarks. Map-of-Maps storage, no query cache.
 * Mirrors World's deferred-despawn + recycled-id semantics so a step-by-step
 * comparison against World is apples-to-apples. Kept independent from World so
 * it cannot hide a bug in World.
 */
export class ReferenceWorld {
  private nextId = 1; // 0 reserved, matching World
  private readonly recycled: number[] = [];
  private readonly alive = new Set<number>();
  private readonly pending: number[] = [];
  private readonly stores = new Map<number, Map<number, unknown>>();

  spawn(): Entity {
    const id =
      this.recycled.length > 0
        ? (this.recycled.pop() as number)
        : this.nextId++;
    this.alive.add(id);
    return id as Entity;
  }

  despawn(id: Entity): void {
    this.pending.push(id as number);
  }

  flush(): void {
    for (const id of this.pending) {
      if (!this.alive.delete(id)) continue;
      for (const store of this.stores.values()) store.delete(id);
      this.recycled.push(id);
    }
    this.pending.length = 0;
  }

  isAlive(id: Entity): boolean {
    return this.alive.has(id as number);
  }

  add(id: Entity, def: Token, value: unknown): void {
    let store = this.stores.get(def.id);
    if (!store) {
      store = new Map();
      this.stores.set(def.id, store);
    }
    store.set(id as number, value);
  }

  remove(id: Entity, def: Token): void {
    this.stores.get(def.id)?.delete(id as number);
  }

  has(id: Entity, def: Token): boolean {
    return this.stores.get(def.id)?.has(id as number) ?? false;
  }

  /** Brute-force membership: alive entities present in every named store. */
  query(...defs: Token[]): number[] {
    const out: number[] = [];
    for (const id of this.alive) {
      let all = true;
      for (const def of defs) {
        if (!this.stores.get(def.id)?.has(id)) {
          all = false;
          break;
        }
      }
      if (all) out.push(id);
    }
    return out.sort((a, b) => a - b);
  }

  /** Like query() but rebuilds `[id, ...components]` tuples each call (bench baseline). */
  queryTuples(...defs: Token[]): unknown[][] {
    const out: unknown[][] = [];
    for (const id of this.alive) {
      const tuple: unknown[] = [id];
      let all = true;
      for (const def of defs) {
        const c = this.stores.get(def.id)?.get(id);
        if (c === undefined) {
          all = false;
          break;
        }
        tuple.push(c);
      }
      if (all) out.push(tuple);
    }
    return out;
  }

  aliveIds(): number[] {
    return [...this.alive].sort((a, b) => a - b);
  }

  storeMembers(def: Token): number[] {
    const store = this.stores.get(def.id);
    return store ? [...store.keys()].sort((a, b) => a - b) : [];
  }
}
