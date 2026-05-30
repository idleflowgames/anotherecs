// Incremental query: opt-in, maintained not rebuilt
// Maintains its match set incrementally as components are added/removed (and on
// despawn), instead of rebuilding via a full smallest-store scan on the next
// access after a mutation. This avoids the per-frame O(n) rebuild the
// version-cached QueryEngine pays for a query that mutates and re-queries the
// same components every frame.
//
// How it works: the World indexes incremental queries by component id and calls
// `reconcile(entity)` on every add/remove of a membership component (with /
// without / any). reconcile rechecks membership in O(terms) and adds/removes the
// entity from a dense match list backed by a sparse `pos` index: the store's own
// swap-delete bookkeeping, one level up. `maybe` components never change
// membership, so they skip reconcile; `each()` reads their values live and
// `results()` refreshes them lazily.
//
// Determinism: match-list order is append-on-match, swap-delete-on-unmatch, a
// pure function of the operation sequence, but DIFFERENT from the rebuild path's
// smallest-store-dense order. Hence opt-in: a consumer chooses it per hot query
// and accepts that order, while `query` / `compileQuery` / `select` keep their
// rebuild order and caching. A single boolean gates the World's hooks.

import type { YieldSlot } from "./query";
import type { ComponentStore } from "./store";
import type { Entity, QueryResult } from "./types";

/** The minimal store-access surface (mirrors the QueryEngine's Queryable). */
export interface IncrementalAccess {
  isAlive(entity: Entity): boolean;
  storeIfPresent(id: number): ComponentStore<unknown> | undefined;
}

type EachFn = (entity: Entity, ...components: unknown[]) => void;

export class IncrementalQuery {
  /** Required component ids. */
  readonly withIds: number[];
  /** Excluded component ids. */
  readonly withoutIds: number[];
  /** Optional component ids (yielded, never constrain membership). */
  readonly maybeIds: number[];
  /** `any(...)` groups: at least one member of each must be present. */
  readonly anyGroups: number[][];
  /** Declaration-ordered yield slots (with + maybe). */
  readonly yieldPlan: YieldSlot[];
  /**
   * Components whose add/remove must trigger a reconcile: with ∪ without ∪ any.
   * NOT maybe (it never changes membership). The World registers the query under
   * exactly these ids.
   */
  readonly membershipDeps: number[];

  // Dense match list + sparse entity->index (-1 if absent), mirroring the store.
  private readonly entities: Entity[] = [];
  private readonly pos: Int32Array;
  // Bumped whenever reconcile adds or removes a member; drives results() reuse.
  private membershipVersion = 0;

  // Reused per-call buffers (one allocation per query arity, not per entity).
  private readonly yieldStores: (ComponentStore<unknown> | undefined)[] = [];
  private readonly scratch: unknown[];

  // Maintained results() tuple cache: rebuilt over the (already maintained)
  // entities list only when membership changed or a yielded store changed.
  private cachedResults: QueryResult<unknown[]>[] = [];
  private resultsBuiltAt = -1;
  private readonly yieldDepVersions: number[];
  private readonly access: IncrementalAccess;

  constructor(
    access: IncrementalAccess,
    capacity: number,
    withIds: number[],
    withoutIds: number[],
    maybeIds: number[],
    anyGroups: number[][],
    yieldPlan: YieldSlot[],
  ) {
    this.access = access;
    this.withIds = withIds;
    this.withoutIds = withoutIds;
    this.maybeIds = maybeIds;
    this.anyGroups = anyGroups;
    this.yieldPlan = yieldPlan;
    const deps = new Set<number>(withIds);
    for (let i = 0; i < withoutIds.length; i++) deps.add(withoutIds[i]);
    for (let g = 0; g < anyGroups.length; g++)
      for (let j = 0; j < anyGroups[g].length; j++) deps.add(anyGroups[g][j]);
    this.membershipDeps = [...deps];
    this.pos = new Int32Array(capacity).fill(-1);
    this.scratch = new Array(1 + yieldPlan.length);
    this.yieldDepVersions = new Array(yieldPlan.length).fill(-1);
  }

  /** Whether `entity` satisfies every with/without/any term and is alive. */
  private matches(entity: number): boolean {
    if (!this.access.isAlive(entity as Entity)) return false;
    for (let i = 0; i < this.withIds.length; i++) {
      const s = this.access.storeIfPresent(this.withIds[i]);
      if (s === undefined || !s.has(entity as Entity)) return false;
    }
    for (let i = 0; i < this.withoutIds.length; i++) {
      const s = this.access.storeIfPresent(this.withoutIds[i]);
      if (s?.has(entity as Entity)) return false;
    }
    for (let g = 0; g < this.anyGroups.length; g++) {
      const group = this.anyGroups[g];
      let satisfied = false;
      for (let j = 0; j < group.length; j++) {
        const s = this.access.storeIfPresent(group[j]);
        if (s?.has(entity as Entity)) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) return false;
    }
    return true;
  }

  /**
   * Bring `entity`'s membership in line with `matches()`. Called by the World on
   * any membership-component add/remove for the entity, or on despawn. O(terms).
   */
  reconcile(entity: number): void {
    const should = this.matches(entity);
    const at = this.pos[entity];
    if (should && at === -1) {
      this.pos[entity] = this.entities.length;
      this.entities.push(entity as Entity);
      this.membershipVersion++;
    } else if (!should && at !== -1) {
      const last = this.entities.length - 1;
      const lastEntity = this.entities[last] as number;
      this.entities[at] = lastEntity as Entity;
      this.pos[lastEntity] = at;
      this.entities.length = last;
      this.pos[entity] = -1;
      this.membershipVersion++;
    }
  }

