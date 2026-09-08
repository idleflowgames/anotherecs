# Changelog

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
