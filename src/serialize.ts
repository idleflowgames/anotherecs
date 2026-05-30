// Serialization: snapshot / restore / delta, driven by consumer codecs
// Reads the world only through public methods (getStoreRaw, iterEntities, has,
// getUnsafe, spawn, clear, add, setResource, tryGetResource, ...); never mutates
// engine internals.
//
// Determinism: a snapshot is a pure function of the world's logical state, made
// canonical by iterating entities in ASCENDING INDEX order (explicitly not the
// store's swap-delete order) and ordering each entity's components by ascending
// ComponentType.id. Two worlds with identical logical content but different
// operation histories produce byte-identical snapshots. Numeric encoding is
// little-endian via explicit DataView calls; the delta byte-compare is exact
// (===), never a tolerance. Zero runtime deps: DataView, typed arrays, and
// TextEncoder only.

import type { ComponentType, Entity, ResourceType, World } from "./index";
import { MigrationError, type MigrationRegistry } from "./migration";

export interface SerializerOptions {
  /** Codec write headroom per component (default 4096). */
  readonly maxComponentBytes?: number;
  /**
   * Optional migration registry. When provided, every component blob is read
   * back through the chain on restore/applyDelta. Omitted (or empty) => all
   * components are treated as version 0 with an identity upgrade: byte-identical
   * to a no-migration serializer for current-version data. The per-component
   * `_version` field is written UNCONDITIONALLY (a constant 0 when no chain is
   * registered), so "no migrations" is represented in the format.
   */
  readonly migrations?: MigrationRegistry;
}

/**
 * Per-component-type binary codec the consumer supplies. The serializer never
 * reflects on component shape; the codec owns the byte layout.
 *
 * - `write` appends `c`'s bytes into `view` at `offset` and returns the new
 *   offset (offset + bytesWritten).
 * - `read` decodes a value starting at `offset` and returns it with the new
 *   offset. `read` MUST consume exactly as many bytes as the matching `write`
 *   produced (round-trip byte-symmetry is the core contract).
 * - `refFields` lists keys whose values are `Entity` references; on `restore`
 *   they are remapped from old indices to the new spawned ids via the idMap.
 *   A ref equal to 0 ("no entity") is preserved as 0.
 * - `readVersioned` is an optional version-aware decode. REQUIRED for any
 *   migrated component whose OLDER versions wrote a DIFFERENT on-wire byte
 *   layout than the current `read` expects, which is essentially every
 *   add/remove/reorder of a serialized field, since each changes the byte count
 *   or field set. It receives `storedVersion` and must consume exactly the bytes
 *   THAT version wrote, returning the value in that version's shape; the
 *   migration chain then upgrades it to current. `read` alone is safe ONLY when
 *   every stored version's bytes are identical to what the current `read`
 *   consumes (e.g. a migration that derives a new JS field at upgrade time
 *   without changing the serialized bytes). Supplying `read` for a layout-
 *   changing migration desyncs the byte stream; `restore` detects the resulting
 *   length mismatch and throws rather than silently mis-loading.
 */
export interface ComponentCodec<T> {
  write(view: DataView, offset: number, c: T): number;
  read(view: DataView, offset: number): { value: T; offset: number };
  refFields?: (keyof T)[];
  readVersioned?(
    view: DataView,
    offset: number,
    version: number,
  ): { value: Record<string, unknown>; offset: number };
}

/** A registered resource codec: same byte contract, no refFields. */
export interface ResourceCodec<T> {
  write(view: DataView, offset: number, value: T): number;
  read(view: DataView, offset: number): { value: T; offset: number };
}

const MAGIC = 0x41454353; // "AECS"
const FORMAT_SNAPSHOT = 1;
const FORMAT_DELTA = 2;
const FORMAT_VERSION = 1;
const DEFAULT_MAX_COMPONENT_BYTES = 4096;

// biome-ignore lint/suspicious/noExplicitAny: codec registry is value-erased: only the byte layout matters; the consumer owns the typed boundary.
type AnyCodec = ComponentCodec<any>;
// biome-ignore lint/suspicious/noExplicitAny: same erasure as AnyCodec, for resources.
type AnyResourceCodec = ResourceCodec<any>;
// Component sizes are codec-defined, so the backing buffer grows on demand. The
// codec writes directly into the writer's DataView at the current offset; the
// writer pre-`ensure`s a generous per-component slab so a codec never overruns.

