/** Branded entity identifier. `EntityId` is a convenience alias. */
export type Entity = number & { readonly __brand: unique symbol };
export type EntityId = Entity;

/**
 * A stable, storable reference to an entity = (index, generation), encoded as
 * one safe-integer number (index in the low bits, generation in the high bits;
 * safe while the World's `maxEntities` ≤ 2^21, which the World constructor
 * enforces). Unlike {@link Entity} (the bare dense index, recycled on despawn), a handle
 * also carries the index's generation at stamp time, so a handle to a despawned
 * entity fails to resolve even after the index is reused. Opaque: build with
 * `world.handleOf`, consume with `world.resolve` / `world.isHandleValid`. Do not
 * pack a generation into `Entity` itself: that would break `sparse[entity]`
 * O(1) indexing in the store and spatial hash.
 */
export type EntityHandle = number & { readonly __handleBrand: unique symbol };

/**
 * A stable, storable reference to an entity = its dense index packed with the
 * generation it had when the ref was taken. The SAME runtime encoding as
 * {@link EntityHandle} (index in the low bits, generation in the high bits, one
 * safe integer), so a ref and a handle for the same entity are bit-identical and
 * resolve through the same generations side-array; they never fork. Unlike a
 * bare {@link Entity} (recycled on despawn), a ref carries the stamp generation,
 * so once the target is despawned (and its index possibly recycled) the ref no
 * longer matches the live generation and resolves to `null`. Encoded as one
 * safe-integer number so it can be stored inside plain component data and
 * compared with `===`. Build with `world.ref`, consume with `world.deref` /
 * `world.isRefValid`. {@link NULL_REF} (0) is the canonical "points at nothing".
 */
export type EntityRef = EntityHandle & { readonly __refBrand: unique symbol };

/** The canonical empty reference. Resolves to `null`, never matches an entity. */
export const NULL_REF = 0 as EntityRef;

/**
 * Token identifying a component type. Created via {@link defineComponent}.
 *
 * `create` / `reset` are optional:
 *  - `defineComponent<T>(name)` builds component data at the call site
 *    (`world.add`).
 *  - `defineComponent<T>(name, create, reset)` uses a factory and is added with
 *    `world.addComponent(entity, def, partial)`, with optional pooling on
 *    despawn (the `reset` hook).
 */
export interface ComponentType<T> {
  readonly id: number;
  readonly name: string;
  readonly create?: () => T;
  readonly reset?: (component: T) => void;
  /** Phantom field to carry the data type; never read at runtime. */
  readonly _phantom?: T;
  /** Per-kind nominal brand (never set at runtime); makes token kinds mutually non-assignable. */
  readonly __kind?: "component";
}

/**
 * A component token created *with* a `create` factory (and `reset` hook). The
 * factory-using APIs (`world.addComponent` and `world.enablePooling`) require
 * this narrower type, so they are statically guaranteed a factory/reset exists
 * (no `data as T` cast, no runtime "missing factory/reset" throw).
 */
export interface PooledComponentType<T> extends ComponentType<T> {
  readonly create: () => T;
  readonly reset: (component: T) => void;
}

/**
 * A presence-only ("tag") component: a {@link ComponentType}<true> whose store
 * holds the shared constant `true` for every member rather than a per-entity
 * object. Branded with `readonly tag: true` so APIs that want to forbid data
 * components (or detect tags) can do so at the type level. Use with
 * `world.addTag` / `world.hasTag` / `world.removeTag`; it also participates in
 * queries exactly like any other component (the store membership is identical).
 * A tag is intentionally NOT a {@link PooledComponentType} (no `create`/`reset`),
 * so it can never be routed through the pooling reset path.
 */
export interface TagType extends ComponentType<true> {
  readonly tag: true;
}

/** Alias of {@link ComponentType}, for code that prefers the `Def` spelling. */
export type ComponentDef<T> = ComponentType<T>;

/** Token identifying a resource (singleton) type. Created via {@link defineResource}. */
export interface ResourceType<T> {
  readonly id: number;
  readonly name: string;
  readonly _phantom?: T;
  /** Per-kind nominal brand. See {@link ComponentType.__kind}. */
  readonly __kind?: "resource";
}

/** Token identifying an event type. Created via {@link defineEvent}. */
export interface EventType<T = void> {
  readonly id: number;
  readonly name: string;
  readonly _phantom?: T;
  /** Per-kind nominal brand. See {@link ComponentType.__kind}. */
  readonly __kind?: "event";
}

/**
 * Token identifying a per-system local scratch slot. Created via
 * {@link defineLocal}. Unlike a resource, a local carries its own lazy
 * initializer; the first {@link World.local} call for the token builds the
 * value. Intended for private per-system state (counters, ring buffers,
 * cached scratch arrays) without reaching for a global resource.
 */
export interface LocalType<T> {
  readonly id: number;
  readonly name: string;
  /** Builds the initial value on first access. Called at most once per World. */
  readonly init: () => T;
  /** Phantom field to carry the data type; never read at runtime. */
  readonly _phantom?: T;
  /** Per-kind nominal brand. See {@link ComponentType.__kind}. */
  readonly __kind?: "local";
}

// Avoid a circular import: the World class lives in world.ts.
import type { World } from "./world";

export type { World };

