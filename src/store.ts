// ComponentStore: sparse-set dense component storage
// Iteration order is a deterministic function of the add/remove sequence. Do NOT
// replace swap-delete with another compaction (e.g. tombstones): that would shift
// iteration order, which downstream determinism depends on.

import type { EntityId } from "./types";

/**
 * Default maximum entity count. The sparse Int32Array is pre-allocated to this
 * size, so each store pays `capacity × 4` bytes (256 KB at 65536). Removes the
 * cap as a practical concern for spawner-heavy moments.
 */
export const DEFAULT_MAX_ENTITIES = 65536;

const EMPTY = -1;

export class ComponentStore<T> {
  private readonly sparse: Int32Array;
  private readonly entities: EntityId[] = [];
  private readonly data: T[] = [];
  private count = 0;
  private readonly capacity: number;

  private pooling = false;
  private resetFn: ((c: T) => void) | null = null;
  private readonly freeList: T[] = [];

  // Deltas accumulate in dense store order on set/remove and drain on
  // drainChanges(). Untracked stores record nothing.
  private tracked = false;
  private readonly _added: EntityId[] = [];
  private readonly _removed: EntityId[] = [];
  private readonly _changed: EntityId[] = [];
  // Per-list callback dispatch cursors: how many _added/_removed entries the
  // onAdded/onRemoved fan-out has already fired. The delta lists drain only on
  // drainChanges() (once per frame), but flush() can run several times per frame
  // (the default Schedule flushes after every group), so without a cursor a
  // single add would re-fire its callback on every flush until the frame drain.
  private _addedFired = 0;
  private _removedFired = 0;

  // Bumped on every membership change (add/remove) AND object replacement (a
  // `set` on an existing entity replaces the stored object, invalidating cached
  // query tuples that hold the old reference). Lets a query rebuild only when
  // one of its own component stores changes.
  private _version = 0;

  constructor(capacity: number = DEFAULT_MAX_ENTITIES) {
    this.capacity = capacity;
    this.sparse = new Int32Array(capacity).fill(EMPTY);
  }

  /**
   * Enable component pooling for this store. On `remove`, the removed object is
   * passed through `reset` and pushed onto a free list; the next pooled
   * `acquire()` hands it back instead of allocating. Opt-in per store. Do not
   * enable it where callers rely on each add storing the exact object passed;
   * pooling aliases objects across entities.
   */
  enablePooling(reset: (c: T) => void): void {
    this.pooling = true;
    this.resetFn = reset;
  }

  /** Whether pooling is enabled for this store. */
  isPooling(): boolean {
    return this.pooling;
  }

  /**
   * Enable add/removed/changed tracking for this store. Idempotent. Default OFF;
   * an untracked store records nothing and pays a single already-false branch on
   * set()/remove(). Does NOT retroactively record existing members, only
   * post-enable transitions, matching event-bus "from now on" semantics. Deltas
   * accumulate in dense store order until drainChanges().
   */
  enableTracking(): void {
    this.tracked = true;
  }

  /** Whether tracking is enabled for this store. */
  isTracking(): boolean {
    return this.tracked;
  }

  /**
   * Pop a pooled (already-reset) object, or undefined if pooling is off or the
   * free list is empty. Used by `World.addComponent` to reuse component objects.
   */
  acquire(): T | undefined {
    return this.pooling ? this.freeList.pop() : undefined;
  }

  /** Number of objects currently parked in the free list (for tests/metrics). */
  pooledCount(): number {
    return this.freeList.length;
  }

  /**
   * Monotonic version, bumped on every add/remove (membership change) and on a
   * `set` that replaces an existing object. Read by the query engine to rebuild
   * a cached query only when one of its own component stores has changed.
   */
  get version(): number {
    return this._version;
  }

  /** Whether entity has this component. */
  has(id: EntityId): boolean {
    return (
      (id as number) < this.capacity && this.sparse[id as number] !== EMPTY
    );
  }

  /** Get component data. Returns undefined if not present. */
  get(id: EntityId): T | undefined {
    const idx = this.sparse[id as number];
    return idx !== EMPTY ? this.data[idx] : undefined;
  }

  /** Get component data without bounds check. Caller must ensure has(id). */
  getUnsafe(id: EntityId): T {
    return this.data[this.sparse[id as number]];
  }

  private outOfRange(method: string, id: EntityId): never {
    throw new Error(
      `ComponentStore.${method}(): entity id ${id} exceeds capacity ` +
        `(${this.capacity}). The sparse array cannot index it: this id was not ` +
        `produced by a World sized for it (see World maxEntities).`,
    );
  }