class ByteWriter {
  buf: ArrayBuffer;
  view: DataView;
  offset = 0;

  constructor() {
    this.buf = new ArrayBuffer(64);
    this.view = new DataView(this.buf);
  }

  /** Grow the backing buffer so at least `extra` more bytes fit at `offset`. */
  ensure(extra: number): void {
    const need = this.offset + extra;
    if (need <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, need));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.offset));
    this.buf = next;
    this.view = new DataView(next);
  }

  u32(n: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, n >>> 0, true);
    this.offset += 4;
  }

  /**
   * Write one component via its codec. Pre-`ensure`s `maxComponentBytes` of
   * headroom so the codec writes into a DataView with room; advances `offset` to
   * the codec's returned offset. Codecs writing larger blobs must raise
   * `maxComponentBytes` on the Serializer constructor.
   */
  writeComponent(codec: AnyCodec, c: unknown, maxComponentBytes: number): void {
    this.ensure(maxComponentBytes);
    this.offset = codec.write(this.view, this.offset, c);
  }

  /** Write one resource via its codec (same headroom contract as a component). */
  writeResource(
    codec: AnyResourceCodec,
    value: unknown,
    maxComponentBytes: number,
  ): void {
    this.ensure(maxComponentBytes);
    this.offset = codec.write(this.view, this.offset, value);
  }

  /** Return an exact-length copy of the written bytes. */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.offset);
  }
}
class ByteReader {
  readonly view: DataView;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  u32(): number {
    const n = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return n;
  }
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

interface DecodedRecord {
  oldIndex: number;
  comps: { compId: number; value: unknown }[];
}

export class Serializer {
  private readonly codecs = new Map<
    number,
    { def: ComponentType<unknown>; codec: AnyCodec }
  >();
  private readonly resourceCodecs = new Map<
    number,
    { type: ResourceType<unknown>; codec: AnyResourceCodec }
  >();
  // Sorted ascending list of registered component ids; recomputed on register
  // so snapshot ordering is stable and independent of registration order.
  private orderedComponentIds: number[] = [];
  // shadow[compId][entityIndex] = last-written component bytes; shadowAlive is
  // the entity-index set present at the last baseline. resourceShadow[resId] =
  // last-written resource bytes. The shadow is the source of truth for delta();
  // change-tracking, when present, only narrows the candidate set, and every
  // candidate is still byte-verified against the shadow, so both paths emit
  // identical bytes for the same state transition.
  private shadow = new Map<number, Map<number, ArrayBuffer>>();
  private shadowAlive = new Set<number>();
  private resourceShadow = new Map<number, ArrayBuffer>();

  // Old-index -> live entity, seeded by restore/applyDelta so a subsequent
  // applyDelta remaps refs consistently against the live world.
  private applyIdMap = new Map<number, Entity>();

  private readonly maxComponentBytes: number;

  // Optional consumer-owned migration registry. `undefined` or an empty registry
  // means every component is implicitly version 0 with an identity upgrade.
  private readonly migrations?: MigrationRegistry;

  constructor(options?: SerializerOptions) {
    this.maxComponentBytes =
      options?.maxComponentBytes ?? DEFAULT_MAX_COMPONENT_BYTES;
    this.migrations = options?.migrations;
  }

  // Current (live-code) version written for a component blob. When no migrations
  // are registered this is a constant 0 for every component, so the `_version`
  // field is a fixed 0.
  private versionOf(componentId: number): number {
    return this.migrations?.currentVersionById(componentId) ?? 0;
  }

  // Decode one component blob: read its `_version`, then decode the value via
  // `readVersioned` (version-aware, for wire-layout changes) or `read` (current
  // layout), then upgrade it through the migration chain. Advances `r.offset`.
  // Runs AFTER decode and BEFORE the world write so refField remap (declared
  // against the CURRENT shape) sees the migrated value. Returns the migrated
  // plain value; the caller remaps refs and writes it.
  private decodeComponent(
    r: ByteReader,
    compId: number,
  ): { value: unknown; offset: number } {
    const storedVersion = r.u32();
    const codec = this.codecById(compId);
    const decoded = codec.readVersioned
      ? codec.readVersioned(r.view, r.offset, storedVersion)
      : (codec.read(r.view, r.offset) as {
          value: Record<string, unknown>;
          offset: number;
        });
    let value: unknown = decoded.value;
    if (this.migrations !== undefined && !this.migrations.isEmpty) {
      value = this.migrations.migrate(
        compId,
        storedVersion,
        decoded.value as Record<string, unknown>,
        this.defById(compId).name,
      );
    } else if (storedVersion !== 0) {
      // A versioned save but no registry supplied -> fail loud, never silently
      // mis-load.
      throw new MigrationError(
        this.defById(compId).name,
        storedVersion,
        0,
        "no MigrationRegistry supplied to deserialize a versioned save",
      );
    }
    return { value, offset: decoded.offset };
  }

