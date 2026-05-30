import { describe, expect, it } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  type Entity,
  MigrationError,
  MigrationRegistry,
  type MigrationStep,
  Serializer,
  World,
} from "../src/index";

interface Box {
  a: number;
}
const CBox = defineComponent<Box>("MigBox");

describe("MigrationRegistry.register", () => {
  it("assigns currentVersion === steps.length and rejects double-register", () => {
    const reg = new MigrationRegistry();
    const s0: MigrationStep = (p) => p;
    const s1: MigrationStep = (p) => p;
    reg.register(CBox, [s0, s1]);
    expect(reg.currentVersion(CBox)).toBe(2);
    expect(() => reg.register(CBox, [s0])).toThrow(/already registered/);
    const COther = defineComponent<Box>("MigBoxOther");
    expect(reg.currentVersion(COther)).toBe(0);
  });
});

describe("MigrationRegistry.migrate", () => {
  it("identity when storedVersion === currentVersion (same object, zero steps)", () => {
    const reg = new MigrationRegistry();
    let calls = 0;
    const s0: MigrationStep = (p) => {
      calls++;
      return p;
    };
    const s1: MigrationStep = (p) => {
      calls++;
      return p;
    };
    const C = defineComponent<Box>("MigIdentity");
    reg.register(C, [s0, s1]);
    const obj = { a: 1 };
    const out = reg.migrate(C.id, 2, obj);
    expect(out).toBe(obj);
    expect(calls).toBe(0);
  });

  it("runs every step in order from storedVersion to current", () => {
    const reg = new MigrationRegistry();
    const order: string[] = [];
    const s0: MigrationStep = (p) => {
      order.push("s0");
      return { ...p, b: 2 };
    };
    const s1: MigrationStep = (p) => {
      order.push("s1");
      const { b, ...rest } = p as { b: number };
      return { ...rest, c: b };
    };
    const C = defineComponent<Box>("MigChain");
    reg.register(C, [s0, s1]);
    const out = reg.migrate(C.id, 0, { a: 1 });
    expect(out).toEqual({ a: 1, c: 2 });
    expect(order).toEqual(["s0", "s1"]);
  });

  it("starts mid-chain when storedVersion is intermediate", () => {
    const reg = new MigrationRegistry();
    const order: string[] = [];
    const s0: MigrationStep = (p) => {
      order.push("s0");
      return { ...p, b: 2 };
    };
    const s1: MigrationStep = (p) => {
      order.push("s1");
      const { b, ...rest } = p as { b: number };
      return { ...rest, c: b };
    };
    const C = defineComponent<Box>("MigMid");
    reg.register(C, [s0, s1]);
    const out = reg.migrate(C.id, 1, { a: 1, b: 2 });
    expect(out).toEqual({ a: 1, c: 2 });
    expect(order).toEqual(["s1"]);
  });

  it("storedVersion > current throws MigrationError (save newer than code)", () => {
    const reg = new MigrationRegistry();
    const C = defineComponent<Box>("MigNewer");
    reg.register(C, [(p) => p]);
    expect(() => reg.migrate(C.id, 5, {})).toThrow(MigrationError);
    expect(() => reg.migrate(C.id, 5, {})).toThrow(/newer/);
  });

  it("negative / non-integer storedVersion throws MigrationError", () => {
    const reg = new MigrationRegistry();
    const C = defineComponent<Box>("MigCorrupt");
    reg.register(C, [(p) => p]);
    expect(() => reg.migrate(C.id, -1, {})).toThrow(MigrationError);
    expect(() => reg.migrate(C.id, -1, {})).toThrow(/non-negative integer/);
    expect(() => reg.migrate(C.id, 1.5, {})).toThrow(MigrationError);
    expect(() => reg.migrate(C.id, 1.5, {})).toThrow(/non-negative integer/);
  });

  it("rejects a non-object value when steps must run", () => {
    const reg = new MigrationRegistry();
    const C = defineComponent<Box>("MigScalar");
    reg.register(C, [(p) => p]);
    expect(() =>
      reg.migrate(C.id, 0, 5 as unknown as Record<string, unknown>),
    ).toThrow(MigrationError);
    expect(() =>
      reg.migrate(C.id, 0, 5 as unknown as Record<string, unknown>),
    ).toThrow(/non-object/);
  });

  it("uses the provided componentName in errors for an unregistered id", () => {
    const reg = new MigrationRegistry();
    expect(() => reg.migrate(999, 1, { a: 1 }, "MyComp")).toThrow(/MyComp/);
  });
});

