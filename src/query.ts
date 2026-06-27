// Query engine: cached, allocation-stable, smallest-store-first
// The matching entity list is cached and rebuilt only on a world version bump,
// not per call. Component object references are stable (each component is created
// once and mutated in place), so the cached result tuples stay valid until the
// next version bump too.
//
// Returned arrays are READ-ONLY and must not be retained across a structural
// change (add/remove/despawn): the version bump rebuilds the array, so stale
// retention is observable (the same contract as iterData()).

import type { Bitmask } from "./bitmask";
import type { ComponentStore } from "./store";
import type {
  AnyComponentType,
  AnyGroup,
  ComponentType,
  Entity,
  QueryArg,
  QueryResult,
  QueryTerm,
} from "./types";
// Query filter term builders
// These wrap a def or group of defs to mark its role inside a QuerySpec passed
// to `world.select(...)`. A bare `ComponentType` passed to select() is treated
// as a required `with` term without wrapping.

/** Exclude entities that have `def`. Contributes no value to the yield tuple. */
export function without<T>(def: ComponentType<T>): QueryTerm<T> {
  return { kind: "without", def };
}

/**
 * Yield `def`'s value when present, `undefined` when absent; never constrains
 * membership. Contributes a `T | undefined` slot to the yield tuple in
 * declaration order.
 */
export function maybe<T>(def: ComponentType<T>): QueryTerm<T> {
  return { kind: "maybe", def };
}

/**
 * Require at least one of `defs` to be present. Contributes no value to the
 * yield tuple. `defs` is typed {@link AnyComponentType}[] so specific component
 * types flow in without a cast.
 */
export function any(...defs: AnyComponentType[]): AnyGroup {
  return { kind: "any", defs };
}

/** One declaration-ordered yield slot: the def's id and whether it is optional. */
export interface YieldSlot {
  id: number;
  optional: boolean;
}

/** Normalized form of a `select()` / `compileIncremental()` argument list. */
export interface ParsedQuery {
  /** Required (`with`) component defs, in declaration order. */
  withDefs: ComponentType<unknown>[];
  /** Required (`with`) component ids, in declaration order. */
  withIds: number[];
  /** Excluded (`without`) component ids. */
  withoutIds: number[];
  /** Optional (`maybe`) component ids (yielded, never constrain membership). */
  maybeIds: number[];
  /** `any(...)` groups: at least one member of each must be present. */
  anyGroups: number[][];
  /** Declaration-ordered yield slots (`with` + `maybe`; without/any excluded). */
  yieldPlan: YieldSlot[];
}

/**
 * Normalize a {@link QueryArg} list (bare defs = required `with`,
 * `without(...)` / `maybe(...)` terms, and `any(...)` groups) into id arrays and
 * a declaration-ordered yield plan. Shared by {@link QueryEngine.compileSpec} and
 * `World.compileIncremental` so both accept the identical filter spec. Throws if
 * there is no required (`with`) term: driving iteration off the whole alive set
 * is an O(all-entities) scan and a determinism-order question we keep closed.
 */
export function parseQueryArgs(args: QueryArg[]): ParsedQuery {
  const withDefs: ComponentType<unknown>[] = [];
  const withIds: number[] = [];
  const withoutIds: number[] = [];
  const maybeIds: number[] = [];
  const anyGroups: number[][] = [];
  const yieldPlan: YieldSlot[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ("kind" in arg) {
      if (arg.kind === "any") {
        const group: number[] = [];
        for (let j = 0; j < arg.defs.length; j++) group.push(arg.defs[j].id);
        anyGroups.push(group);
      } else if (arg.kind === "without") {
        withoutIds.push(arg.def.id);
      } else if (arg.kind === "maybe") {
        maybeIds.push(arg.def.id);
        yieldPlan.push({ id: arg.def.id, optional: true });
      } else {
        withDefs.push(arg.def);
        withIds.push(arg.def.id);
        yieldPlan.push({ id: arg.def.id, optional: false });
      }
    } else {
      withDefs.push(arg);
      withIds.push(arg.id);
      yieldPlan.push({ id: arg.id, optional: false });
    }
  }
  if (withDefs.length === 0) {
    throw new Error(
      "a query needs at least one required (non-maybe, non-without) component",
    );
  }
  return { withDefs, withIds, withoutIds, maybeIds, anyGroups, yieldPlan };
}

