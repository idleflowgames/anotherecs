import { Bitmask } from "./bitmask";
import type { CommandBuffer } from "./command-buffer";
import { EventBus } from "./events";
import { IncrementalQuery } from "./incremental-query";
import { type CompiledQuery, parseQueryArgs, QueryEngine } from "./query";
import { ComponentStore, DEFAULT_MAX_ENTITIES } from "./store";
import {
  type AnyComponentType,
  type ComponentType,
  type Entity,
  type EntityHandle,
  type EntityId,
  type EntityRef,
  type LocalType,
  NULL_REF,
  type PooledComponentType,
  type QueryArg,
  type QueryResult,
  type ResourceType,
  TAG_VALUE,
  type TagType,
} from "./types";

export class World {
  private nextId = 1; // 0 is reserved as "no entity"
  private readonly maxEntities: number;
  private readonly alive = new Set<EntityId>();
  private readonly recycled: EntityId[] = [];
  private readonly pendingDespawns: EntityId[] = [];
  // Bumped only when a despawn is applied in flush(); read by handleOf/resolve
  // to detect a handle held across a despawn and recycled id.
  private readonly generations: Uint32Array;
  private readonly indexBits: number; // ceil(log2(maxEntities)), >=1
  private readonly indexMask: number; // (2 ** indexBits) - 1
  // EntityRef reuses the exact (index, generation) packing as EntityHandle. The
  // reverse index is allocated only after enableBackrefs().
  private backrefsEnabled = false;
  // target index -> holder entities, in insertion order, de-duplicated.
  private backrefEdges: Map<number, Entity[]> | null = null;
  // holder index -> target indices it points at, so a despawned holder is swept
  // from every target's edge list during flush(). Allocated by enableBackrefs().
  private holderToTargets: Map<number, Set<number>> | null = null;
  // Indexed by component id (dense, from the module-level counter), plus a
  // compact list of created stores for flush/clear iteration. Array indexing is
  // ~2.5x faster than Map.get on the per-access hot path (get/has/add), with
  // identical semantics and iteration order.
  private readonly stores: (ComponentStore<unknown> | undefined)[] = [];
  private readonly activeStores: ComponentStore<unknown>[] = [];
  // A compact list of the stores opted into tracking, so clearChanges() touches
  // only opted-in stores. The callback maps stay null until onAdded/onRemoved is
  // used, so flush() checks one `!== null` branch.
  private readonly trackedStores: ComponentStore<unknown>[] = [];
  private addedCallbacks: Map<number, ((e: Entity) => void)[]> | null = null;
  private removedCallbacks: Map<number, ((e: Entity) => void)[]> | null = null;
  private readonly resources = new Map<number, unknown>();
  // String-keyed resources: an alternative to typed tokens (e.g. for quick
  // experimenting or porting a string-keyed resource map).
  private readonly stringResources = new Map<string, unknown>();
  // Per-system local scratch state, keyed by LocalType id. Lazily built on
  // first local() access; independent of resources.
  private readonly locals = new Map<number, unknown>();
  readonly events = new EventBus();
  private readonly queryEngine: QueryEngine;
  private _version = 0;
  // A derived per-entity component-signature mirror, built by enableBitmask()
  // and kept in sync on every World-API membership change. Stays null until
  // opted in. Signatures for hasAllMask are cached by def-id-list key.
  private bitmask: Bitmask | null = null;
  private readonly maskSigs = new Map<string, Uint32Array>();
  // Queries whose match set is maintained on add/remove instead of rebuilt on the
  // next access. `incrementalByComponent[id]` is the list to reconcile when
  // component `id` changes for an entity; `incrementalQueries` is the flat list
  // for flush/clear. `hasIncremental` gates mutation hooks to a single boolean
  // check when no incremental query is registered.
  private hasIncremental = false;
  private readonly incrementalByComponent: (IncrementalQuery[] | undefined)[] =
    [];
  private readonly incrementalQueries: IncrementalQuery[] = [];

  /**
   * Called inside flush() for each entity actually removed, before its
   * components are stripped (so the callback can still read them). Defaults to
   * null; set it to e.g. tear down a sprite or other external resource.
   */
  onBeforeDestroy: ((entity: Entity) => void) | null = null;

  /** Monotonic version, bumped on component add/remove and applied despawns. */
  get version(): number {
    return this._version;
  }

  /**
   * @param options.maxEntities  Per-store sparse-array capacity and the spawn
   *   ceiling. Defaults to {@link DEFAULT_MAX_ENTITIES} (65536). Raise it for a
   *   world that can hold more live entities at once.
   */
  constructor(options?: { maxEntities?: number }) {
    this.maxEntities = options?.maxEntities ?? DEFAULT_MAX_ENTITIES;
    this.indexBits = Math.max(1, Math.ceil(Math.log2(this.maxEntities)));
    this.indexMask = 2 ** this.indexBits - 1;
    // Handle/ref pack gen (u32) into the high bits above indexBits, so the packed
    // value stays a safe integer only while indexBits + 32 <= 53.
    if (this.indexBits + 32 > 53) {
      throw new Error(
        `World: maxEntities ${this.maxEntities} too large; entity handles need ` +
          `maxEntities <= 2^21 (2097152) to stay safe integers.`,
      );
    }
    // Zero-filled generation per index (every fresh index is gen 0).
    this.generations = new Uint32Array(this.maxEntities);

    this.queryEngine = new QueryEngine({
      isAlive: (entity) => this.alive.has(entity),
      storeIfPresent: (id) => this.stores[id],
      // The per-entity component bitmask, when enabled, lets rebuildEntities
      // replace its per-store has() probe with one signature AND.
      bitmask: () => this.bitmask,
    });
  }
  /** Create a new entity immediately. Returns its id. */
  spawn(): EntityId {
    const id =
      this.recycled.length > 0
        ? (this.recycled.pop() as EntityId)
        : (this.nextId++ as EntityId);
    if ((id as number) >= this.maxEntities) {
      throw new Error(
        `World.spawn(): entity id ${id} exceeds maxEntities (${this.maxEntities}). ` +
          `Component sparse arrays cannot index this id. Construct the World with ` +
          `a larger { maxEntities } or audit for an entity leak.`,
      );
    }
    this.alive.add(id);
    return id;
  }

