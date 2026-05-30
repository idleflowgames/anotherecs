import { describe, expect, it } from "vitest";
import {
  defineComponent,
  type Entity,
  type EntityRef,
  NULL_REF,
  World,
} from "../src/index";

const CMark = defineComponent<{ n: number }>("RefMark");

describe("EntityRef round-trip and auto-null", () => {
  it("ref round-trips to the same live entity", () => {
    const world = new World();
    const e = world.spawn();
    const r = world.ref(e);
    expect(world.deref(r)).toBe(e);
    expect(world.isRefValid(r)).toBe(true);
  });

  it("ref resolves to null after the target is despawned + flushed", () => {
    const world = new World();
    const e = world.spawn();
    const r = world.ref(e);
    world.despawn(e);
    expect(world.deref(r)).toBe(e);
    world.flush();
    expect(world.deref(r)).toBe(null);
    expect(world.isRefValid(r)).toBe(false);
  });

  it("stale ref does not alias a recycled index (core safety property)", () => {
    const world = new World();
    const a = world.spawn();
    const r = world.ref(a);
    world.despawn(a);
    world.flush();
    const b = world.spawn();
    expect(b as number).toBe(a as number);
    expect(world.isAlive(b)).toBe(true);
    expect(world.deref(r)).toBe(null);
    const r2 = world.ref(b);
    expect(world.deref(r2)).toBe(b);
    expect(r2 as number).not.toBe(r as number);
  });

  it("NULL_REF resolves to null and is invalid", () => {
    const world = new World();
    expect(world.deref(NULL_REF)).toBe(null);
    expect(world.isRefValid(NULL_REF)).toBe(false);
  });

  it("deref never bumps version or mutates stores (pure read)", () => {
    const world = new World();
    const e = world.spawn();
    world.add(e, CMark, { n: 1 });
    const v = world.version;
    const sizeBefore = world.store(CMark).size();
    const r = world.ref(e);
    world.deref(r);
    world.isRefValid(r);
    expect(world.version).toBe(v);
    expect(world.store(CMark).size()).toBe(sizeBefore);
  });
});

describe("Reverse index is opt-in", () => {
  it("backrefs disabled by default returns the shared empty array, ref() does no bookkeeping", () => {
    const world = new World();
    expect(world.hasBackrefs()).toBe(false);
    const target = world.spawn();
    const holder = world.spawn();
    world.ref(target, holder);
    expect(world.backrefs(target)).toEqual([]);
    expect(world.backrefs(target)).toBe(world.backrefs(target));
  });
});

describe("enableBackrefs records who points at me", () => {
  it("records holders in deterministic insertion order, deduped", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const h1 = world.spawn();
    const h2 = world.spawn();
    const h3 = world.spawn();
    expect(h3 as number).toBeGreaterThan(0);
    world.ref(target, h2);
    world.ref(target, h1);
    world.ref(target, h2);
    expect(world.backrefs(target)).toEqual([h2, h1]);
  });

  it("is idempotent and does not retro-index refs taken before enable", () => {
    const world = new World();
    const target = world.spawn();
    const h1 = world.spawn();
    world.ref(target, h1);
    world.enableBackrefs();
    world.enableBackrefs();
    expect(world.hasBackrefs()).toBe(true);
    world.ref(target, h1);
    expect(world.backrefs(target)).toEqual([h1]);
  });
});

describe("flush() sweeps dangling reverse edges deterministically", () => {
  it("sweeps the despawned target's backref edge but does not delete holders", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const h1 = world.spawn();
    world.ref(target, h1);
    expect(world.backrefs(target)).toEqual([h1]);
    world.despawn(target);
    expect(world.backrefs(target)).toEqual([h1]);
    world.flush();
    expect(world.backrefs(target)).toEqual([]);
    expect(world.isAlive(h1)).toBe(true);
  });

  it("does not delete holders and stale refs auto-null", () => {
    const world = new World();
    world.enableBackrefs();
    const owner = world.spawn();
    const proj = world.spawn();
    const r = world.ref(owner, proj);
    world.despawn(owner);
    world.flush();
    expect(world.isAlive(proj)).toBe(true);
    expect(world.deref(r)).toBe(null);
  });

  it("a despawned holder's edge does not resurface when its index is recycled", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const h1 = world.spawn();
    world.ref(target, h1);
    expect(world.backrefs(target)).toEqual([h1]);

    world.despawn(h1);
    world.flush();

    const reused = world.spawn();
    expect(reused).toBe(h1); // same index reissued
    expect([...world.backrefs(target)]).toEqual([]);
  });
});

describe("unref drops a single edge order-preservingly", () => {
  it("removes one edge keeping order, then prunes the empty list", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const h1 = world.spawn();
    const h2 = world.spawn();
    const h3 = world.spawn();
    world.ref(target, h1);
    world.ref(target, h2);
    world.ref(target, h3);
    const r = world.ref(target, h2);
    world.unref(r, h2);
    expect(world.backrefs(target)).toEqual([h1, h3]);
    world.unref(r, h1);
    world.unref(r, h3);
    expect(world.backrefs(target)).toEqual([]);
    expect(world.backrefs(target)).toBe(world.backrefs(target));
  });

  it("unref is a no-op when backrefs are disabled", () => {
    const world = new World();
    const target = world.spawn();
    const holder = world.spawn();
    const r = world.ref(target);
    world.unref(r, holder);
    expect(world.backrefs(target)).toEqual([]);
  });
});

describe("clear() empties the edge map but keeps backrefs enabled", () => {
  it("drops every edge while preserving the opt-in configuration", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const h1 = world.spawn();
    world.ref(target, h1);
    world.clear();
    expect(world.hasBackrefs()).toBe(true);
    expect(world.backrefs(target)).toEqual([]);
  });
});

describe("ref stored inside a component resolves and auto-nulls (parent/child)", () => {
  const CParent = defineComponent<{ parent: EntityRef }>("RefParent");

  it("end-to-end: the stored ref resolves to the parent, then auto-nulls", () => {
    const world = new World();
    const child = world.spawn();
    const parent = world.spawn();
    world.add(child, CParent, { parent: world.ref(parent, child) });
    expect(
      world.deref((world.get(child, CParent) as { parent: EntityRef }).parent),
    ).toBe(parent);
    world.despawn(parent);
    world.flush();
    expect(
      world.deref((world.get(child, CParent) as { parent: EntityRef }).parent),
    ).toBe(null);
  });
});

describe("EntityRef encoding matches EntityHandle (no fork)", () => {
  it("a ref and a handle for the same entity are bit-identical", () => {
    const world = new World();
    const e: Entity = world.spawn();
    const r = world.ref(e);
    const h = world.handleOf(e);
    expect(r as unknown as number).toBe(h as unknown as number);
  });
});

describe("backrefs() excludes despawned holders", () => {
  it("a holder that despawns no longer appears in its target's backrefs", () => {
    const world = new World();
    world.enableBackrefs();
    const target = world.spawn();
    const holderA = world.spawn();
    const holderB = world.spawn();
    world.ref(target, holderA);
    world.ref(target, holderB);
    expect([...world.backrefs(target)]).toEqual([holderA, holderB]);

    world.despawn(holderA);
    world.flush();
    expect([...world.backrefs(target)]).toEqual([holderB]);

    world.despawn(holderB);
    world.flush();
    expect(world.backrefs(target)).toHaveLength(0);
  });
});