/** The minimal World surface the query engine reads. */
export interface Queryable {
  isAlive(entity: Entity): boolean;
  /** The store for a component id, or undefined if none exists yet (no lazy create). */
  storeIfPresent(id: number): ComponentStore<unknown> | undefined;
  /**
   * The opt-in per-entity component bitmask index, or null when disabled. When
   * present, `rebuildEntities` replaces its per-store `has()` probe loop with a
   * single signature AND.
   */
  bitmask(): Bitmask | null;
}

interface QueryCache {
  key: string;
  ids: number[];
  // Stores resolved in call order, refreshed alongside `entities`. Invariant:
  // whenever `entities.length > 0` this holds exactly `ids.length` live stores
  // in call order. A query that cannot match leaves both `entities` empty and
  // `stores` short, so store access is always gated on a non-empty `entities`.
  stores: ComponentStore<unknown>[];
  entities: Entity[];
  results: QueryResult<unknown[]>[];
  // Build epochs. `entitiesVersion` is bumped each time the entity list is
  // rebuilt; `resultsVersion` records the epoch at which the tuple array was
  // last built, so `each` and `query`/`results` can reuse matching work.
  entitiesVersion: number;
  resultsVersion: number;
  // Every store id this cache reads (required `with` ∪ without ∪ any ∪ maybe),
  // and a snapshot of their per-store versions at the last entities rebuild. The
  // cache rebuilds only when one of THESE stores changed; a mutation to an
  // unrelated component no longer invalidates this query.
  depIds: number[];
  depVersions: number[];
  // Cached required-components bitmask signature for the accelerated rebuild
  // (static per cache; computed once the bitmask is first observed). Null unused.
  reqSig: Uint32Array | null;
  // A bare-def cache leaves these arrays empty and keeps `spec` false. They are
  // populated only when a spec carries a without/maybe/any term.
  spec: boolean;
  // Required (`with`) defs, in declaration order. `ids`/`stores` mirror these
  // for pure-with paths, so smallest-store iteration and the fast `each` switch
  // keep reading `ids`/`stores`.
  withoutIds: number[];
  maybeIds: number[];
  anyGroups: number[][];
  // Declaration-ordered list of the defs that contribute a value to each tuple
  // (`with` => optional:false, `maybe` => optional:true; without/any excluded).
  // Drives both results-tuple building and each-arg assembly so the yield order
  // is exactly the call order.
  yieldPlan: YieldSlot[];
  // Stores parallel to yieldPlan, resolved during rebuild. A `with` yield store
  // is the matching `stores` entry; a `maybe` yield store may be undefined when
  // its store was never created (then the value is always undefined).
  yieldStores: (ComponentStore<unknown> | undefined)[];
  // Stores parallel to maybeIds (for membership-free optional reads); a never-
  // created maybe store is undefined.
  maybeStores: (ComponentStore<unknown> | undefined)[];
  // Reused scratch buffers (one allocation per cache arity, not per entity) for
  // the generic each / pairs lanes. Sized lazily in rebuild.
  scratch: unknown[];
  pairsScratch: unknown[];
}

type EachFn = (entity: Entity, ...components: unknown[]) => void;

/**
 * A reusable, pre-resolved query handle (see {@link QueryEngine.compile}).
 * `each` is the per-call zero-allocation hot path; `results` is the
 * allocation-stable, read-only tuple array (do not retain across a structural
 * change); `first` / `count` are conveniences.
 */