  /** Queue entity for removal. Applied on flush(). */
  despawn(id: EntityId): void {
    this.pendingDespawns.push(id);
  }

  /** Whether entity is currently alive. */
  isAlive(id: EntityId): boolean {
    return this.alive.has(id);
  }

  /** Number of alive entities. */
  get entityCount(): number {
    return this.alive.size;
  }

  /**
   * Apply deferred despawns. Called between system groups by the Schedule.
   * Removes all components from despawned entities and recycles their ids.
   */
  flush(): void {
    if (this.pendingDespawns.length > 0) {
      for (const id of this.pendingDespawns) {
        if (!this.alive.delete(id)) continue;
        if (this.onBeforeDestroy) this.onBeforeDestroy(id);
        for (const store of this.activeStores) {
          store.remove(id);
        }
        this._version++;
        // Bump the index's generation so any handle stamped at the old generation
        // fails to resolve, even once this index is recycled and reused. >>> 0
        // keeps it an explicit unsigned 32-bit value (Uint32Array wraps on store).
        this.generations[id as number] =
          (this.generations[id as number] + 1) >>> 0;
        this.recycled.push(id);
        // Drop the entity's whole signature row in one call (store removes above
        // already settled membership).
        if (this.bitmask) this.bitmask.clearEntity(id as number);
        // Sweep the despawned target's reverse-index edge: the "who points at me"
        // list for a now-dead target is meaningless. Holders are not deleted
        // and no holder component scan, so this introduces zero new entity
        // removals and cannot shift any store's swap-delete order.
        if (this.backrefsEnabled && this.backrefEdges !== null) {
          this.backrefEdges.delete(id as number);
          // Sweep this id where it was a HOLDER: drop it from every target's
          // edge list, so a despawned holder's edges don't linger.
          const targets = this.holderToTargets?.get(id as number);
          if (targets !== undefined) {
            for (const t of targets) {
              const holders = this.backrefEdges.get(t);
              if (holders !== undefined) {
                const at = holders.indexOf(id as Entity);
                if (at !== -1) {
                  holders.splice(at, 1);
                  if (holders.length === 0) this.backrefEdges.delete(t);
                }
              }
            }
            this.holderToTargets?.delete(id as number);
          }
        }
        // Drop the now-dead entity from any incremental query it is in. The
        // entity was alive.delete()'d and stripped from its stores above, so
        // reconcile() sees no match and swap-deletes it.
        if (this.hasIncremental) {
          for (let q = 0; q < this.incrementalQueries.length; q++) {
            this.incrementalQueries[q].reconcile(id as number);
          }
        }
      }
      this.pendingDespawns.length = 0;
    }
    // Change-tracking callbacks fire at one deterministic point, AFTER the
    // despawn loop fully settles (so callbacks observe a fully-applied frame).
    // Both maps are null until onAdded/onRemoved is used.
    if (this.addedCallbacks !== null)
      this.fireCallbacks(this.addedCallbacks, true);
    if (this.removedCallbacks !== null) {
      this.fireCallbacks(this.removedCallbacks, false);
    }
  }
  /** Get (or lazily create) the store for a component type. */
  store<T>(type: ComponentType<T>): ComponentStore<T> {
    let s = this.stores[type.id];
    if (s === undefined) {
      s = new ComponentStore<unknown>(this.maxEntities);
      this.stores[type.id] = s;
      this.activeStores.push(s);
    }
    return s as ComponentStore<T>;
  }

  /**
   * Add a component to an entity (direct style: the passed object is stored
   * as-is). Bumps the version unconditionally: unlike addComponent's in-place
   * merge, `add` *replaces* the stored object, so any cached query tuple holding
   * the old reference must be invalidated.
   */
  add(id: EntityId, type: TagType, data?: never): void;
  add<T>(id: EntityId, type: ComponentType<T>, data: T): void;
  add<T>(id: EntityId, type: ComponentType<T>, data: T): void {
    this.store(type).set(id, data);
    this._version++;
    if (this.bitmask) this.bitmask.set(id as number, type.id);
    if (this.hasIncremental) this.reconcileIncremental(type.id, id as number);
  }

  /** Remove a component from an entity. */
  remove<T>(id: EntityId, type: ComponentType<T>): void {
    const removed = this.stores[type.id]?.remove(id);
    if (removed) {
      this._version++;
      if (this.bitmask) this.bitmask.clear(id as number, type.id);
      if (this.hasIncremental) this.reconcileIncremental(type.id, id as number);
    }
  }

