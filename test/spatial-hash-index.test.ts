import { describe, expect, it, vi } from "vitest";
import { type Entity, SpatialHash } from "../src/index";
import { LegacySpatialHash } from "./support/legacy-spatial-hash";
import { int, mulberry32 } from "./support/prng";

// The dense cell index and the bucket map must answer every read exactly as the
// 0.1.7 hash did, IN ORDER: consumers award order-dependent outcomes from the
// result array, so a reordered result is as much a regression as a missing one.

const CELL = 64;
const CAPACITY = 512;

interface Point {
  x: number;
  y: number;
}

/** Whether the hash's last read went through the dense index. */
function readDense(hash: SpatialHash): boolean {
  const internals = hash as unknown as { count: number; denseFor: number };
  return internals.denseFor === internals.count;
}

const buffer = new Int32Array(CAPACITY);

function candidates(hash: SpatialHash, x: number, y: number, r: number) {
  return Array.from(buffer.subarray(0, hash.queryCandidates(x, y, r, buffer)));
}

function filtered(
  hash: SpatialHash,
  x: number,
  y: number,
  r: number,
  filter: Int32Array,
  stamp: number,
) {
  const count = hash.queryCandidates(x, y, r, buffer, filter, stamp);
  return Array.from(buffer.subarray(0, count));
}

type Spread = "arena" | "wide" | "far" | "sparse";

/** A body's position and radius in a frame of the given spread. */
function body(rng: () => number, spread: Spread, ox: number, oy: number) {
  let x = ox + (rng() - 0.5) * 900;
  let y = oy + (rng() - 0.5) * 900;
  const roll = rng();
  if (spread === "wide" && roll < 0.05) {
    // A straggler millions of units out makes the occupied rectangle too wide.
    x = (rng() - 0.5) * 1e7;
  } else if (spread === "sparse") {
    // A handful of bodies thousands of units apart: few entries, many cells.
    x = ox + (rng() - 0.5) * 6000;
    y = oy + (rng() - 0.5) * 6000;
  }
  let radius = rng() < 0.2 ? rng() * 40 : 9;
  const odd = rng();
  if (odd < 0.02) radius = 0;
  else if (odd < 0.03) radius = -5;
  else if (odd < 0.035) x = Number.NaN;
  return { x, y, radius };
}

/** A query radius, including the degenerate ones a caller can pass. */
function queryRadius(rng: () => number): number {
  const roll = rng();
  if (roll < 0.03) return 0;
  if (roll < 0.05) return -10;
  if (roll < 0.06) return Number.NaN;
  if (roll < 0.1) return 400 + rng() * 2000;
  return rng() * 200;
}