export interface CompiledQuery<T extends unknown[]> {
  each(fn: (entity: Entity, ...components: T) => void): void;
  results(): readonly QueryResult<T>[];
  first(): QueryResult<T> | null;
  count(): number;
  /**
   * Assert exactly one match and return its tuple; throws (with the actual
   * count) for zero or many. Use for singleton lookups (e.g. the player).
   */
  single(): QueryResult<T>;
  /**
   * Random-access the tuple for `entity` if it currently matches, else null.
   * The returned tuple is a FRESH array; unlike `results()`, it is NOT the
   * cached, allocation-stable reference, so it is safe to retain independently.
   */
  get(entity: Entity): QueryResult<T> | null;
  /**
   * Visit each unordered entity pair (`i < j` over the matched list) exactly
   * once. `fn` receives both entities followed by entity `a`'s component tuple
   * tail; fetch `b`'s components on demand via `get(b)` / direct store access
   * when needed (the broadphase-then-narrowphase pattern). Do NOT re-enter the
   * same compiled query's `each`/`pairs` inside this callback (the per-cache
   * scratch buffer would be clobbered).
   */
  pairs(fn: (a: Entity, b: Entity, ...components: T) => void): void;
}

export class QueryEngine {
  private readonly caches = new Map<string, QueryCache>();
  private readonly world: Queryable;

  constructor(world: Queryable) {
    this.world = world;
  }

  /** Allocation-stable array of `[entity, ...components]` tuples. Read-only. */
  query(defs: ComponentType<unknown>[]): readonly QueryResult<unknown[]>[] {
    return this.resultsOn(this.getCache(defs));
  }

  /** First matching tuple, or null. */
  queryFirst(defs: ComponentType<unknown>[]): QueryResult<unknown[]> | null {
    return this.firstOn(this.getCache(defs));
  }

  /**
   * Zero-(per-entity)-allocation callback form. Iterates the cached entity list
   * and calls `fn` with components fetched straight from the dense stores; no
   * tuple objects are created. Use for the hottest inner loops.
   */
  each(defs: ComponentType<unknown>[], fn: EachFn): void {
    this.eachOn(this.getCache(defs), fn);
  }

  /**
   * Resolve the cache for `defs` once and return a reusable handle. The handle's
   * methods skip the per-call key derivation and variadic unpacking that the
   * `world.query/each(...)` entry points pay, so a compiled handle is the truly
   * per-call zero-allocation path for hot loops.
   */
  compile(defs: ComponentType<unknown>[]): CompiledQuery<unknown[]> {
    return this.handleFor(this.getCache(defs));
  }

  /**
   * Compile a query from a filter {@link QueryArg} spec: bare defs (required
   * `with`), `without(...)` / `maybe(...)` terms, and `any(...)` groups. Returns
   * the same reusable handle shape as {@link compile}, now also exposing
   * `single` / `get` / `pairs`.
   *
   * A spec with NO required (`with`) term throws: driving iteration off the
   * whole alive set would be an O(all-entities) scan and a determinism-order
   * question this API deliberately avoids. When the spec is pure-`with` (no
   * without/maybe/any) it delegates to the same cache as `world.query`/`compile`.
   */
  compileSpec(args: QueryArg[]): CompiledQuery<unknown[]> {
    const { withDefs, withoutIds, maybeIds, anyGroups, yieldPlan } =
      parseQueryArgs(args);

    // Pure-with spec: route back to the same cache used by `world.query(A)`.
    if (
      withoutIds.length === 0 &&
      maybeIds.length === 0 &&
      anyGroups.length === 0
    ) {
      return this.handleFor(this.getCache(withDefs));
    }

    return this.handleFor(
      this.getSpecCache(withDefs, withoutIds, maybeIds, anyGroups, yieldPlan),
    );
  }

  /** Build the reusable handle object shared by `compile` and `compileSpec`. */
  private handleFor(cache: QueryCache): CompiledQuery<unknown[]> {
    return {
      each: (fn) => this.eachOn(cache, fn),
      results: () => this.resultsOn(cache),
      first: () => this.firstOn(cache),
      count: () => this.countOn(cache),
      single: () => this.singleOn(cache),
      get: (entity) => this.getOn(cache, entity),
      pairs: (fn) => this.pairsOn(cache, fn),
    };
  }