describe("MigrationRegistry.register rejects empty chains", () => {
  it("throws on a zero-step chain", () => {
    const reg = new MigrationRegistry();
    const C = defineComponent<Box>("MigZeroStep");
    expect(() => reg.register(C, [])).toThrow(/no steps/);
  });
});

describe("MigrationRegistry.isEmpty", () => {
  it("reflects registration state", () => {
    const reg = new MigrationRegistry();
    expect(reg.isEmpty).toBe(true);
    const C = defineComponent<Box>("MigEmptyFlag");
    reg.register(C, [(p) => p]);
    expect(reg.isEmpty).toBe(false);
  });
});

describe("migration is pure (determinism)", () => {
  it("running migrate twice on equal inputs yields equal outputs", () => {
    const reg = new MigrationRegistry();
    const s0: MigrationStep = (p) => ({ ...p, b: 10 });
    const s1: MigrationStep = (p) => {
      const { b, ...rest } = p as { b: number };
      return { ...rest, c: b * 2 };
    };
    const C = defineComponent<Box>("MigPure");
    reg.register(C, [s0, s1]);
    const a = reg.migrate(C.id, 0, { a: 7 });
    const b = reg.migrate(C.id, 0, { a: 7 });
    expect(a).toEqual(b);
    expect(a).toEqual({ a: 7, c: 20 });
  });
});

interface PlayerV1 {
  hp: number;
}
const CPlayer = defineComponent<PlayerV1>("MigPlayer");
const playerCodec: ComponentCodec<PlayerV1> = {
  write(view, offset, c) {
    view.setInt32(offset, c.hp, true);
    return offset + 4;
  },
  read(view, offset) {
    return { value: { hp: view.getInt32(offset, true) }, offset: offset + 4 };
  },
};

describe("serializer empty-registry behavior", () => {
  it("no-migrations snapshot is byte-identical to an empty-registry snapshot", () => {
    const world = new World();
    for (let i = 0; i < 6; i++) {
      world.add(world.spawn(), CPlayer, { hp: 100 + i });
    }
    const plain = new Serializer()
      .register(CPlayer, playerCodec)
      .snapshot(world);
    const withEmpty = new Serializer({ migrations: new MigrationRegistry() })
      .register(CPlayer, playerCodec)
      .snapshot(world);
    expect([...new Uint8Array(withEmpty)]).toEqual([...new Uint8Array(plain)]);
  });
});

describe("serializer restore upgrades an old-version snapshot", () => {
  interface Stat extends Record<string, unknown> {
    hp: number;
    shield: number;
  }
  const CStat = defineComponent<Stat>("MigStat");
  const statCodec: ComponentCodec<Stat> = {
    write(view, offset, c) {
      view.setInt32(offset, c.hp, true);
      view.setInt32(offset + 4, c.shield, true);
      return offset + 8;
    },
    read(view, offset) {
      return {
        value: {
          hp: view.getInt32(offset, true),
          shield: view.getInt32(offset + 4, true),
        },
        offset: offset + 8,
      };
    },
    readVersioned(view, offset, version) {
      if (version === 0) {
        return {
          value: { hp: view.getInt32(offset, true) },
          offset: offset + 4,
        };
      }
      return this.read(view, offset);
    },
  };

  const v0Codec: ComponentCodec<Stat> = {
    write(view, offset, c) {
      view.setInt32(offset, c.hp, true);
      return offset + 4;
    },
    read(view, offset) {
      return {
        value: { hp: view.getInt32(offset, true), shield: 0 },
        offset: offset + 4,
      };
    },
  };

  it("restores to the current {hp, shield} shape and a forward step matches native", () => {
    const src = new World();
    src.add(src.spawn(), CStat, { hp: 50, shield: 0 });
    const v0Buf = new Serializer().register(CStat, v0Codec).snapshot(src);

    const reg = new MigrationRegistry();
    reg.register(CStat, [(p) => ({ ...p, shield: 25 })]);
    const ser = new Serializer({ migrations: reg }).register(CStat, statCodec);
    const dest = new World();
    ser.restore(dest, v0Buf);

    const e = dest.query(CStat)[0][0];
    expect(dest.get(e, CStat)).toEqual({ hp: 50, shield: 25 });

    const native = new World();
    native.add(native.spawn(), CStat, { hp: 50, shield: 25 });
    for (const [, s] of dest.query(CStat)) s.shield = Math.floor(s.shield / 2);
    for (const [, s] of native.query(CStat))
      s.shield = Math.floor(s.shield / 2);
    expect(dest.query(CStat).map(([, s]) => s)).toEqual(
      native.query(CStat).map(([, s]) => s),
    );
  });
});

