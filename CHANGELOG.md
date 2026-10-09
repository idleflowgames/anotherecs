# Changelog

## 0.1.9

- `ComponentCodec` and `ResourceCodec` accept an optional `maxBytes` write
  capacity. Large codecs can reserve sufficient space without increasing the
  scratch allocation for every other component or resource. Omitted, the
  existing `SerializerOptions.maxComponentBytes` default of 4096 still applies.
  Snapshot and delta bytes are unchanged; capacity is not serialized.
- Invalid capacities and codec write offsets outside the reserved capacity now
  throw `RangeError`, including offsets that would otherwise silently truncate
  or corrupt the output.

## 0.1.8

- `SpatialHash`: reads go through a dense cell index. `insert` now only
  records the entity and the cell box it covers. The first read after a write
  lays the occupied cell rectangle out column-major as offsets into one flat
  entity array, so a query reads plain arrays instead of probing a bucket map
  per cell. A spread the index cannot lay out (over 65,536 cells, sparser than
  4,096 cells plus 16 per filed entry, or cell coordinates past 2^20) falls back
  to the bucket map, filed incrementally from the same records. Reads
  interleaved with inserts rebuild the index only once a quarter of the records
  are new, and read the map in between.
- `query` and `queryRadius` results are unchanged in membership AND in order. A
  randomized differential test against the frozen 0.1.7 implementation pins
  this, covering interleaved reads, the bucket-map fallback, NaN coordinates,
  negative radii and repeat inserts.
- New `SpatialHash.queryCandidates(x, y, radius, out, filter?, stamp?)`:
  writes the entities `query` returns, in the same order, to a caller's
  `Int32Array` and returns how many it wrote, so a caller can run its own narrow
  phase over a typed buffer with no callback per candidate. With a stamp filter
  it writes only entities whose `filter[entity] === stamp`, skipping the rest
  before any other work. A buffer of `maxEntities` always has room; a shorter
  one that fills up throws a `RangeError`.
- A whole broadphase frame (`bench/spatial-hash.bench.ts`) is 1.81x faster at
  50 bodies, 1.91x at 250 and 1.66x at 1000 than 0.1.7.

## 0.1.7

- Update development dependencies and pnpm 12; migrate benchmarks to Vitest 5
  test-context fixtures and grouped comparisons.
- Give the demo a named main landmark to satisfy the updated accessibility lint.
- Add regression coverage proving custom snapshot order leaves subsequent
  delta serialization canonical.

## 0.1.6

- `Serializer`: new opt-in `SerializerOptions.entityOrder` — a consumer-supplied
  row-emission order for `snapshot()`, validated as a permutation of the alive
  union (short, duplicated, or foreign sets throw). `restore()` already replays
  rows in file order, so emitting a store's entities in dense (swap-delete)
  order preserves that store's dense-array iteration order byte-exactly across
  a round-trip. Omitted, snapshots keep the canonical ascending-index order and
  are byte-identical to 0.1.5; the delta paths always use ascending order.
  Trade-off named in the module header: a custom order gives up cross-history
  snapshot canonicality in exchange for order preservation through restore.

## 0.1.5

- No source changes. Toolchain/deps only: Biome 2.5.6, Vite 8.1.5, Vitest
  4.1.10, Playwright 1.62.0, pnpm 11.18.0, Node engines floor 24.18.1. The
  Biome config schema pin now tracks the installed version.

## 0.1.4

- `SpatialHash`: `clear()` is now O(1). Buckets carry a frame stamp and a live
  prefix count, so a stamp bump retires the whole grid and a periodic sweep
  reclaims dead buckets. Queries additionally clamp their cell span to an
  occupied bounding box and a per-column occupied row range, both supersets of
  the true occupied set, so they only ever skip cells that are provably empty.
  Szudzik pairing is inlined at its three call sites with its cx-only half
  hoisted out of the inner loop.
  Result arrays are unchanged in membership AND in order, so a consumer that
  relies on iteration order for determinism is unaffected.
  A whole broadphase frame is 2.32x faster at 50 bodies, 1.90x at 250 and 1.13x
  at 1000; a 253k-op trace recorded from a real game run replays 48% faster.

## 0.1.2

- No source changes. Toolchain/deps only: Node 24, pnpm 11.5.0, lock-file
  maintenance, demo docs. Cut so downstreams can pin a registry version instead
  of a `file:` link.

## 0.1.1

## 0.1.0

- Initial public release of `@idleflowgames/anotherecs`.
