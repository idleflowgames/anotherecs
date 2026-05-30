// Compile-time type assertions, verified by `pnpm typecheck`. The filename does
// not match vitest's `*.test.ts` run glob, so these are never executed; the
// `@ts-expect-error` lines fail the typecheck if they ever *stop* being errors.
//
// Factory-only APIs (addComponent, enablePooling) reject no-factory components
// at compile time.

import {
  type ComponentType,
  defineComponent,
  defineEvent,
  defineResource,
  type Entity,
  type ResourceType,
  World,
} from "../src/index";

const world = new World();
const e = 1 as Entity;

const Tag = defineComponent<{ hp: number }>("TypeSafetyTag");
const Pooled = defineComponent(
  "TypeSafetyPooled",
  () => ({ hp: 0 }),
  (c) => {
    c.hp = 0;
  },
);

// @ts-expect-error: a no-factory component is not a PooledComponentType.
world.addComponent(e, Tag, { hp: 1 });
// @ts-expect-error: pooling requires a reset hook (PooledComponentType).
world.enablePooling(Tag);

world.addComponent(e, Pooled, { hp: 1 });
world.enablePooling(Pooled);
world.add(e, Tag, { hp: 1 });

// Per-kind nominal brand: component / resource / event tokens are mutually
// non-assignable, so cross-subsystem misuse is a compile error.
const Res = defineResource<number>("TypeSafetyRes");
const Evt = defineEvent<number>("TypeSafetyEvt");
const Comp = defineComponent<number>("TypeSafetyComp");

// @ts-expect-error: a ResourceType is not a ComponentType.
const _c: ComponentType<number> = Res;
// @ts-expect-error: a ComponentType is not a ResourceType.
const _r: ResourceType<number> = Comp;
// @ts-expect-error: an EventType cannot be added as a component.
world.add(e, Evt, 1);
// @ts-expect-error: a ComponentType cannot be set as a resource.
world.setResource(Comp, 1);