  /**
   * Reset every cached query in place (used by World.clear()). The cache objects
   * are kept rather than dropped, so any {@link CompiledQuery} handle holding one
   * stays valid and simply rebuilds on next use.
   */
  clear(): void {
    for (const cache of this.caches.values()) {
      cache.entities.length = 0;
      cache.stores.length = 0;
      cache.results = [];
      cache.entitiesVersion = 0;
      cache.resultsVersion = -1;
      // Drop the dep-version snapshot so the next access sees `depsChanged` and
      // rebuilds (the stores were just cleared). reqSig (a static signature of
      // the required ids) stays valid.
      cache.depVersions.length = 0;
      // Spec caches also hold resolved yield/maybe stores parallel to entities;
      // drop them so a stale store reference can't survive a clear(). Plan/ids
      // and scratch buffers are kept.
      cache.yieldStores.length = 0;
      cache.maybeStores.length = 0;
    }
  }

  /** Drop all cached queries (memory reclaim). Retained handles keep working but rebuild independently. */
  dropCaches(): void {
    this.caches.clear();
  }

  private resultsOn(cache: QueryCache): readonly QueryResult<unknown[]>[] {
    this.refreshResults(cache);
    return cache.results;
  }

  private firstOn(cache: QueryCache): QueryResult<unknown[]> | null {
    const results = this.resultsOn(cache);
    return results.length > 0 ? results[0] : null;
  }

  private countOn(cache: QueryCache): number {
    this.refreshEntities(cache);
    return cache.entities.length;
  }