  /** Register a binary codec for a component type. Chainable. */
  register<T>(def: ComponentType<T>, codec: ComponentCodec<T>): this {
    this.codecs.set(def.id, {
      def: def as ComponentType<unknown>,
      codec: codec as AnyCodec,
    });
    this.orderedComponentIds = [...this.codecs.keys()].sort((a, b) => a - b);
    return this;
  }

  /** Register a resource to include in snapshots (optional, opt-in). */
  registerResource<T>(type: ResourceType<T>, codec: ResourceCodec<T>): this {
    this.resourceCodecs.set(type.id, {
      type: type as ResourceType<unknown>,
      codec: codec as AnyResourceCodec,
    });
    return this;
  }

  private defById(id: number): ComponentType<unknown> {
    const entry = this.codecs.get(id);
    if (entry === undefined) {
      throw new Error(`serialize: no codec registered for component id ${id}`);
    }
    return entry.def;
  }

  private codecById(id: number): AnyCodec {
    const entry = this.codecs.get(id);
    if (entry === undefined) {
      throw new Error(`serialize: no codec registered for component id ${id}`);
    }
    return entry.codec;
  }
  /**
   * Full world state as a self-describing buffer. Entities are emitted in
   * ascending index order; per entity, components are emitted in ascending
   * ComponentType.id order. Little-endian throughout.
   */
  snapshot(world: World): ArrayBuffer {
    const w = new ByteWriter();
    w.u32(MAGIC);
    w.u32(FORMAT_SNAPSHOT);
    w.u32(FORMAT_VERSION);

    const entities = this.aliveSorted(world);
    w.u32(entities.length);

    for (let i = 0; i < entities.length; i++) {
      const idx = entities[i];
      w.u32(idx);
      const present = this.presentComponents(world, idx);
      w.u32(present.length);
      for (let j = 0; j < present.length; j++) {
        const compId = present[j];
        w.u32(compId);
        // Per-component `_version`, written with the same primitive as compId.
        // A constant 0 when no migration chain is registered.
        w.u32(this.versionOf(compId));
        const c = world
          .getStoreRaw(this.defById(compId))
          .getUnsafe(idx as Entity);
        w.writeComponent(this.codecById(compId), c, this.maxComponentBytes);
      }
    }

    this.writeResources(world, w);
    this.captureBaseline(world, entities);
    return w.finish();
  }

  // Union of every registered store's members, as a sorted ascending array.
  // KEY: sorting by index makes the buffer canonical regardless of the store's
  // dense swap-delete order. UNION MODEL (deliberate): serialization is
  // component-driven: an entity with no registered component is in no store and
  // is therefore not serialized. Losing its last registered component removes an
  // entity from the serialized view (see delta()'s note).
  private aliveSorted(world: World): number[] {
    const alive = new Set<number>();
    for (let i = 0; i < this.orderedComponentIds.length; i++) {
      const def = this.defById(this.orderedComponentIds[i]);
      const ents = world.getStoreRaw(def).iterEntities();
      for (let e = 0; e < ents.length; e++) alive.add(ents[e] as number);
    }
    return [...alive].sort((a, b) => a - b);
  }

  // Registered component ids present on `idx`, in ascending id order.
  private presentComponents(world: World, idx: number): number[] {
    const present: number[] = [];
    for (let i = 0; i < this.orderedComponentIds.length; i++) {
      const compId = this.orderedComponentIds[i];
      if (world.getStoreRaw(this.defById(compId)).has(idx as Entity)) {
        present.push(compId);
      }
    }
    return present;
  }

