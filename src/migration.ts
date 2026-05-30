// Schema migration: linear, named per-component upgrade chains
// A pure-data module (imports only `./types` for the ComponentType token),
// driven by the serializer's load path.
//
// Every snapshot / delta blob carries a per-component `_version`. On restore the
// decoded plain value is upgraded step-by-step from its stored version to the
// component's current version before it is written into the World. The empty
// registry is the identity: each component is implicitly version 0 with no steps.
//
// Determinism: `migrate` applies `steps[storedVersion..current-1]` in ascending
// index order: no RNG, clock, or Map iteration (the chains Map is point-lookup
// only). A fixed save buffer + fixed registry restores to an identical World.
// Steps MUST be pure (no globals, RNG, or I/O); a consumer contract the type
// system cannot enforce.

import type { ComponentType } from "./types";

/**
 * One forward step in a component's linear migration chain. Transforms a plain
 * decoded value at version `from` into the shape at version `from + 1`. Pure:
 * no World access, no I/O, no RNG, deterministic. May mutate `prev` in place and
 * return it, or return a fresh object.
 */
export type MigrationStep = (
  prev: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * A linear, named migration chain for one component type. `currentVersion` is
 * the version the live code writes; `steps[v]` upgrades a value from version `v`
 * to `v + 1`. A chain of N steps covers versions 0..N (currentVersion === N).
 */
export interface ComponentMigration {
  readonly componentId: number;
  readonly componentName: string;
  readonly currentVersion: number;
  /** Length === currentVersion. steps[v] : value@v -> value@(v+1). */
  readonly steps: readonly MigrationStep[];
}

/** Thrown when a stored version cannot be upgraded to current. */
export class MigrationError extends Error {
  readonly componentName: string;
  readonly storedVersion: number;
  readonly currentVersion: number;
  constructor(
    componentName: string,
    storedVersion: number,
    currentVersion: number,
    detail: string,
  ) {
    super(
      `Cannot migrate component "${componentName}" from v${storedVersion} ` +
        `to v${currentVersion}: ${detail}`,
    );
    this.componentName = componentName;
    this.storedVersion = storedVersion;
    this.currentVersion = currentVersion;
    this.name = "MigrationError";
  }
}

/**
 * Registry of per-component migration chains. Consumer-owned, passed to the
 * {@link Serializer}. An empty registry treats every component as version 0
 * with a zero-step identity chain.
 */
export class MigrationRegistry {
  /** chains keyed by ComponentType.id */
  private readonly chains = new Map<number, ComponentMigration>();

  /**
   * Define the linear chain for `def`. Call once per component with the full
   * ordered step list. `steps[i]` upgrades vi -> v(i+1); currentVersion is
   * `steps.length`. Re-registering the same component id throws (chains are
   * append-only by intent; mutate the array you pass instead). Returns `this`
   * for chaining (matches `Serializer.register` / `Schedule.addGroup`).
   */
  register<T>(def: ComponentType<T>, steps: readonly MigrationStep[]): this {
    if (this.chains.has(def.id)) {
      throw new Error(`migration chain for "${def.name}" already registered`);
    }
    if (steps.length === 0) {
      throw new Error(
        `migration chain for "${def.name}" has no steps: a zero-step chain is a no-op; omit it`,
      );
    }
    this.chains.set(def.id, {
      componentId: def.id,
      componentName: def.name,
      currentVersion: steps.length,
      // Copy the array so later external mutation can't desync currentVersion.
      steps: [...steps],
    });
    return this;
  }

  /**
   * Current (live-code) version for a component, or 0 if no chain registered.
   * Generic in the component's data type so a concrete `ComponentType<T>` flows
   * in without a cast (a bare `ComponentType<unknown>` would force one at every
   * call site under `strictFunctionTypes`); only `def.id` is read.
   */
  currentVersion<T>(def: ComponentType<T>): number {
    return this.currentVersionById(def.id);
  }

  /** Current version by raw component id. */
  currentVersionById(componentId: number): number {
    return this.chains.get(componentId)?.currentVersion ?? 0;
  }

  /**
   * Upgrade a decoded plain value from `storedVersion` to the component's
   * current version by applying each step in order. Returns the upgraded value
   * (same object identity allowed). Throws {@link MigrationError} when
   * `storedVersion` exceeds current (a save newer than the code), is negative,
   * or is not an integer.
   */
  migrate(
    componentId: number,
    storedVersion: number,
    value: Record<string, unknown>,
    componentName?: string,
  ): Record<string, unknown> {
    const chain = this.chains.get(componentId);
    const current = chain?.currentVersion ?? 0;
    const name = componentName ?? chain?.componentName ?? String(componentId);
    // Fast path: identity, no step calls, same object reference.
    if (storedVersion === current) return value;
    if (storedVersion < 0 || !Number.isInteger(storedVersion)) {
      throw new MigrationError(
        name,
        storedVersion,
        current,
        "version is not a non-negative integer",
      );
    }
    if (storedVersion > current) {
      throw new MigrationError(
        name,
        storedVersion,
        current,
        "save is newer than the running code (no downgrade path)",
      );
    }
    if (typeof value !== "object" || value === null) {
      throw new MigrationError(
        name,
        storedVersion,
        current,
        "cannot migrate a non-object value: chains require object-shaped data",
      );
    }
    // storedVersion < current ⇒ current > 0 ⇒ a chain is registered.
    // Apply each forward step in fixed ascending index order.
    let v = value;
    for (let s = storedVersion; s < current; s++) {
      // biome-ignore lint/style/noNonNullAssertion: storedVersion < current implies the chain exists.
      const step = chain!.steps[s];
      v = step(v); // step s upgrades vS -> v(S+1)
    }
    return v;
  }

  /** True if no chain is registered (lets the serializer skip the migrate path). */
  get isEmpty(): boolean {
    return this.chains.size === 0;
  }
}