describe("serializer restore remaps refFields against the MIGRATED shape", () => {
  interface Minion extends Record<string, unknown> {
    ownerEntity: number;
  }
  const CMinion = defineComponent<Minion>("MigMinion");
  const minionCodec: ComponentCodec<Minion> = {
    write(view, offset, c) {
      view.setUint32(offset, c.ownerEntity >>> 0, true);
      return offset + 4;
    },
    read(view, offset) {
      return {
        value: { ownerEntity: view.getUint32(offset, true) },
        offset: offset + 4,
      };
    },
    readVersioned(view, offset, version) {
      if (version === 0) {
        return {
          value: { owner: view.getUint32(offset, true) },
          offset: offset + 4,
        };
      }
      return this.read(view, offset);
    },
    refFields: ["ownerEntity"],
  };
  const v0Codec: ComponentCodec<Minion> = {
    write(view, offset, c) {
      view.setUint32(offset, (c.owner as number) >>> 0, true);
      return offset + 4;
    },
    read(view, offset) {
      return {
        value: { ownerEntity: view.getUint32(offset, true) },
        offset: offset + 4,
      };
    },
  };

  it("the migrated ownerEntity ref resolves to the relocated entity", () => {
    const src = new World();
    const owner = src.spawn();
    const minion = src.spawn();
    src.add(owner, CMinion, { owner: 0 } as unknown as Minion);
    src.add(minion, CMinion, { owner: owner as number } as unknown as Minion);
    const v0Buf = new Serializer().register(CMinion, v0Codec).snapshot(src);

    const reg = new MigrationRegistry();
    reg.register(CMinion, [
      (p) => {
        const { owner: o, ...rest } = p as { owner: number };
        return { ...rest, ownerEntity: o };
      },
    ]);
    const ser = new Serializer({ migrations: reg }).register(
      CMinion,
      minionCodec,
    );
    const dest = new World();
    for (let i = 0; i < 4; i++) dest.spawn();
    dest.clear();
    ser.restore(dest, v0Buf);

    const rows = dest.query(CMinion);
    const minionRow = rows.find(([, c]) => c.ownerEntity !== 0);
    expect(minionRow).toBeDefined();
    const [minionId, m] = minionRow as (typeof rows)[number];
    expect(m.ownerEntity).not.toBe(0);
    expect(m.ownerEntity).not.toBe(minionId);
    expect(dest.isAlive(m.ownerEntity as Entity)).toBe(true);
  });
});

describe("serializer restore fails loud on a versioned save with no registry", () => {
  it("throws MigrationError mentioning 'no MigrationRegistry'", () => {
    const reg = new MigrationRegistry();
    reg.register(CPlayer, [(p) => p, (p) => p]);
    const versioned = new Serializer({ migrations: reg }).register(
      CPlayer,
      playerCodec,
    );
    const world = new World();
    world.add(world.spawn(), CPlayer, { hp: 7 });
    const buf = versioned.snapshot(world);

    const noReg = new Serializer().register(CPlayer, playerCodec);
    expect(() => noReg.restore(new World(), buf)).toThrow(MigrationError);
    expect(() => noReg.restore(new World(), buf)).toThrow(
      /no MigrationRegistry/,
    );
  });

  it("a _version 0 blob with no registry succeeds", () => {
    const world = new World();
    world.add(world.spawn(), CPlayer, { hp: 9 });
    const buf = new Serializer().register(CPlayer, playerCodec).snapshot(world);
    const dest = new World();
    new Serializer().register(CPlayer, playerCodec).restore(dest, buf);
    expect(dest.query(CPlayer)[0][1]).toEqual({ hp: 9 });
  });
});

describe("serializer delta carries versions and round-trips through migration", () => {
  it("a delta with a registered chain applies to a clone", () => {
    const reg = new MigrationRegistry();
    reg.register(CPlayer, [(p) => p]);
    const live = new Serializer({ migrations: reg }).register(
      CPlayer,
      playerCodec,
    );
    const clone = new Serializer({ migrations: reg }).register(
      CPlayer,
      playerCodec,
    );

    const a = new World();
    const ids: Entity[] = [];
    for (let i = 0; i < 3; i++) {
      const e = a.spawn();
      a.add(e, CPlayer, { hp: i });
      ids.push(e);
    }
    const baseline = live.snapshot(a);
    const b = new World();
    clone.restore(b, baseline);

    a.add(ids[0], CPlayer, { hp: 999 });
    const d = live.delta(a);
    clone.applyDelta(b, d);

    const av = a
      .query(CPlayer)
      .map(([, v]) => v.hp)
      .sort((x, y) => x - y);
    const bv = b
      .query(CPlayer)
      .map(([, v]) => v.hp)
      .sort((x, y) => x - y);
    expect(bv).toEqual(av);
  });
});