  // Collect present registered resources (sorted by id), then write count + each.
  private writeResources(world: World, w: ByteWriter): void {
    const ids = [...this.resourceCodecs.keys()].sort((a, b) => a - b);
    const present: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      const entry = this.resourceCodecs.get(ids[i]);
      if (entry === undefined) continue;
      if (world.tryGetResource(entry.type) !== undefined) present.push(ids[i]);
    }
    w.u32(present.length);
    for (let i = 0; i < present.length; i++) {
      const entry = this.resourceCodecs.get(present[i]);
      if (entry === undefined) continue;
      w.u32(present[i]);
      const value = world.tryGetResource(entry.type);
      w.writeResource(entry.codec, value, this.maxComponentBytes);
    }
  }
  /**
   * Clear `world`, re-spawn every entity in the snapshot, re-add components via
   * the registered codecs, and remap every `refFields` value from old index to
   * the freshly-spawned id. After restore, `delta()` baselines reset.
   */
  restore(world: World, buffer: ArrayBuffer): void {
    const r = new ByteReader(buffer);
    if (r.u32() !== MAGIC) throw new Error("serialize: bad magic");
    if (r.u32() !== FORMAT_SNAPSHOT) {
      throw new Error("serialize: bad format (expected snapshot)");
    }
    if (r.u32() !== FORMAT_VERSION) throw new Error("serialize: bad version");

    world.clear();

    const n = r.u32();
    const idMap = new Map<number, Entity>();
    const records: DecodedRecord[] = [];

    // FIRST PASS: spawn every entity up front so the idMap is complete BEFORE
    // any ref remap: a ref pointing at an entity that appears later in the
    // buffer still resolves.
    for (let i = 0; i < n; i++) {
      const oldIndex = r.u32();
      const newE = world.spawn();
      idMap.set(oldIndex, newE);
      const compCount = r.u32();
      const comps: { compId: number; value: unknown }[] = [];
      for (let j = 0; j < compCount; j++) {
        const compId = r.u32();
        // decodeComponent reads the per-component `_version`, decodes via the
        // (version-aware) codec, and upgrades through the migration chain.
        const decoded = this.decodeComponent(r, compId);
        r.offset = decoded.offset;
        comps.push({ compId, value: decoded.value });
      }
      records.push({ oldIndex, comps });
    }

    // SECOND PASS: remap refs through the now-complete idMap and add.
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const newE = idMap.get(record.oldIndex) as Entity;
      for (let j = 0; j < record.comps.length; j++) {
        const { compId, value } = record.comps[j];
        this.remapRefs(compId, value, idMap);
        world.add(newE, this.defById(compId), value);
      }
    }

    this.readResources(world, r);

    // Integrity check: a well-formed snapshot is consumed exactly. A leftover or
    // short tail means a codec read/write byte-count asymmetry or a migrated
    // component decoded with `read` instead of `readVersioned`: fail loudly
    // here rather than silently dropping/mis-loading later entities.
    if (r.offset !== buffer.byteLength) {
      throw new Error(
        `serialize: restore consumed ${r.offset} of ${buffer.byteLength} bytes; ` +
          `likely a codec read/write byte mismatch or a migrated component missing readVersioned`,
      );
    }