  /** Get a component. Returns undefined if not present. */
  get<T>(id: EntityId, type: ComponentType<T>): T | undefined {
    return this.store(type).get(id);
  }

  /** Get a component without bounds check. Caller must ensure entity has it. */
  getUnsafe<T>(id: EntityId, type: ComponentType<T>): T {
    return this.store(type).getUnsafe(id);
  }

  /** Whether entity has a component. */
  has<T>(id: EntityId, type: ComponentType<T>): boolean {
    return this.store(type).has(id);
  }

  /**
   * Get the first entry of a component store (e.g. a player singleton). Throws if
   * empty. Does NOT assert uniqueness; use {@link CompiledQuery.single} for that.
   */
  getFirst<T>(type: ComponentType<T>): T {
    const data = this.store(type).iterData();
    if (data.length === 0) {
      throw new Error(`Component "${type.name}" has no entries`);
    }
    return data[0];
  }
  /**
   * Add a factory component ({@link PooledComponentType}). If the entity
   * already has the component, the existing instance is reused; otherwise
   * a pooled object is reused if available, else a fresh one is built via the
   * factory. `data` (a partial) is then merged onto the instance. (Components
   * without a factory are added with {@link add}.)
   */
  addComponent<T extends object>(
    entity: Entity,
    def: PooledComponentType<T>,
    data?: Partial<T>,
  ): T {
    const store = this.store(def);
    let component = store.get(entity);
    if (component === undefined) {
      component = store.acquire() ?? def.create();
      store.set(entity, component);
      this._version++;
      if (this.bitmask) this.bitmask.set(entity as number, def.id);
      if (this.hasIncremental)
        this.reconcileIncremental(def.id, entity as number);
      if (data) Object.assign(component, data);
    } else if (data) {
      Object.assign(component, data);
      store.markChanged(entity);
    }
    return component;
  }

  /** Alias of get(): component or undefined. */
  getComponent<T>(entity: Entity, def: ComponentType<T>): T | undefined {
    return this.store(def).get(entity);
  }

  /** Alias of has(). */
  hasComponent<T>(entity: Entity, def: ComponentType<T>): boolean {
    return this.store(def).has(entity);
  }

  /** Remove a component. Bumps version when one was actually removed. */
  removeComponent<T>(entity: Entity, def: ComponentType<T>): void {
    if (this.stores[def.id]?.remove(entity)) {
      this._version++;
      if (this.bitmask) this.bitmask.clear(entity as number, def.id);
      if (this.hasIncremental)
        this.reconcileIncremental(def.id, entity as number);
    }
  }

  /** Get a component, throwing if missing. */
  getOrThrow<T>(entity: Entity, def: ComponentType<T>): T {
    const c = this.store(def).get(entity);
    if (c === undefined) {
      throw new Error(`Entity ${entity} missing component ${def.name}`);
    }
    return c;
  }
  /**
   * Add a tag to an entity. Equivalent to `add(entity, tag, true)` but takes no
   * data argument; the store value is the shared {@link TAG_VALUE}, so no data
   * object is allocated. Membership-gated version bump: bumps only when the tag
   * is newly added (matches addComponent's "bump only when newly added"
   * semantics; a tag has no object to replace, so re-adds are idempotent).
   */
  addTag(entity: Entity, tag: TagType): void {
    const store = this.store(tag);
    if (!store.has(entity)) {
      store.set(entity, TAG_VALUE);
      this._version++;
      if (this.bitmask) this.bitmask.set(entity as number, tag.id);
    }
  }

  /** Whether an entity has a tag. Alias of `has(entity, tag)`. */
  hasTag(entity: Entity, tag: TagType): boolean {
    return this.store(tag).has(entity);
  }

  /** Remove a tag. Bumps version only when one was actually removed. */
  removeTag(entity: Entity, tag: TagType): void {
    if (this.stores[tag.id]?.remove(entity)) {
      this._version++;
      if (this.bitmask) this.bitmask.clear(entity as number, tag.id);
    }
  }
  /**
   * Enable a per-entity component bitmask index for this world. Builds a
   * {@link Bitmask} sized to `maxEntities` and back-fills it from every existing
   * store, then keeps it in sync on every subsequent add/remove/despawn.
   * Idempotent. Pays nothing until called. Returns the world for chaining.
   *
   * Contract: the index mirrors only mutations made through the World API
   * (add/remove/addComponent/removeComponent/addTag/removeTag/despawn+flush). A
   * caller that pokes a raw store via `getStoreRaw`/`store(...).set(...)` bypasses
   * it, exactly like the query version counter; `hasMask` would then drift for
   * that entity. Use the World API for any entity you also query via the mask.
   */
  enableBitmask(): this {
    if (this.bitmask) return this;
    const bm = new Bitmask(this.maxEntities);
    // Back-fill from every existing store, in store-id order. Index `id` IS the
    // component id, and bit-set is idempotent, so the result is independent of
    // traversal order.
    for (let id = 0; id < this.stores.length; id++) {
      const s = this.stores[id];
      if (s === undefined) continue;
      const ents = s.iterEntities();
      for (let i = 0; i < ents.length; i++) bm.set(ents[i] as number, id);
    }
    this.bitmask = bm;
    return this;
  }

  /** Whether the bitmask index is enabled. */
  isBitmaskEnabled(): boolean {
    return this.bitmask !== null;
  }

