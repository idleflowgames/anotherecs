# Changelog

## Unreleased

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