    const restored = [...idMap.values()]
      .map((e) => e as number)
      .sort((a, b) => a - b);
    this.captureBaseline(world, restored);
    this.applyIdMap = idMap;
  }

  // Remap a decoded value's refFields from old index to live entity. A ref of 0
  // ("no entity") stays 0; an unmapped ref also becomes 0.
  private remapRefs(
    compId: number,
    value: unknown,
    idMap: Map<number, Entity>,
  ): void {
    const codec = this.codecById(compId);
    const refFields = codec.refFields;
    if (
      refFields === undefined ||
      value === null ||
      typeof value !== "object"
    ) {
      return;
    }
    const v = value as Record<string, number>;
    for (let i = 0; i < refFields.length; i++) {
      const f = refFields[i] as string;
      const old = v[f];
      v[f] = old === 0 ? 0 : ((idMap.get(old) ?? 0) as number);
    }
  }

  private readResources(world: World, r: ByteReader): void {
    const resCount = r.u32();
    for (let i = 0; i < resCount; i++) {
      const rid = r.u32();
      const entry = this.resourceCodecs.get(rid);
      if (entry === undefined) {
        throw new Error(
          `serialize: no codec registered for resource id ${rid}`,
        );
      }
      const decoded = entry.codec.read(r.view, r.offset);
      r.offset = decoded.offset;
      world.setResource(entry.type, decoded.value);
    }
  }
  /**
   * Bytes for only the entities/components changed since the last `delta()` or
   * `snapshot()`/`restore()` baseline. Computed by an exact (epsilon-0) byte
   * diff of every alive entity's registered components against the per-Serializer
   * shadow captured at the last baseline. Emits removed-entity, then per-entity
   * added/changed and removed-component records, then resource diffs; entities
   * ascending, components ascending, so the output is a pure function of state
   * (never the store's dense order). Delta output is INDEPENDENT of whether
   * change tracking is enabled: the shadow diff is the source of truth.
   *
   * UNION MODEL: an entity is part of the serialized world only while it holds a
   * registered component. Removing an entity's LAST registered component (even if
   * the entity stays alive in the source world) is emitted as a removed-entity
   * record, so `applyDelta` despawns its replica, keeping the delta path
   * consistent with what a fresh `snapshot`/`restore` of the same source would
   * produce. To persist an otherwise-componentless entity across a snapshot,
   * keep at least one registered (tag) component on it.
   */
  delta(world: World): ArrayBuffer {
    const w = new ByteWriter();
    w.u32(MAGIC);
    w.u32(FORMAT_DELTA);
    w.u32(FORMAT_VERSION);

    const curr = this.aliveSorted(world);
    const currSet = new Set(curr);

    // Removed entities: present at baseline, absent now (ascending).
    const removedEntities: number[] = [];
    for (const idx of this.shadowAlive) {
      if (!currSet.has(idx)) removedEntities.push(idx);
    }
    removedEntities.sort((a, b) => a - b);

    w.u32(removedEntities.length);
    for (let i = 0; i < removedEntities.length; i++) w.u32(removedEntities[i]);

    // Per-entity component diff against the shadow (ascending entity, ascending
    // compId, both pure functions of state, never the store's dense order).
    const records: {
      idx: number;
      addedOrChanged: { compId: number; bytes: ArrayBuffer }[];
      removed: number[];
    }[] = [];

    for (let i = 0; i < curr.length; i++) {
      const idx = curr[i];
      const shadowRow = this.shadow.get(idx);
      const addedOrChanged: { compId: number; bytes: ArrayBuffer }[] = [];
      const removed: number[] = [];
      for (let j = 0; j < this.orderedComponentIds.length; j++) {
        const compId = this.orderedComponentIds[j];
        const def = this.defById(compId);
        const store = world.getStoreRaw(def);
        const presentNow = store.has(idx as Entity);
        const prevBytes = shadowRow?.get(compId);
        if (presentNow) {
          const bytes = this.componentBytes(world, compId, idx);
          // ADDED (not in shadow) or CHANGED (bytes differ). A markChanged that
          // did not change bytes emits nothing; the byte-verify guarantees the
          // delta is byte-identical regardless of which path produced the
          // candidate.
          if (prevBytes === undefined || !buffersEqual(prevBytes, bytes)) {
            addedOrChanged.push({ compId, bytes });
          }
        } else if (prevBytes !== undefined) {
          // REMOVED component (was in shadow, absent now).
          removed.push(compId);
        }
      }
      if (addedOrChanged.length > 0 || removed.length > 0) {
        records.push({ idx, addedOrChanged, removed });
      }
    }

    w.u32(records.length);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      w.u32(rec.idx);
      w.u32(rec.addedOrChanged.length);
      w.u32(rec.removed.length);
      for (let j = 0; j < rec.addedOrChanged.length; j++) {
        const { compId, bytes } = rec.addedOrChanged[j];
        w.u32(compId);
        // Per-component `_version` (same constant-0 rule as snapshot). The
        // shadow stores only the codec bytes, so the version is
        // emitted here, not embedded in `bytes`.
        w.u32(this.versionOf(compId));
        this.appendBytes(w, bytes);
      }
      for (let j = 0; j < rec.removed.length; j++) w.u32(rec.removed[j]);
    }

    this.writeResourceDelta(world, w);
    this.captureBaseline(world, curr);
    return w.finish();
  }

  // Serialize a single component into its own exact-length buffer (for shadow
  // storage and byte comparison).
  private componentBytes(
    world: World,
    compId: number,
    idx: number,
  ): ArrayBuffer {
    const scratch = new ByteWriter();
    const c = world.getStoreRaw(this.defById(compId)).getUnsafe(idx as Entity);
    scratch.writeComponent(this.codecById(compId), c, this.maxComponentBytes);
    return scratch.finish();
  }

  // Append a pre-serialized component's bytes verbatim (length-prefixed-free:
  // the codec's read consumes exactly its own bytes, so no length tag needed).
  private appendBytes(w: ByteWriter, bytes: ArrayBuffer): void {
    const src = new Uint8Array(bytes);
    w.ensure(src.length);
    new Uint8Array(w.buf).set(src, w.offset);
    w.offset += src.length;
  }

  // Resource diff: emit each changed/added resource (id + bytes), then removed
  // resource ids. Diffed against resourceShadow, byte-exact.
  private writeResourceDelta(world: World, w: ByteWriter): void {
    const ids = [...this.resourceCodecs.keys()].sort((a, b) => a - b);
    const changed: { rid: number; bytes: ArrayBuffer }[] = [];
    const removed: number[] = [];
    const presentNow = new Set<number>();
    for (let i = 0; i < ids.length; i++) {
      const rid = ids[i];
      const entry = this.resourceCodecs.get(rid);
      if (entry === undefined) continue;
      const value = world.tryGetResource(entry.type);
      const prev = this.resourceShadow.get(rid);
      if (value !== undefined) {
        presentNow.add(rid);
        const scratch = new ByteWriter();
        scratch.writeResource(entry.codec, value, this.maxComponentBytes);
        const bytes = scratch.finish();
        if (prev === undefined || !buffersEqual(prev, bytes)) {
          changed.push({ rid, bytes });
        }
      }
    }
    for (const rid of this.resourceShadow.keys()) {
      if (!presentNow.has(rid)) removed.push(rid);
    }
    changed.sort((a, b) => a.rid - b.rid);
    removed.sort((a, b) => a - b);
    w.u32(changed.length);
    for (let i = 0; i < changed.length; i++) {
      w.u32(changed[i].rid);
      this.appendBytes(w, changed[i].bytes);
    }
    w.u32(removed.length);
    for (let i = 0; i < removed.length; i++) w.u32(removed[i]);
  }
  /** Apply a `delta()` buffer to `world`, remapping refs through the live idMap. */
  applyDelta(world: World, buffer: ArrayBuffer): void {
    const r = new ByteReader(buffer);
    if (r.u32() !== MAGIC) throw new Error("serialize: bad magic");
    if (r.u32() !== FORMAT_DELTA) {
      throw new Error("serialize: bad format (expected delta)");
    }
    if (r.u32() !== FORMAT_VERSION) throw new Error("serialize: bad version");

    const idMap = this.applyIdMap;

    // Removed entities: despawn + flush immediately so removals are visible
    // before re-adds. delta apply is a save-load boundary, not a mid-frame op,
    // so a flush here does not affect any running schedule.
    const removedCount = r.u32();
    for (let i = 0; i < removedCount; i++) {
      const oldIndex = r.u32();
      const e = idMap.get(oldIndex);
      if (e !== undefined && world.isAlive(e)) world.despawn(e);
      idMap.delete(oldIndex);
    }
    if (removedCount > 0) world.flush();

    // Changed records: decode into a temp structure, spawning unknown indices
    // FIRST so the idMap is complete before any ref remap (two-phase, like
    // restore).
    const recordCount = r.u32();
    const decoded: {
      target: Entity;
      addedOrChanged: { compId: number; value: unknown }[];
      removed: number[];
    }[] = [];

    for (let i = 0; i < recordCount; i++) {
      const oldIndex = r.u32();
      const addedOrChangedCount = r.u32();
      const removedCount2 = r.u32();
      let target = idMap.get(oldIndex);
      if (target === undefined) {
        target = world.spawn();
        idMap.set(oldIndex, target);
      }
      const addedOrChanged: { compId: number; value: unknown }[] = [];
      for (let j = 0; j < addedOrChangedCount; j++) {
        const compId = r.u32();
        // decodeComponent reads the per-component `_version`, decodes, and
        // upgrades through the migration chain (mirrors restore).
        const d = this.decodeComponent(r, compId);
        r.offset = d.offset;
        addedOrChanged.push({ compId, value: d.value });
      }
      const removed: number[] = [];
      for (let j = 0; j < removedCount2; j++) removed.push(r.u32());
      decoded.push({ target, addedOrChanged, removed });
    }

    for (let i = 0; i < decoded.length; i++) {
      const rec = decoded[i];
      for (let j = 0; j < rec.addedOrChanged.length; j++) {
        const { compId, value } = rec.addedOrChanged[j];
        this.remapRefs(compId, value, idMap);
        world.add(rec.target, this.defById(compId), value);
      }
      for (let j = 0; j < rec.removed.length; j++) {
        world.remove(rec.target, this.defById(rec.removed[j]));
      }
    }

    this.applyResourceDelta(world, r);

    if (r.offset !== buffer.byteLength) {
      throw new Error(
        `serialize: applyDelta consumed ${r.offset} of ${buffer.byteLength} bytes; ` +
          `likely a codec read/write byte mismatch or a migrated component missing readVersioned`,
      );
    }

    const alive = this.aliveSorted(world);
    this.captureBaseline(world, alive);
  }

  private applyResourceDelta(world: World, r: ByteReader): void {
    const changedCount = r.u32();
    for (let i = 0; i < changedCount; i++) {
      const rid = r.u32();
      const entry = this.resourceCodecs.get(rid);
      if (entry === undefined) {
        throw new Error(
          `serialize: no codec registered for resource id ${rid}`,
        );
      }
      const d = entry.codec.read(r.view, r.offset);
      r.offset = d.offset;
      world.setResource(entry.type, d.value);
    }
    const removedCount = r.u32();
    for (let i = 0; i < removedCount; i++) {
      const rid = r.u32();
      const entry = this.resourceCodecs.get(rid);
      if (entry !== undefined) world.unsetResource(entry.type);
    }
  }
  // captureBaseline (private): rebuild the shadow + shadowAlive
  // O(alive × components × bytes), run only on snapshot/restore/delta/applyDelta
  // calls (never per-frame unless the consumer calls delta per-frame).

  private captureBaseline(world: World, sortedIndices: number[]): void {
    const shadow = new Map<number, Map<number, ArrayBuffer>>();
    for (let i = 0; i < sortedIndices.length; i++) {
      const idx = sortedIndices[i];
      let row: Map<number, ArrayBuffer> | undefined;
      for (let j = 0; j < this.orderedComponentIds.length; j++) {
        const compId = this.orderedComponentIds[j];
        const store = world.getStoreRaw(this.defById(compId));
        if (!store.has(idx as Entity)) continue;
        if (row === undefined) {
          row = new Map();
          shadow.set(idx, row);
        }
        row.set(compId, this.componentBytes(world, compId, idx));
      }
    }
    this.shadow = shadow;
    this.shadowAlive = new Set(sortedIndices);

    const resourceShadow = new Map<number, ArrayBuffer>();
    for (const [rid, entry] of this.resourceCodecs) {
      const value = world.tryGetResource(entry.type);
      if (value === undefined) continue;
      const scratch = new ByteWriter();
      scratch.writeResource(entry.codec, value, this.maxComponentBytes);
      resourceShadow.set(rid, scratch.finish());
    }
    this.resourceShadow = resourceShadow;
  }
}
// jsonCodec: generic JSON codec for plain-data components
// Slower, non-binary (UTF-8 via TextEncoder). A convenience so consumers can
// serialize before hand-writing a binary codec; `refFields` still works (JSON
// stores raw numeric ids, and entity ids are < 2^53 so they round-trip exact).
//
// Determinism caveat: JSON.stringify key order follows insertion order, so for
// byte-identity the component object must have stable key order (true for plain
// components built by a factory). For values containing -0, NaN, or floats whose
// decimal round-trip differs, use the binary path; jsonCodec targets integer /
// string plain data.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Generic JSON codec for plain-data components (slower, non-binary; UTF-8 via
 * TextEncoder). `refFields` still works (JSON stores raw numeric ids). Does NOT
 * round-trip `-0` (→ `0`), `NaN`/`Infinity` (→ `null`), or floats whose decimal
 * form differs; use a binary codec for those.
 */
export function jsonCodec<T>(refFields?: (keyof T)[]): ComponentCodec<T> {
  return {
    write(view: DataView, offset: number, c: T): number {
      const json = JSON.stringify(c);
      const bytes = enc.encode(json);
      view.setUint32(offset, bytes.length, true);
      new Uint8Array(
        view.buffer,
        view.byteOffset + offset + 4,
        bytes.length,
      ).set(bytes);
      return offset + 4 + bytes.length;
    },
    read(view: DataView, offset: number): { value: T; offset: number } {
      const len = view.getUint32(offset, true);
      const slice = new Uint8Array(
        view.buffer,
        view.byteOffset + offset + 4,
        len,
      );
      const value = JSON.parse(dec.decode(slice)) as T;
      return { value, offset: offset + 4 + len };
    },
    refFields,
  };
}