/**
 * A system is a plain function. The second argument is the frame delta; systems
 * that don't use it can be written as `(world) => void`. Both shapes are valid
 * `System` values.
 */
export type System = (world: World, dt: number) => void;

/** Query result: a tuple of `[Entity, ...components]`. */
export type QueryResult<T extends unknown[]> = [Entity, ...T];
/**
 * A {@link ComponentType} of *some* (erased) data type, for heterogeneous
 * collections of component defs where only the `.id` is read. `ComponentType<T>`
 * is invariant-to-contravariant in `T` under `strictFunctionTypes` (its `reset`
 * takes `T`), so a specific `ComponentType<{x}>` is NOT assignable to
 * `ComponentType<unknown>`; `unknown` would force a cast at every call site.
 * `any` is the canonical, and only, escape; it is confined to this single alias
 * (the value is never read through it, only the id). All public filter types
 * below build on this so `select(...)`/`any(...)` accept concrete components
 * without casts.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous, value-erased component collection (see the JSDoc above); only `.id` is read.
export type AnyComponentType = ComponentType<any>;

/** Role a single wrapped component term plays inside a query spec. */
export type QueryTermKind = "with" | "without" | "maybe";

/**
 * A component reference wrapped to mark its role inside a query spec. Built by
 * the `without` / `maybe` factories in query.ts (a bare def is treated as
 * `with` without wrapping).
 */
export interface QueryTerm<T> {
  readonly kind: QueryTermKind;
  readonly def: ComponentType<T>;
}

/**
 * A {@link QueryTerm} of some erased data type: the heterogeneous form a
 * `without(...)`/`maybe(...)` result flows into a {@link QueryArg} as. Its `def`
 * is an {@link AnyComponentType}, so the same variance rationale applies.
 */
export interface AnyQueryTerm {
  readonly kind: QueryTermKind;
  readonly def: AnyComponentType;
}

/**
 * An `any(...)` group: at least one of the listed defs must be present for an
 * entity to match. Contributes no value to the yield tuple. Built by the `any`
 * factory in query.ts. Stores defs as {@link AnyComponentType} so concrete
 * component types flow in without a cast.
 */
export interface AnyGroup {
  readonly kind: "any";
  readonly defs: AnyComponentType[];
}

/**
 * A single argument to `world.select(...)` / `compileSpec(...)`: a bare
 * {@link ComponentType} (required `with`), a {@link QueryTerm} (`without` /
 * `maybe`), or an {@link AnyGroup} (`any`). Built on {@link AnyComponentType} so
 * a specific `ComponentType<{x}>` / `QueryTerm<{x}>` flows in without a cast.
 */
export type QueryArg = AnyComponentType | AnyQueryTerm | AnyGroup;
let _nextComponentId = 0;
let _nextResourceId = 0;
let _nextEventId = 0;
let _nextLocalId = 0;

/**
 * The shared singleton value every tag store entry points at; never a fresh
 * object, so a tag costs zero per-entity allocation. Exported for the store-fill
 * path and tests; never mutated.
 */
export const TAG_VALUE = true as const;

/**
 * Define a new component type.
 *
 * Two call styles, distinguished at the type level:
 *   defineComponent<T>(name)                  // data built at the call site
 *                                             //   -> ComponentType<T> (use world.add)
 *   defineComponent<T>(name, create, reset)   // factory + pooling hook
 *                                             //   -> PooledComponentType<T>
 *                                             //      (use world.addComponent / pooling)
 */
export function defineComponent<T>(name: string): ComponentType<T>;
export function defineComponent<T>(
  name: string,
  create: () => T,
  reset: (c: T) => void,
): PooledComponentType<T>;
export function defineComponent<T>(
  name: string,
  create?: () => T,
  reset?: (c: T) => void,
): ComponentType<T> {
  return { id: _nextComponentId++, name, create, reset } as ComponentType<T>;
}

/**
 * Define a zero-sized tag component. Unlike {@link defineComponent}, no data
 * object is ever created or stored: membership in the dense store IS the
 * component, and the store value is the module-level shared {@link TAG_VALUE}
 * (= true). Tag ids draw from the SAME counter as `defineComponent`, so a tag is
 * a fully ordinary component id for `world.store`, queries, the bitmask, and
 * `flush`. The `create`/`reset` fields are deliberately absent, so a tag is not
 * a {@link PooledComponentType} and cannot be pooled.
 */
export function defineTag(name: string): TagType {
  return { id: _nextComponentId++, name, tag: true } as TagType;
}

/** Define a new resource (singleton) type. */
export function defineResource<T>(name: string): ResourceType<T> {
  return { id: _nextResourceId++, name } as ResourceType<T>;
}

/** Define a new event type. */
export function defineEvent<T = void>(name: string): EventType<T> {
  return { id: _nextEventId++, name } as EventType<T>;
}

/**
 * Define a per-system local scratch slot.
 *
 *   const Accum = defineLocal<{ n: number }>("frameAccum", () => ({ n: 0 }));
 *   const tick: System = (world) => { world.local(Accum).n++; };
 *
 * Each call produces a unique, process-wide id (same convention as
 * defineComponent / defineResource / defineEvent).
 */
export function defineLocal<T>(name: string, init: () => T): LocalType<T> {
  return { id: _nextLocalId++, name, init } as LocalType<T>;
}