describe("Dense cell index vs the 0.1.7 hash", () => {
  it("answers query, queryRadius and queryCandidates identically, in order", () => {
    const rng = mulberry32(0x5eed);
    const subject = new SpatialHash(CELL, CAPACITY);
    const legacy = new LegacySpatialHash(CELL, CAPACITY);
    const positions = new Map<Entity, Point>();
    const getPos = (entity: Entity) => positions.get(entity);
    const getRadius = (entity: Entity) => (entity % 3) + 7;
    const expected: Entity[] = [];
    const actual: Entity[] = [];
    const spreads: Spread[] = ["arena", "arena", "wide", "far", "sparse"];
    // A stamped subset of the ids, restamped every frame, for the filter.
    const filter = new Int32Array(CAPACITY);
    let stamp = 0;
    let denseReads = 0;
    let mapReads = 0;

    for (let frame = 0; frame < 400; frame++) {
      subject.clear();
      legacy.clear();
      positions.clear();
      const spread = spreads[int(rng, spreads.length)] as Spread;
      stamp++;
      const share = rng();
      for (let id = 0; id < CAPACITY; id++) {
        if (rng() < share) filter[id] = stamp;
      }
      const ox = spread === "far" ? 1e8 : (rng() - 0.5) * 4000;
      const oy = (rng() - 0.5) * 4000;
      const count =
        spread === "sparse" ? 1 + int(rng, 4) : Math.floor(rng() * 300);
      // Some frames interleave reads with the inserts, the way a caller that
      // places bodies one by one does; the rest insert everything first.
      const chunk = rng() < 0.3 ? 1 + int(rng, 12) : count + 1;

      const runQueries = (queries: number) => {
        for (let q = 0; q < queries; q++) {
          const x = ox + (rng() - 0.5) * 1100;
          const y = oy + (rng() - 0.5) * 1100;
          const r = queryRadius(rng);
          legacy.query(x, y, r, expected);
          subject.query(x, y, r, actual);
          expect(actual).toEqual(expected);
          if (readDense(subject)) denseReads++;
          else mapReads++;
          expect(candidates(subject, x, y, r)).toEqual(expected);
          expect(filtered(subject, x, y, r, filter, stamp)).toEqual(
            expected.filter((entity) => filter[entity] === stamp),
          );
          legacy.queryRadius(x, y, r, getPos, getRadius, expected);
          subject.queryRadius(x, y, r, getPos, getRadius, actual);
          expect(actual).toEqual(expected);
        }
      };

      for (let i = 0; i < count; i++) {
        // Ids repeat, so some entities are filed twice in one frame.
        const entity = int(rng, CAPACITY) as Entity;
        const { x, y, radius } = body(rng, spread, ox, oy);
        subject.insert(entity, x, y, radius);
        legacy.insert(entity, x, y, radius);
        positions.set(entity, { x, y });
        if ((i + 1) % chunk === 0) runQueries(2);
      }
      // Bodies move after they are filed and some lose their position, so the
      // cells and the narrow phase disagree the way a frame can make them.
      for (const [entity, point] of positions) {
        const roll = rng();
        if (roll < 0.1) positions.delete(entity);
        else if (roll < 0.4) {
          point.x += (rng() - 0.5) * 120;
          point.y += (rng() - 0.5) * 120;
        }
      }
      runQueries(12);
    }

    // The stream has to exercise both structures to prove anything about them.
    expect(denseReads).toBeGreaterThan(2000);
    expect(mapReads).toBeGreaterThan(1000);
  });

  it("matches across a frame-stamp wrap and the bucket sweep", () => {
    const rng = mulberry32(99);
    const subject = new SpatialHash(CELL, CAPACITY);
    const legacy = new LegacySpatialHash(CELL, CAPACITY);
    (subject as unknown as { frameGen: number }).frameGen = 2147483600;
    (legacy as unknown as { frameGen: number }).frameGen = 2147483600;
    const expected: Entity[] = [];
    const actual: Entity[] = [];
    for (let frame = 0; frame < 200; frame++) {
      subject.clear();
      legacy.clear();
      // Alternate between a straggler that forces the bucket map and none.
      const straggler = frame % 3 === 0;
      for (let i = 0; i < 40; i++) {
        const x = (rng() - 0.5) * 2000;
        const y = (rng() - 0.5) * 2000;
        subject.insert(i as Entity, x, y, 9);
        legacy.insert(i as Entity, x, y, 9);
      }
      if (straggler) {
        subject.insert(40 as Entity, 5e6, 0, 9);
        legacy.insert(40 as Entity, 5e6, 0, 9);
      }
      for (let q = 0; q < 4; q++) {
        const x = (rng() - 0.5) * 2000;
        const y = (rng() - 0.5) * 2000;
        legacy.query(x, y, 300, expected);
        subject.query(x, y, 300, actual);
        expect(actual).toEqual(expected);
        expect(readDense(subject)).toBe(!straggler);
      }
    }
  });
});