  /** Set (add or update) component data for entity. */
  set(id: EntityId, value: T): void {
    if ((id as number) >= this.capacity) this.outOfRange("set", id);
    const idx = this.sparse[id as number];
    if (idx !== EMPTY) {
      this.data[idx] = value;
    } else {
      const dense = this.count++;
      this.sparse[id as number] = dense;
      this.entities[dense] = id;
      this.data[dense] = value;
      if (this.tracked) this._added.push(id);
    }
    // Bump on both add and object-replacement: a replaced object invalidates any
    // cached query tuple holding the old reference.
    this._version++;
  }

  /**
   * Record an explicit change for an entity that currently has the component.
   * No-op when untracked or absent. Coarse: no dedup; calling it twice on the
   * same entity records two entries. Not pruned on remove, so a changed-then-
   * removed id stays in iterChanged() until drainChanges(); re-check has() if
   * liveness matters.
   */
  markChanged(id: EntityId): void {
    if ((id as number) >= this.capacity) this.outOfRange("markChanged", id);
    if (this.tracked && this.sparse[id as number] !== EMPTY) {
      this._changed.push(id);
    }
  }

  /**
   * Remove component from entity. Swap-delete to keep arrays dense. Returns
   * `true` if the entity had the component (membership changed), `false` if it
   * was absent.
   */
  remove(id: EntityId): boolean {
    if ((id as number) >= this.capacity) this.outOfRange("remove", id);
    const idx = this.sparse[id as number];
    if (idx === EMPTY) return false;

    // Pooling: reset and park the removed object before it leaves the store.
    // Reading data[idx] here happens before the swap below overwrites it.
    if (this.pooling && this.resetFn !== null) {
      const removed = this.data[idx];
      this.resetFn(removed);
      this.freeList.push(removed);
    }

    // Capture the removed id BEFORE the swap-delete mutates the arrays; `id` is
    // the entity itself and is unaffected by compaction, so the recorded delta
    // is the exact membership loss in dense order.
    if (this.tracked) this._removed.push(id);

    const last = this.count - 1;
    if (idx !== last) {
      const lastEntity = this.entities[last];
      this.entities[idx] = lastEntity;
      this.data[idx] = this.data[last];
      this.sparse[lastEntity as number] = idx;
    }
    this.sparse[id as number] = EMPTY;
    this.entities.length = last;
    this.data.length = last;
    this.count = last;
    this._version++;
    return true;
  }

  /** Dense entity array; iterate for hot paths. Length is size(). */
  iterEntities(): ReadonlyArray<EntityId> {
    return this.entities;
  }

  /** Dense data array; iterate for hot paths. Length is size(). */
  iterData(): ReadonlyArray<T> {
    return this.data;
  }

  /** Entities that gained the component since drainChanges(), in dense order. */
  iterAdded(): ReadonlyArray<EntityId> {
    return this._added;
  }

  /** Entities that lost the component since drainChanges(), in dense order. */
  iterRemoved(): ReadonlyArray<EntityId> {
    return this._removed;
  }

  /** Entities marked changed since drainChanges(), in dense order. May include a changed-then-removed id (see markChanged). */
  iterChanged(): ReadonlyArray<EntityId> {
    return this._changed;
  }

  /** Count of _added entries the onAdded fan-out has already dispatched. */
  get addedFired(): number {
    return this._addedFired;
  }

  /** Count of _removed entries the onRemoved fan-out has already dispatched. */
  get removedFired(): number {
    return this._removedFired;
  }

  /** Advance the onAdded dispatch cursor (set by World.flush's callback fan-out). */
  setAddedFired(n: number): void {
    this._addedFired = n;
  }

  /** Advance the onRemoved dispatch cursor. */
  setRemovedFired(n: number): void {
    this._removedFired = n;
  }

  /** Truncate all three delta lists to length 0, resetting dispatch cursors. */
  drainChanges(): void {
    this._added.length = 0;
    this._removed.length = 0;
    this._changed.length = 0;
    this._addedFired = 0;
    this._removedFired = 0;
  }

  /** Number of entities with this component. */
  size(): number {
    return this.count;
  }

  /** Remove all entries. */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.sparse[this.entities[i] as number] = EMPTY;
    }
    this.entities.length = 0;
    this.data.length = 0;
    this.count = 0;
    this.freeList.length = 0;
    // Reset deltas so a cleared store starts fresh. `tracked` stays enabled
    // (opt-in survives clear, mirroring pooling). clear() does NOT push the
    // cleared members into _removed; it is a bulk teardown, not a per-frame
    // structural change, and consumers never observe deltas across a clear().
    this._added.length = 0;
    this._removed.length = 0;
    this._changed.length = 0;
    this._addedFired = 0;
    this._removedFired = 0;
    this._version++;
  }
}
