# Benchmarks

Throughput micro-benchmarks for the library's performance-oriented design
choices. Run with:

```bash
pnpm bench
pnpm exec vitest bench --run path/to/file.bench.ts
```

Files:

- **`change-tracking.bench.ts`**: tracked vs untracked component deltas,
  `clearChanges`, and `getMut`.
- **`command-buffer.bench.ts`**: buffered structural mutation replay compared
  with immediate world mutations.
- **`entity-refs.bench.ts`**: entity reference packing, dereferencing,
  back-reference registration, and despawn sweep cost.
- **`generations.bench.ts`**: handle generation round-trips and despawn flush
  overhead.
- **`incremental-query.bench.ts`**: maintained incremental queries compared with
  rebuilt compiled queries after mutation.
- **`local-state.bench.ts`**: per-system local state access compared with typed
  resources.
- **`migration.bench.ts`**: component migration chains and serializer restore
  with migration registries.
- **`pooling.bench.ts`**: spawn/add/despawn churn with component pooling on vs
  off.
- **`query-filters.bench.ts`**: `select`, `without`, higher-arity `each`, and
  pair iteration helpers.
- **`query.bench.ts`**: cached queries, tuple-free iteration, compiled handles,
  bitmask membership, zero-sized tags, and cache invalidation behavior.
- **`serialize.bench.ts`**: full snapshots, restores, deltas, and JSON vs binary
  codecs.
- **`spatial-dedup.bench.ts`**: spatial hash query deduplication strategies.
- **`storage.bench.ts`**: sparse-set `ComponentStore` compared with
  `Map<Entity, T>` storage.
- **`store-indexing.bench.ts`**: component store lookup through maps compared
  with array indexing.