  /**
   * O(1) membership test through the bitmask (requires {@link enableBitmask}).
   * Throws if the index is disabled. Semantically identical to `has`, but a
   * single word-and-test instead of a sparse lookup.
   */
  hasMask<T>(entity: Entity, def: ComponentType<T>): boolean {
    if (!this.bitmask) throw new Error("hasMask requires enableBitmask()");
    return this.bitmask.has(entity as number, def.id);
  }

  /**
   * O(words) "has ALL of these components" test through the bitmask (requires
   * {@link enableBitmask}). `defs` is hashed into a reusable query signature on
   * first use and cached by the def-id list. Throws if disabled.
   */
  hasAllMask(entity: Entity, defs: readonly ComponentType<unknown>[]): boolean {
    if (!this.bitmask) throw new Error("hasAllMask requires enableBitmask()");
    let key = "";
    const ids: number[] = [];
    for (let i = 0; i < defs.length; i++) {
      const id = defs[i].id;
      ids.push(id);
      key += i === 0 ? id : `,${id}`;
    }
    let sig = this.maskSigs.get(key);
    if (!sig) {
      sig = this.bitmask.signature(ids);
      this.maskSigs.set(key, sig);
    }
    return this.bitmask.hasAll(entity as number, sig);
  }
  /**
   * Compile an INCREMENTAL query. Accepts the same spec as {@link select}: bare
   * defs (required `with`), `without(...)` / `maybe(...)` terms, and `any(...)`
   * groups. Unlike `compileQuery`/`select`, its match set is MAINTAINED as
   * components are added/removed (and on despawn) rather than rebuilt on the next
   * access, eliminating the per-frame O(n) rebuild a system pays when it mutates
   * and then queries the same components every frame. Returns an
   * {@link IncrementalQuery} handle (`each` / `results` / `count` / `view`).
   *
   * Deliberately opt-in, for hot mutate-then-query systems:
   *  - its iteration ORDER is the incremental "append-on-match /
   *    swap-delete-on-unmatch" order, which is deterministic but different from
   *    `query`/`compileQuery`/`select`;
   *  - it allocates a per-query sparse index sized to `maxEntities` and adds a
   *    reconcile to each membership-component add/remove (so it earns its keep
   *    on a hot query, not on every query);
   *  - it tracks only World-API mutations; a `getStoreRaw` write bypasses it,
   *    like the bitmask.
   * Components present before this call are captured by a one-time initial scan.
   */
  compileIncremental(...args: QueryArg[]): IncrementalQuery {
    const { withIds, withoutIds, maybeIds, anyGroups, yieldPlan } =
      parseQueryArgs(args);
    const q = new IncrementalQuery(
      {
        isAlive: (e) => this.alive.has(e),
        storeIfPresent: (id) => this.stores[id],
      },
      this.maxEntities,
      withIds,
      withoutIds,
      maybeIds,
      anyGroups,
      yieldPlan,
    );
    q.rebuildFromStores();
    this.incrementalQueries.push(q);
    // Register only under membership components (with ∪ without ∪ any); a `maybe`
    // change never alters membership, so it must not trigger a reconcile.
    for (let i = 0; i < q.membershipDeps.length; i++) {
      const id = q.membershipDeps[i];
      let list = this.incrementalByComponent[id];
      if (list === undefined) {
        list = [];
        this.incrementalByComponent[id] = list;
      }
      list.push(q);
    }
    this.hasIncremental = true;
    return q;
  }