  /**
   * One-time full population, for compiling against an already-populated world.
   * Scans the smallest required store and reconciles each of its entities.
   */
  rebuildFromStores(): void {
    this.clear();
    let smallest = this.access.storeIfPresent(this.withIds[0]);
    if (smallest === undefined) return; // withIds[0]'s store absent => no matches
    for (let i = 1; i < this.withIds.length; i++) {
      const s = this.access.storeIfPresent(this.withIds[i]);
      if (s === undefined) return; // a required store is absent => no matches
      if (smallest === undefined || s.size() < smallest.size()) smallest = s;
    }
    if (smallest === undefined || smallest.size() === 0) return;
    const ents = smallest.iterEntities();
    for (let i = 0; i < ents.length; i++) this.reconcile(ents[i] as number);
  }

  /** Drop the whole match set (World.clear()). */
  clear(): void {
    for (let i = 0; i < this.entities.length; i++) {
      this.pos[this.entities[i] as number] = -1;
    }
    this.entities.length = 0;
    this.membershipVersion++;
  }

  count(): number {
    return this.entities.length;
  }

  /** The live match list (deterministic incremental order). Read-only. */
  view(): readonly Entity[] {
    return this.entities;
  }

  // Resolve the store for each yield slot into the reused `yieldStores` buffer.
  private resolveYieldStores(): void {
    const stores = this.yieldStores;
    const { yieldPlan } = this;
    stores.length = 0;
    for (let i = 0; i < yieldPlan.length; i++) {
      stores.push(this.access.storeIfPresent(yieldPlan[i].id));
    }
  }

  /**
   * Zero-rebuild iteration over the maintained match set. The callback must NOT
   * add/remove a membership component on a visited entity: that mutates the live
   * match list mid-iteration (swap-delete) and skips/double-visits; use
   * {@link results} for a stable snapshot. The generic lane shares one scratch
   * buffer, so do not re-enter this query's each() from within the callback.
   */
  each(fn: EachFn): void {
    const ents = this.entities;
    if (ents.length === 0) return;
    this.resolveYieldStores();
    const { yieldStores, yieldPlan } = this;
    // Fast lanes: all-required (no maybe), small arity; values via getUnsafe.
    if (this.maybeIds.length === 0 && yieldPlan.length <= 2) {
      if (yieldPlan.length === 1) {
        const s0 = yieldStores[0];
        if (s0 === undefined) return;
        for (let i = 0; i < ents.length; i++)
          fn(ents[i], s0.getUnsafe(ents[i]));
        return;
      }
      const s0 = yieldStores[0];
      const s1 = yieldStores[1];
      if (s0 === undefined || s1 === undefined) return;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        fn(e, s0.getUnsafe(e), s1.getUnsafe(e));
      }
      return;
    }
    // Generic lane: reused scratch; optional slots via get (=> value|undefined).
    const scratch = this.scratch;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      scratch[0] = e;
      for (let k = 0; k < yieldPlan.length; k++) {
        const s = yieldStores[k];
        scratch[1 + k] =
          s === undefined
            ? undefined
            : yieldPlan[k].optional
              ? s.get(e)
              : s.getUnsafe(e);
      }
      fn.apply(undefined, scratch as never);
    }
  }

  // Whether any yielded store changed since the results() cache was built (an
  // object replacement or a maybe add/remove that membership didn't capture).
  private yieldDepsChanged(): boolean {
    const yieldDepVersions = this.yieldDepVersions;
    const { yieldPlan } = this;
    for (let i = 0; i < yieldPlan.length; i++) {
      const s = this.access.storeIfPresent(yieldPlan[i].id);
      const v = s === undefined ? -1 : s.version;
      if (v !== yieldDepVersions[i]) return true;
    }
    return false;
  }

  /**
   * Allocation-stable tuple view, rebuilt over the (already maintained) match set
   * only when membership changed or a yielded component store changed, so it
   * stays cached across mutations to UNrelated components AND across frames with
   * no relevant change. Tuples follow declaration (yield) order. Do not retain
   * the array across a structural change (the reference is swapped on rebuild).
   */
  results(): readonly QueryResult<unknown[]>[] {
    if (
      this.resultsBuiltAt === this.membershipVersion &&
      !this.yieldDepsChanged()
    )
      return this.cachedResults;
    this.resolveYieldStores();
    const { entities, yieldStores, yieldPlan, yieldDepVersions } = this;
    const out: QueryResult<unknown[]>[] = new Array(entities.length);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const tuple: QueryResult<unknown[]> = [e];
      for (let k = 0; k < yieldPlan.length; k++) {
        const s = yieldStores[k];
        tuple.push(
          s === undefined
            ? undefined
            : yieldPlan[k].optional
              ? s.get(e)
              : s.getUnsafe(e),
        );
      }
      out[i] = tuple;
    }
    this.cachedResults = out;
    this.resultsBuiltAt = this.membershipVersion;
    for (let i = 0; i < yieldPlan.length; i++) {
      const s = this.access.storeIfPresent(yieldPlan[i].id);
      yieldDepVersions[i] = s === undefined ? -1 : s.version;
    }
    return out;
  }
}