  private eachOn(cache: QueryCache, fn: EachFn): void {
    this.refreshEntities(cache);
    const ents = cache.entities;
    if (ents.length === 0) return; // no matches -> stores may be short; never read
    const stores = cache.stores;
    // Fast switch only when every yielded slot is a required `with` store
    // (yield arity === withIds length, no maybe terms) and arity <= 6. Any spec
    // with a maybe term or yield arity > 6 falls to the generic scratch lane.
    // The 5/6 cases matter for wide hot queries (e.g. a per-frame 5-component
    // physics/separation pass): they avoid the generic lane's per-entity
    // `fn.apply(undefined, scratch)`, which is markedly slower than a direct call.
    if (cache.yieldPlan.length === cache.ids.length && cache.ids.length <= 6) {
      switch (cache.ids.length) {
        case 1: {
          const s0 = stores[0];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(e, s0.getUnsafe(e));
          }
          break;
        }
        case 2: {
          const s0 = stores[0];
          const s1 = stores[1];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(e, s0.getUnsafe(e), s1.getUnsafe(e));
          }
          break;
        }
        case 3: {
          const s0 = stores[0];
          const s1 = stores[1];
          const s2 = stores[2];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(e, s0.getUnsafe(e), s1.getUnsafe(e), s2.getUnsafe(e));
          }
          break;
        }
        case 4: {
          const s0 = stores[0];
          const s1 = stores[1];
          const s2 = stores[2];
          const s3 = stores[3];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(
              e,
              s0.getUnsafe(e),
              s1.getUnsafe(e),
              s2.getUnsafe(e),
              s3.getUnsafe(e),
            );
          }
          break;
        }
        case 5: {
          const s0 = stores[0];
          const s1 = stores[1];
          const s2 = stores[2];
          const s3 = stores[3];
          const s4 = stores[4];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(
              e,
              s0.getUnsafe(e),
              s1.getUnsafe(e),
              s2.getUnsafe(e),
              s3.getUnsafe(e),
              s4.getUnsafe(e),
            );
          }
          break;
        }
        case 6: {
          const s0 = stores[0];
          const s1 = stores[1];
          const s2 = stores[2];
          const s3 = stores[3];
          const s4 = stores[4];
          const s5 = stores[5];
          for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            fn(
              e,
              s0.getUnsafe(e),
              s1.getUnsafe(e),
              s2.getUnsafe(e),
              s3.getUnsafe(e),
              s4.getUnsafe(e),
              s5.getUnsafe(e),
            );
          }
          break;
        }
      }
      return;
    }
    // Generic scratch lane for 7+ components and maybe-bearing specs.
    // Reuses one per-cache scratch array (sized in resolveSpecStores, or here
    // for a pure-with 5+ cache), so it stays zero-per-entity-allocation. Optional
    // slots fetch via `.get`, required via `.getUnsafe`; a never-created maybe
    // store yields undefined.
    const plan = cache.yieldPlan;
    const arity = plan.length;
    const yieldStores = cache.spec ? cache.yieldStores : stores;
    if (cache.scratch.length !== 1 + arity)
      cache.scratch = new Array(1 + arity);
    const scratch = cache.scratch;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      scratch[0] = e;
      for (let k = 0; k < arity; k++) {
        const s = yieldStores[k];
        scratch[1 + k] =
          s === undefined
            ? undefined
            : plan[k].optional
              ? s.get(e)
              : s.getUnsafe(e);
      }
      fn.apply(undefined, scratch as never);
    }
  }

  private getCache(defs: ComponentType<unknown>[]): QueryCache {
    if (defs.length === 0) {
      throw new Error(
        "a query needs at least one required (non-maybe, non-without) component",
      );
    }
    // Keyed by call-order ids. Two call orders of the same component set get
    // separate caches so the cached tuples stay correct for each order (rather
    // than sharing one cache keyed by sorted ids), preserving the load-bearing
    // contract: allocation-stable, correct-order tuples.
    let key = "";
    const ids: number[] = [];
    for (let i = 0; i < defs.length; i++) {
      const id = defs[i].id;
      ids.push(id);
      key += i === 0 ? id : `,${id}`;
    }
    let cache = this.caches.get(key);
    if (!cache) {
      // A bare-def cache: `spec` false, all filter arrays empty. The yieldPlan
      // mirrors `ids`, so every term is required.
      const yieldPlan: YieldSlot[] = [];
      for (let i = 0; i < ids.length; i++)
        yieldPlan.push({ id: ids[i], optional: false });
      cache = {
        key,
        ids,
        stores: [],
        entities: [],
        results: [],
        entitiesVersion: 0,
        resultsVersion: -1,
        spec: false,
        withoutIds: [],
        maybeIds: [],
        anyGroups: [],
        yieldPlan,
        yieldStores: [],
        maybeStores: [],
        scratch: [],
        pairsScratch: [],
        // A bare-def cache reads only its required stores, so its dep set is `ids`.
        depIds: ids.slice(),
        depVersions: [],
        reqSig: null,
      };
      this.caches.set(key, cache);
    }
    return cache;
  }

  /**
   * Build (or fetch) a filter-spec cache. Keyed by a richer key encoding every
   * term role, so different filters never collide with each other or with
   * bare-def caches (whose key is just `ids.join(",")`). Only reached for specs
   * that carry a without/maybe/any term.
   */
  private getSpecCache(
    withDefs: ComponentType<unknown>[],
    withoutIds: number[],
    maybeIds: number[],
    anyGroups: number[][],
    yieldPlan: YieldSlot[],
  ): QueryCache {
    const ids: number[] = [];
    for (let i = 0; i < withDefs.length; i++) ids.push(withDefs[i].id);
    const key = `${ids.join(",")}|w:${withoutIds.join(",")}|m:${maybeIds.join(
      ",",
    )}|a:${anyGroups.map((g) => g.join(".")).join(";")}`;
    let cache = this.caches.get(key);
    if (!cache) {
      // A spec cache's result depends on every store it reads: the required
      // `with` ids, plus the without / any / maybe stores. Dedupe into depIds so
      // a change to ANY of them (and only them) invalidates the cache.
      const depSet = new Set<number>(ids);
      for (let i = 0; i < withoutIds.length; i++) depSet.add(withoutIds[i]);
      for (let i = 0; i < maybeIds.length; i++) depSet.add(maybeIds[i]);
      for (let g = 0; g < anyGroups.length; g++)
        for (let j = 0; j < anyGroups[g].length; j++)
          depSet.add(anyGroups[g][j]);
      cache = {
        key,
        ids,
        stores: [],
        entities: [],
        results: [],
        entitiesVersion: 0,
        resultsVersion: -1,
        spec: true,
        withoutIds,
        maybeIds,
        anyGroups,
        yieldPlan,
        yieldStores: [],
        maybeStores: [],
        scratch: [],
        pairsScratch: [],
        depIds: [...depSet],
        depVersions: [],
        reqSig: null,
      };
      this.caches.set(key, cache);
    }
    return cache;
  }

  // True if any store this cache depends on has changed (or appeared/vanished)
  // since the last snapshot. An absent store reads as version -1, so a store
  // appearing (or its first add bumping 0→1) is detected. O(depIds), tiny.
  private depsChanged(cache: QueryCache): boolean {
    const { depIds, depVersions } = cache;
    if (depVersions.length !== depIds.length) return true;
    for (let i = 0; i < depIds.length; i++) {
      const s = this.world.storeIfPresent(depIds[i]);
      const v = s === undefined ? -1 : s.version;
      if (v !== depVersions[i]) return true;
    }
    return false;
  }

  // Record the current dep-store versions as the cache's baseline.
  private snapshotDeps(cache: QueryCache): void {
    const { depIds, depVersions } = cache;
    depVersions.length = depIds.length;
    for (let i = 0; i < depIds.length; i++) {
      const s = this.world.storeIfPresent(depIds[i]);
      depVersions[i] = s === undefined ? -1 : s.version;
    }
  }

  private refreshEntities(cache: QueryCache): void {
    // Rebuild only when one of THIS query's own stores changed; a mutation to an
    // unrelated component leaves the cache valid (the key per-store-versioning
    // win). `entitiesVersion` advances as a build epoch on each actual rebuild.
    if (!this.depsChanged(cache)) return;
    this.rebuildEntities(cache);
    this.snapshotDeps(cache);
    cache.entitiesVersion++;
  }

  private refreshResults(cache: QueryCache): void {
    this.refreshEntities(cache);
    // Tuples are current iff they were built at the latest entities epoch.
    if (cache.resultsVersion === cache.entitiesVersion) return;

    const { entities, stores, ids } = cache;
    const results: QueryResult<unknown[]>[] = new Array(entities.length);
    if (!cache.spec) {
      // Pure-with path: every yielded slot is a required component.
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const tuple: QueryResult<unknown[]> = [entity];
        for (let j = 0; j < ids.length; j++) {
          tuple.push(stores[j].getUnsafe(entity));
        }
        results[i] = tuple;
      }
    } else {
      // Spec path: yields follow declaration order via the yieldPlan, fetching
      // optional slots with `get` (=> value or undefined) and required slots
      // with `getUnsafe`. yieldStores were resolved alongside entities.
      const { yieldPlan, yieldStores } = cache;
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const tuple: QueryResult<unknown[]> = [entity];
        for (let j = 0; j < yieldPlan.length; j++) {
          const s = yieldStores[j];
          if (s === undefined) {
            tuple.push(undefined);
          } else if (yieldPlan[j].optional) {
            tuple.push(s.get(entity));
          } else {
            tuple.push(s.getUnsafe(entity));
          }
        }
        results[i] = tuple;
      }
    }
    // New array reference on every rebuild; callers that retained an old array
    // across a structural change observe the swap.
    cache.results = results;
    cache.resultsVersion = cache.entitiesVersion;
  }

  private rebuildEntities(cache: QueryCache): void {
    const { ids, stores, entities } = cache;
    entities.length = 0;
    stores.length = 0;
    // Reset spec-resolved stores too, so the early-return-on-empty path below
    // leaves a single well-defined "no match" state (never stale arrays).
    cache.yieldStores.length = 0;
    cache.maybeStores.length = 0;

    // Resolve current stores in call order. Pick the smallest to iterate; bail
    // (leaving `entities` empty, `stores` short) if any store is absent or empty:
    // no matches are possible.
    let smallest = -1;
    let smallestSize = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const s = this.world.storeIfPresent(ids[i]);
      if (s === undefined || s.size() === 0) return;
      stores.push(s);
      if (s.size() < smallestSize) {
        smallestSize = s.size();
        smallest = i;
      }
    }

    // Filter specs need the without/maybe/any stores resolved before iterating;
    // resolve them, then narrow the smallest required store with the same per-
    // entity predicate. Pure-with caches keep the required-store check below.
    if (cache.spec) {
      this.resolveSpecStores(cache);
    }

    // Bitmask-accelerated required-membership check (opt-in via enableBitmask):
    // one signature AND replaces the per-store has() probe loop. Same result set
    // and same iteration order; only the inner check changes. Gated on >= 4
    // required components: a measured crossover, below which the has() loop (1–2
    // probes) beats the signature AND's per-word overhead. Null bitmask, or a
    // low-arity query, falls to the sparse-store `has()` loop. The signature is
    // static per cache and computed once observed.
    let sig: Uint32Array | null = null;
    const bm = ids.length >= 4 ? this.world.bitmask() : null;
    if (bm !== null) {
      if (cache.reqSig === null) cache.reqSig = bm.signature(ids);
      sig = cache.reqSig;
    }

    const smallestEntities = stores[smallest].iterEntities();
    for (let e = 0; e < smallestEntities.length; e++) {
      const entity = smallestEntities[e];
      if (!this.world.isAlive(entity)) continue;
      if (bm !== null && sig !== null) {
        if (!bm.hasAll(entity as number, sig)) continue;
      } else {
        let hasAll = true;
        for (let i = 0; i < stores.length; i++) {
          if (i === smallest) continue;
          if (!stores[i].has(entity)) {
            hasAll = false;
            break;
          }
        }
        if (!hasAll) continue;
      }
      // Apply the filter predicate only for spec caches.
      if (cache.spec && !this.filterMatches(cache, entity)) continue;
      entities.push(entity);
    }
  }

  /**
   * Resolve the `maybe`/`yield` stores for a spec cache (the without/any stores
   * are resolved on the fly by `filterMatches`, which closes over `this.world`).
   * Also sizes the per-cache scratch buffers once.
   */
  private resolveSpecStores(cache: QueryCache): void {
    const { maybeIds, maybeStores, yieldPlan, yieldStores } = cache;
    maybeStores.length = 0;
    for (let i = 0; i < maybeIds.length; i++)
      maybeStores.push(this.world.storeIfPresent(maybeIds[i]));
    // yieldStores parallels yieldPlan: a required slot's store is the resolved
    // `stores` entry at its `with` position; an optional slot's store is the
    // maybe store (which may be undefined when never created => value undefined).
    yieldStores.length = 0;
    let withCursor = 0;
    let maybeCursor = 0;
    for (let i = 0; i < yieldPlan.length; i++) {
      if (yieldPlan[i].optional) {
        yieldStores.push(maybeStores[maybeCursor++]);
      } else {
        yieldStores.push(cache.stores[withCursor++]);
      }
    }
    // Size the reused scratch buffers once (one allocation per cache arity).
    const arity = yieldPlan.length;
    if (cache.scratch.length !== 1 + arity)
      cache.scratch = new Array(1 + arity);
    if (cache.pairsScratch.length !== 2 + arity)
      cache.pairsScratch = new Array(2 + arity);
  }

  /**
   * The per-entity filter predicate shared by rebuild and `get`: NO withoutId's
   * store has the entity, and EVERY anyGroup has at least one member store with
   * it. (Required `with` membership is enforced separately, by the smallest-
   * store iteration in rebuild and by an explicit check in `get`.) `maybe` terms
   * impose no constraint.
   */
  private filterMatches(cache: QueryCache, entity: Entity): boolean {
    const { withoutIds, anyGroups } = cache;
    for (let i = 0; i < withoutIds.length; i++) {
      const s = this.world.storeIfPresent(withoutIds[i]);
      if (s?.has(entity)) return false;
    }
    for (let g = 0; g < anyGroups.length; g++) {
      const group = anyGroups[g];
      let satisfied = false;
      for (let j = 0; j < group.length; j++) {
        const s = this.world.storeIfPresent(group[j]);
        if (s?.has(entity)) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) return false;
    }
    return true;
  }

  private singleOn(cache: QueryCache): QueryResult<unknown[]> {
    this.refreshEntities(cache);
    const n = cache.entities.length;
    if (n !== 1) {
      throw new Error(`Query.single(): expected exactly one match, got ${n}`);
    }
    return this.resultsOn(cache)[0];
  }

  private getOn(
    cache: QueryCache,
    entity: Entity,
  ): QueryResult<unknown[]> | null {
    this.refreshEntities(cache);
    if (!this.world.isAlive(entity)) return null;
    // Membership: all required stores have it, then the filter predicate. When
    // entities is empty the stores array is short; re-resolve required stores
    // from ids so a hit on an otherwise-empty smallest store still works.
    const { ids } = cache;
    for (let i = 0; i < ids.length; i++) {
      const s = this.world.storeIfPresent(ids[i]);
      if (s === undefined || !s.has(entity)) return null;
    }
    if (cache.spec && !this.filterMatches(cache, entity)) return null;
    // Build a FRESH tuple (not the cached results reference, documented).
    return this.buildTuple(cache, entity);
  }

  private pairsOn(
    cache: QueryCache,
    fn: (a: Entity, b: Entity, ...components: unknown[]) => void,
  ): void {
    this.refreshEntities(cache);
    const ents = cache.entities;
    const n = ents.length;
    if (n < 2) return;
    const arity = cache.spec ? cache.yieldPlan.length : cache.ids.length;
    // A pure-with cache also reaches here; resolve its yield buffers from
    // `stores`/`ids` so the scratch lane works without spec fields.
    if (cache.pairsScratch.length !== 2 + arity)
      cache.pairsScratch = new Array(2 + arity);
    const scratch = cache.pairsScratch;
    const stores = cache.spec ? cache.yieldStores : cache.stores;
    const plan = cache.yieldPlan;
    for (let i = 0; i < n; i++) {
      const a = ents[i];
      // Fill a's component tail once per `i`.
      for (let k = 0; k < arity; k++) {
        const s = stores[k];
        scratch[2 + k] =
          s === undefined
            ? undefined
            : plan[k].optional
              ? s.get(a)
              : s.getUnsafe(a);
      }
      scratch[0] = a;
      for (let j = i + 1; j < n; j++) {
        scratch[1] = ents[j];
        fn.apply(undefined, scratch as never);
      }
    }
  }

  /** Build one `[entity, ...yields]` tuple via the yieldPlan (fresh array). */
  private buildTuple(
    cache: QueryCache,
    entity: Entity,
  ): QueryResult<unknown[]> {
    const tuple: QueryResult<unknown[]> = [entity];
    if (!cache.spec) {
      for (let j = 0; j < cache.ids.length; j++) {
        const s = this.world.storeIfPresent(cache.ids[j]);
        // Required, guaranteed present (callers verify membership first).
        tuple.push(s === undefined ? undefined : s.getUnsafe(entity));
      }
      return tuple;
    }
    const { yieldPlan } = cache;
    for (let j = 0; j < yieldPlan.length; j++) {
      const slot = yieldPlan[j];
      const s = this.world.storeIfPresent(slot.id);
      if (s === undefined) {
        tuple.push(undefined);
      } else if (slot.optional) {
        tuple.push(s.get(entity));
      } else {
        tuple.push(s.getUnsafe(entity));
      }
    }
    return tuple;
  }
}