  private reconcileIncremental(componentId: number, entity: number): void {
    const qs = this.incrementalByComponent[componentId];
    if (qs === undefined) return;
    for (let i = 0; i < qs.length; i++) qs[i].reconcile(entity);
  }
  query<A>(a: ComponentType<A>): readonly QueryResult<[A]>[];
  query<A, B>(
    a: ComponentType<A>,
    b: ComponentType<B>,
  ): readonly QueryResult<[A, B]>[];
  query<A, B, C>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
  ): readonly QueryResult<[A, B, C]>[];
  query<A, B, C, D>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
    d: ComponentType<D>,
  ): readonly QueryResult<[A, B, C, D]>[];
  // 5+ components: the runtime is already variadic; this overload lifts the
  // type-level 4-cap (per-slot inference stops at 4, falling back to unknown[]).
  // `AnyComponentType` (not `unknown`) so specific component types flow in
  // without a cast; same variance reason as QueryArg (see types.ts).
  query(...defs: AnyComponentType[]): readonly QueryResult<unknown[]>[];
  query(...defs: ComponentType<unknown>[]): readonly QueryResult<unknown[]>[] {
    return this.queryEngine.query(defs);
  }

  queryFirst<A>(a: ComponentType<A>): QueryResult<[A]> | null {
    const results = this.query(a);
    return results.length > 0 ? results[0] : null;
  }

  each<A>(a: ComponentType<A>, fn: (e: Entity, a: A) => void): void;
  each<A, B>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    fn: (e: Entity, a: A, b: B) => void,
  ): void;
  each<A, B, C>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
    fn: (e: Entity, a: A, b: B, c: C) => void,
  ): void;
  each<A, B, C, D>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
    d: ComponentType<D>,
    fn: (e: Entity, a: A, b: B, c: C, d: D) => void,
  ): void;
  // 5+ components: lifts the type-level 4-cap. The trailing arg is the callback;
  // the leading args are component defs (no per-slot inference beyond 4).
  // `AnyComponentType` for the variance reason documented on QueryArg.
  each(
    ...args: [
      ...defs: AnyComponentType[],
      fn: (e: Entity, ...c: never[]) => void,
    ]
  ): void;
  each(...args: unknown[]): void {
    const fn = args[args.length - 1] as (e: Entity, ...c: unknown[]) => void;
    const defs = args.slice(0, -1) as ComponentType<unknown>[];
    this.queryEngine.each(defs, fn);
  }

  /**
   * Resolve a query once and return a reusable handle. Prefer this over
   * `query`/`each` in per-frame hot loops: the handle skips the key derivation
   * and argument unpacking those entry points pay on every call. The handle
   * stays valid across structural changes and across `clear()`.
   */
  compileQuery<A>(a: ComponentType<A>): CompiledQuery<[A]>;
  compileQuery<A, B>(
    a: ComponentType<A>,
    b: ComponentType<B>,
  ): CompiledQuery<[A, B]>;
  compileQuery<A, B, C>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
  ): CompiledQuery<[A, B, C]>;
  compileQuery<A, B, C, D>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
    d: ComponentType<D>,
  ): CompiledQuery<[A, B, C, D]>;
  // 5+ components: lifts the type-level 4-cap (tuple falls back to unknown[]).
  // `AnyComponentType` for the variance reason documented on QueryArg.
  compileQuery(...defs: AnyComponentType[]): CompiledQuery<unknown[]>;
  compileQuery(...defs: ComponentType<unknown>[]): CompiledQuery<unknown[]> {
    return this.queryEngine.compile(defs);
  }

  /**
   * The filter-aware query entry point. Returns a reusable {@link CompiledQuery}
   * handle, like {@link compileQuery}, but accepts `without(...)` / `maybe(...)`
   * terms and `any(...)` groups alongside bare required defs, and lifts the
   * type-level 4-cap. A spec with no required (bare/`with`) component throws.
   *
   * A pure-`with` `select(...)` delegates to the same cache as
   * `query`/`compileQuery`, so the result reference is identical.
   */
  select<A>(a: ComponentType<A>): CompiledQuery<[A]>;
  select<A, B>(a: ComponentType<A>, b: ComponentType<B>): CompiledQuery<[A, B]>;
  select<A, B, C>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
  ): CompiledQuery<[A, B, C]>;
  select<A, B, C, D>(
    a: ComponentType<A>,
    b: ComponentType<B>,
    c: ComponentType<C>,
    d: ComponentType<D>,
  ): CompiledQuery<[A, B, C, D]>;
  select(...args: QueryArg[]): CompiledQuery<unknown[]>;
  select(...args: QueryArg[]): CompiledQuery<unknown[]> {
    return this.queryEngine.compileSpec(args);
  }

  /** O(1) count of entities with a component. */
  count<T>(def: ComponentType<T>): number {
    return this.stores[def.id]?.size() ?? 0;
  }

  /** Drop all cached queries (memory reclaim). Retained handles keep working but rebuild independently. */
  clearQueryCache(): void {
    this.queryEngine.dropCaches();
    this.maskSigs.clear();
  }

  /**
   * Direct dense-store access for the rare hand-tuned loop. A raw `set`/`remove`
   * through it bypasses the bitmask and incremental-query indexes (maintained only
   * by the World mutators), so `hasMask` and incremental queries can drift for an
   * entity mutated this way. The version-gated query cache and change-tracking
   * (which live in the store) stay correct.
   */
  getStoreRaw<T>(def: ComponentType<T>): ComponentStore<T> {
    return this.store(def);
  }
  /**
   * Enable object pooling for a component's store. On despawn/remove the object
   * is reset and parked; the next addComponent reuses it. Only factory
   * components ({@link PooledComponentType}) can be pooled; the `reset` hook is
   * guaranteed by the type.
   */
  enablePooling<T>(def: PooledComponentType<T>): void {
    this.store(def).enablePooling(def.reset);
  }
  /**
   * Apply a {@link CommandBuffer}'s queued add/remove/addComponent/despawn ops
   * against this world, in record order, then clear the buffer. Delegates to the
   * same `add`/`remove`/`addComponent`/`despawn` methods, so version bumps,
   * pooling, and deferred-despawn timing are identical to immediate calls. Does
   * NOT call flush(): a queued despawn is applied as a deferred despawn (visible
   * on the next flush()), preserving despawn timing exactly.
   */
  applyCommands(buffer: CommandBuffer): void {
    buffer.flushInto(this);
  }
  /**
   * Opt a component type into added/removed/changed tracking. Idempotent.
   * A type never passed here records nothing. Tracking does NOT retroactively
   * record existing members, only post-enable transitions.
   */
  trackChanges<T>(def: ComponentType<T>): void {
    const s = this.store(def);
    if (!s.isTracking()) {
      s.enableTracking();
      this.trackedStores.push(s as ComponentStore<unknown>);
    }
  }

  /** Entities that gained `def` since the last clearChanges(), in dense order. */
  added<T>(def: ComponentType<T>): readonly Entity[] {
    return (
      (this.stores[def.id]?.iterAdded() as readonly Entity[] | undefined) ??
      _emptyEntities
    );
  }

  /** Entities that lost `def` since the last clearChanges(), in dense order. */
  removed<T>(def: ComponentType<T>): readonly Entity[] {
    return (
      (this.stores[def.id]?.iterRemoved() as readonly Entity[] | undefined) ??
      _emptyEntities
    );
  }

  /** Entities marked changed since the last clearChanges(), in dense order. */
  changed<T>(def: ComponentType<T>): readonly Entity[] {
    return (
      (this.stores[def.id]?.iterChanged() as readonly Entity[] | undefined) ??
      _emptyEntities
    );
  }

  /**
   * Record an explicit mutation of an existing component. No-op when untracked
   * or absent. Coarse: no dedup; calling it twice on the same entity records
   * two entries. Consumers needing a unique set must dedup themselves.
   */
  markChanged<T>(entity: Entity, def: ComponentType<T>): void {
    this.stores[def.id]?.markChanged(entity);
  }

  /**
   * Get a component and, if its store is tracked & the entity has it, record it
   * changed. Returns the live stored object (mutate it in place) or undefined if
   * absent. The ergonomic read-then-mark path for tracked mutable components.
   */
  getMut<T>(entity: Entity, def: ComponentType<T>): T | undefined {
    const s = this.stores[def.id] as ComponentStore<T> | undefined;
    if (s === undefined) return undefined;
    const c = s.get(entity);
    if (c !== undefined) s.markChanged(entity);
    return c;
  }

  /**
   * Drain all tracked stores' added/removed/changed lists. Call once per frame,
   * like events.clearAll(). Callbacks do NOT auto-drain, so this stays the
   * primary lifecycle hook; skipping it lets the delta lists grow unbounded.
   */
  clearChanges(): void {
    for (const s of this.trackedStores) s.drainChanges();
  }

  /**
   * Fire `fn(e)` for each entity that gained `def`, at one deterministic point
   * inside flush() (after structural changes settle). Auto-enables tracking for
   * `def`. Does NOT auto-drain; call clearChanges() each frame.
   */
  onAdded<T>(def: ComponentType<T>, fn: (entity: Entity) => void): void {
    this.trackChanges(def);
    if (this.addedCallbacks === null) this.addedCallbacks = new Map();
    const list = this.addedCallbacks.get(def.id);
    if (list) list.push(fn);
    else this.addedCallbacks.set(def.id, [fn]);
  }

  /**
   * Fire `fn(e)` for each entity that lost `def`, at one deterministic point
   * inside flush() (after structural changes settle). Auto-enables tracking for
   * `def`. Does NOT auto-drain; call clearChanges() each frame.
   */
  onRemoved<T>(def: ComponentType<T>, fn: (entity: Entity) => void): void {
    this.trackChanges(def);
    if (this.removedCallbacks === null) this.removedCallbacks = new Map();
    const list = this.removedCallbacks.get(def.id);
    if (list) list.push(fn);
    else this.removedCallbacks.set(def.id, [fn]);
  }

  // Iterate registered callbacks (Map insertion = registration order) and, per
  // component, its delta list in dense store order, fully reproducible.
  private fireCallbacks(
    map: Map<number, ((e: Entity) => void)[]>,
    isAdded: boolean,
  ): void {
    for (const [id, fns] of map) {
      const store = this.stores[id];
      if (store === undefined) continue;
      const list = isAdded ? store.iterAdded() : store.iterRemoved();
      // Fire only entries appended since the last flush this frame, then advance
      // the cursor; the delta list itself drains once per frame (clearChanges),
      // but flush() may run several times before then, so the cursor is what
      // keeps each transition firing exactly once.
      const from = isAdded ? store.addedFired : store.removedFired;
      for (let i = from; i < list.length; i++) {
        const e = list[i] as Entity;
        for (let j = 0; j < fns.length; j++) fns[j](e);
      }
      if (isAdded) store.setAddedFired(list.length);
      else store.setRemovedFired(list.length);
    }
  }
  /** Set a resource value, by typed token (canonical) or string key. */
  setResource<T>(type: ResourceType<T>, value: T): void;
  setResource<T>(key: string, value: T): void;
  setResource<T>(typeOrKey: ResourceType<T> | string, value: T): void {
    if (typeof typeOrKey === "string") {
      this.stringResources.set(typeOrKey, value);
    } else {
      this.resources.set(typeOrKey.id, value);
    }
  }

  /**
   * Get a resource value. By token it throws if unset; by string key it returns
   * undefined if unset.
   */
  getResource<T>(type: ResourceType<T>): T;
  getResource<T>(key: string): T | undefined;
  getResource<T>(typeOrKey: ResourceType<T> | string): T | undefined {
    if (typeof typeOrKey === "string") {
      return this.stringResources.get(typeOrKey) as T | undefined;
    }
    const val = this.resources.get(typeOrKey.id);
    if (val === undefined) {
      throw new Error(`Resource "${typeOrKey.name}" not set`);
    }
    return val as T;
  }

  /** Get a resource value by token, or undefined if not set. */
  tryGetResource<T>(type: ResourceType<T>): T | undefined {
    return this.resources.get(type.id) as T | undefined;
  }

  /** Remove a resource, by typed token or string key. The inverse of setResource; no-op if unset. */
  unsetResource<T>(type: ResourceType<T>): void;
  unsetResource(key: string): void;
  unsetResource<T>(typeOrKey: ResourceType<T> | string): void {
    if (typeof typeOrKey === "string") {
      this.stringResources.delete(typeOrKey);
    } else {
      this.resources.delete(typeOrKey.id);
    }
  }
  /**
   * Get (lazily initializing) this token's local scratch state. The value is
   * created via the token's `init` on first access for this World and then
   * returned by reference on every subsequent call, so mutations persist across
   * frames. Local state is private to whoever holds the token (typically one
   * system) and is independent of resources, components, and events.
   */
  local<T>(type: LocalType<T>): T {
    let v = this.locals.get(type.id);
    if (v === undefined && !this.locals.has(type.id)) {
      v = type.init();
      this.locals.set(type.id, v);
    }
    return v as T;
  }

  /**
   * Whether this local has been initialized in this World yet (i.e. `local()`
   * has been called for the token at least once since construction/clear).
   */
  hasLocal<T>(type: LocalType<T>): boolean {
    return this.locals.has(type.id);
  }

  /**
   * Reset a single local back to "uninitialized": the next `local()` call
   * rebuilds it from `init`. No-op if it was never initialized.
   */
  resetLocal<T>(type: LocalType<T>): void {
    this.locals.delete(type.id);
  }
  /** Despawn all entities and clear all stores, resources, and events. */
  clear(): void {
    this.pendingDespawns.length = 0;
    // Bump live ids' generations before dropping them so pre-clear handles/refs
    // can't resolve to a reused id once nextId is reset below.
    for (const id of this.alive) {
      this.generations[id as number] =
        (this.generations[id as number] + 1) >>> 0;
    }
    this.alive.clear();
    for (const store of this.activeStores) {
      store.clear();
    }
    // The bitmask index survives clear() (opt-in persists, like pooling and
    // tracking), but every bit must drop with the stores. A fresh Bitmask is the
    // simplest correct reset; cheap, since clear() is a world reset, not a
    // per-frame path. Cached signatures stay valid (bit positions are static).
    if (this.bitmask) this.bitmask = new Bitmask(this.maxEntities);
    this.resources.clear();
    this.stringResources.clear();
    // Per-system locals are DATA, not configuration: a cleared World forgets all
    // locals, so the next local() rebuilds from init. Touches only the new map,
    // empty for any consumer that never called local().
    this.locals.clear();
    this.events.clearAll();
    this.queryEngine.clear();
    // Incremental queries survive clear() (registration persists, like compiled
    // queries) but their match sets must empty with the stores; the add hooks
    // repopulate as entities are re-spawned. No-op when none are registered.
    for (let i = 0; i < this.incrementalQueries.length; i++) {
      this.incrementalQueries[i].clear();
    }
    // Change tracking: each ComponentStore.clear() already reset its own delta
    // lists and kept its `tracked` flag (opt-in survives clear, like pooling),
    // so trackedStores stays valid and intact. Drop only the callback maps so a
    // reused World does not keep stale onAdded/onRemoved closures.
    this.addedCallbacks = null;
    this.removedCallbacks = null;
    // Reissue ids from 1; generations are monotonic per index and not reset.
    this.nextId = 1;
    this.recycled.length = 0;
    // Reverse index: clear() resets DATA, not CONFIGURATION; drop every tracked
    // edge but keep backrefsEnabled, matching how clear() leaves pooling/tracking
    // opt-ins intact. No-op when backrefs were never enabled (map is null).
    if (this.backrefEdges !== null) this.backrefEdges.clear();
    if (this.holderToTargets !== null) this.holderToTargets.clear();
  }
  // Shared (index, generation) packing for both handles and refs: index in the
  // low indexBits, generation above. handleOf/ref/resolve/deref/unref all route
  // through these so the two encodings never fork.
  private pack(index: number, gen: number): number {
    return gen * (this.indexMask + 1) + index;
  }
  private unpackIndex(value: number): number {
    return value & this.indexMask;
  }
  private unpackGen(value: number): number {
    return Math.floor(value / (this.indexMask + 1));
  }

  /** Stamp the entity's current generation into a stable, storable handle. */
  handleOf(entity: Entity): EntityHandle {
    const index = entity as number;
    return this.pack(index, this.generations[index]) as EntityHandle;
  }

  /**
   * Resolve a handle to its entity, or null if the entity is no longer alive
   * with that generation (it was despawned, or despawned-and-recycled). The
   * returned number is the bare {@link Entity} index, usable with every existing
   * World/store API.
   */
  resolve(handle: EntityHandle): Entity | null {
    const h = handle as number;
    const index = this.unpackIndex(h);
    const gen = this.unpackGen(h);
    if (this.generations[index] !== gen) return null;
    if (!this.alive.has(index as Entity)) return null;
    return index as Entity;
  }

  /** Whether `resolve(handle)` would return a non-null entity. */
  isHandleValid(handle: EntityHandle): boolean {
    return this.resolve(handle) !== null;
  }
  // A ref is the SAME (index, generation) packing as a handle (see handleOf),
  // so the two never fork. Taking a ref is a pure read: it never bumps version
  // and never throws; a ref to a dead/never-spawned entity simply won't resolve.

  /**
   * Create a storable reference to `entity`, stamped with its current
   * generation. If backrefs are enabled and `holder` is supplied, registers a
   * reverse edge so `backrefs(entity)` will report `holder`. Pass `holder`
   * (the entity that stores the ref) whenever you store the ref in a component,
   * so the backref edge is tracked; enabling backrefs does not retroactively
   * index refs taken without a holder.
   */
  ref(entity: Entity): EntityRef;
  ref(entity: Entity, holder: Entity): EntityRef;
  ref(entity: Entity, holder?: Entity): EntityRef {
    const index = entity as number;
    const r = this.pack(index, this.generations[index]) as EntityRef;
    if (
      holder !== undefined &&
      this.backrefsEnabled &&
      this.backrefEdges !== null
    ) {
      // Register the (holder -> target) edge under the TARGET's index. Dedupe
      // keeps backrefs() a set; includes() is O(k) but k is tiny for the
      // surgical parent/child and projectile->owner fan-in this serves.
      let holders = this.backrefEdges.get(index);
      if (holders === undefined) {
        holders = [];
        this.backrefEdges.set(index, holders);
      }
      if (!holders.includes(holder)) holders.push(holder);
      // Mirror the edge under the holder so flush() can sweep it when the holder
      // despawns (see flush()).
      if (this.holderToTargets !== null) {
        let targets = this.holderToTargets.get(holder as number);
        if (targets === undefined) {
          targets = new Set();
          this.holderToTargets.set(holder as number, targets);
        }
        targets.add(index);
      }
    }
    return r;
  }

  /**
   * Resolve a ref to the live entity, or `null` if the target was despawned
   * (generation mismatch) or the ref is {@link NULL_REF}. Pure read: no
   * allocation, no version bump, no structural change. A recycled-and-respawned
   * index is alive but at a bumped generation, so the generation check catches
   * the stale-alias case (the whole point of a ref over a bare entity id).
   */
  deref(ref: EntityRef): Entity | null {
    if (ref === NULL_REF) return null;
    const r = ref as number;
    const index = this.unpackIndex(r);
    const gen = this.unpackGen(r);
    if (this.generations[index] !== gen) return null;
    if (!this.alive.has(index as Entity)) return null;
    return index as Entity;
  }

  /** Whether `ref` still points at a live entity. `deref(ref) !== null`. */
  isRefValid(ref: EntityRef): boolean {
    return this.deref(ref) !== null;
  }
  /**
   * Enable the reverse index. Idempotent. After this, every `ref(target,
   * holder)` records a (holder -> target) edge; `backrefs(target)` lists the
   * holders, and flush() sweeps edges whose target was despawned. Off by
   * default; when off, `ref()` does no edge bookkeeping and `backrefs()` returns
   * the shared empty array. Enabling it does NOT retroactively index refs taken
   * before the call.
   */
  enableBackrefs(): void {
    if (this.backrefsEnabled) return;
    this.backrefsEnabled = true;
    this.backrefEdges = new Map();
    this.holderToTargets = new Map();
  }

  /** Whether the reverse index is enabled. */
  hasBackrefs(): boolean {
    return this.backrefsEnabled;
  }

  /**
   * Entities that hold a (tracked) ref pointing at `target`, in deterministic
   * insertion order, de-duplicated, filtered to those still alive. Returns a
   * shared READ-ONLY empty array when backrefs are disabled or none point at
   * `target`; do not retain it across a structural change (flush() may sweep
   * the underlying list). Never throws.
   *
   * Contract: a holder is auto-swept only when the target dies. A holder is not
   * auto-removed when the holder itself despawns, so its edge can linger; this
   * method filters out despawned holders so they are never reported. A holder
   * index that has been recycled into a different live entity cannot be
   * distinguished and may still appear, so callers needing certainty should
   * `unref()` in the holder's own teardown or re-validate a stored EntityRef.
   */
  backrefs(target: Entity): readonly Entity[] {
    if (!this.backrefsEnabled || this.backrefEdges === null)
      return EMPTY_BACKREFS;
    const holders = this.backrefEdges.get(target as number);
    if (holders === undefined || holders.length === 0) return EMPTY_BACKREFS;
    // Common case: every holder is alive; return the stored array (no alloc).
    let allAlive = true;
    for (let i = 0; i < holders.length; i++) {
      if (!this.alive.has(holders[i])) {
        allAlive = false;
        break;
      }
    }
    if (allAlive) return holders;
    const live: Entity[] = [];
    for (let i = 0; i < holders.length; i++) {
      if (this.alive.has(holders[i])) live.push(holders[i]);
    }
    return live.length === 0 ? EMPTY_BACKREFS : live;
  }

  /**
   * Drop a previously-registered reverse edge (e.g. when a holder overwrites or
   * clears the ref field before the target dies). No-op if backrefs are off or
   * the edge is unknown. Order-preserving (indexOf + splice, not swap-remove) so
   * the remaining holder order stays a pure function of insertion/removal order.
   * Keeps the reverse index from leaking stale holders that outlive the ref but
   * not the target.
   */
  unref(ref: EntityRef, holder: Entity): void {
    if (!this.backrefsEnabled || this.backrefEdges === null) return;
    const index = this.unpackIndex(ref as number);
    const holders = this.backrefEdges.get(index);
    if (holders === undefined) return;
    const at = holders.indexOf(holder);
    if (at !== -1) {
      holders.splice(at, 1);
      if (holders.length === 0) this.backrefEdges.delete(index);
    }
    const targets = this.holderToTargets?.get(holder as number);
    if (targets !== undefined) {
      targets.delete(index);
      if (targets.size === 0) this.holderToTargets?.delete(holder as number);
    }
  }
}

// Shared read-only empty backrefs result: when the reverse index is disabled or
// no holder points at a target, backrefs() hands back this single frozen array,
// so the disabled path allocates nothing and returns a stable reference.
const EMPTY_BACKREFS: readonly Entity[] = Object.freeze([]);

// Shared empty result for added/removed/changed reads of an untracked or
// never-created component type: never allocates, never bumps version.
const _emptyEntities: readonly Entity[] = [];