describe("Dense cell index rebuilds", () => {
  it("serves a batch of inserts from one build", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    const build = vi.spyOn(
      hash as unknown as { buildDense(): boolean },
      "buildDense",
    );
    const out: Entity[] = [];
    for (let i = 0; i < 300; i++) hash.insert(i as Entity, i * 3, i * 2, 9);
    for (let q = 0; q < 50; q++) hash.query(q * 10, q * 7, 80, out);
    expect(build).toHaveBeenCalledTimes(1);
    expect(readDense(hash)).toBe(true);
  });

  it("does not rebuild on every read when inserts and reads interleave", () => {
    const hash = new SpatialHash(CELL, 4096);
    const legacy = new LegacySpatialHash(CELL, 4096);
    const build = vi.spyOn(
      hash as unknown as { buildDense(): boolean },
      "buildDense",
    );
    const expected: Entity[] = [];
    const actual: Entity[] = [];
    for (let i = 0; i < 4000; i++) {
      const x = (i % 63) * 17;
      const y = Math.floor(i / 63) * 13;
      legacy.query(x, y, 40, expected);
      hash.query(x, y, 40, actual);
      expect(actual).toEqual(expected);
      hash.insert(i as Entity, x, y, 9);
      legacy.insert(i as Entity, x, y, 9);
    }
    // Each rebuild waits for a quarter of the records to be new, so the builds
    // grow geometrically: a few dozen for 4000 inserts, not one per read.
    expect(build.mock.calls.length).toBeLessThan(40);
  });

  it("forgets the last frame on clear in both structures", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    const out: Entity[] = [];
    hash.insert(1 as Entity, 10, 10, 9);
    hash.query(10, 10, 20, out);
    expect(out).toEqual([1]);
    hash.clear();
    hash.query(10, 10, 20, out);
    expect(out).toEqual([]);
    hash.insert(2 as Entity, 10, 10, 9);
    hash.insert(3 as Entity, 5e6, 0, 9);
    hash.query(10, 10, 20, out);
    expect(readDense(hash)).toBe(false);
    expect(out).toEqual([2]);
    hash.clear();
    hash.insert(4 as Entity, 10, 10, 9);
    hash.query(10, 10, 20, out);
    expect(readDense(hash)).toBe(true);
    expect(out).toEqual([4]);
  });
});

describe("queryCandidates", () => {
  it("writes each candidate once, even across cells and repeat inserts", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    hash.insert(5 as Entity, 63, 0, 9);
    hash.insert(5 as Entity, 63, 0, 9);
    hash.insert(6 as Entity, 32, 32, 50);
    hash.insert(7 as Entity, 900, 900, 9);
    expect(candidates(hash, 60, 0, 20)).toEqual([5, 6]);
  });

  it("returns the broad phase: no distance test", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    // Same cell as the query point, well outside its radius.
    hash.insert(1 as Entity, 60, 60, 1);
    expect(candidates(hash, 2, 2, 1)).toEqual([1]);
  });

  it("writes through the bucket map when the spread is too wide to index", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    hash.insert(1 as Entity, 0, 0, 9);
    hash.insert(2 as Entity, 30, 0, 9);
    hash.insert(3 as Entity, 5e6, 0, 9);
    expect(candidates(hash, 0, 0, 40)).toEqual([1, 2]);
    expect(readDense(hash)).toBe(false);
  });

  it("writes nothing on an empty or cleared hash", () => {
    const hash = new SpatialHash(CELL, CAPACITY);
    expect(candidates(hash, 0, 0, 1e6)).toEqual([]);
    hash.insert(1 as Entity, 0, 0, 9);
    hash.clear();
    expect(candidates(hash, 0, 0, 1e6)).toEqual([]);
  });

  it("writes only the stamped entities when given a filter", () => {
    for (const straggler of [false, true]) {
      const hash = new SpatialHash(CELL, CAPACITY);
      hash.insert(1 as Entity, 64, 64, 9);
      hash.insert(2 as Entity, 70, 70, 9);
      hash.insert(3 as Entity, 50, 50, 9);
      if (straggler) hash.insert(9 as Entity, 5e6, 0, 9);
      const filter = new Int32Array(CAPACITY);
      filter[1] = 7;
      filter[3] = 7;
      filter[2] = 6;
      expect(candidates(hash, 64, 64, 30)).toEqual([1, 2, 3]);
      expect(filtered(hash, 64, 64, 30, filter, 7)).toEqual([1, 3]);
      expect(readDense(hash)).toBe(!straggler);
      // A filled buffer only counts the entities the filter lets through.
      expect(
        hash.queryCandidates(64, 64, 30, new Int32Array(2), filter, 7),
      ).toBe(2);
    }
  });

  it("throws rather than drop a candidate when the buffer fills up", () => {
    for (const straggler of [false, true]) {
      const hash = new SpatialHash(CELL, CAPACITY);
      for (let i = 0; i < 3; i++) hash.insert(i as Entity, 10 + i, 10, 9);
      if (straggler) hash.insert(9 as Entity, 5e6, 0, 9);
      expect(hash.queryCandidates(10, 10, 20, new Int32Array(3))).toBe(3);
      expect(readDense(hash)).toBe(!straggler);
      expect(() => hash.queryCandidates(10, 10, 20, new Int32Array(2))).toThrow(
        RangeError,
      );
    }
  });
});
