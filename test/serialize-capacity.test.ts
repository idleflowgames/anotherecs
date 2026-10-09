import { describe, expect, it } from "vitest";
import {
  type ComponentCodec,
  defineComponent,
  defineResource,
  Serializer,
  World,
} from "../src/index";

const CWord = defineComponent<number>("CapacityWord");
const RWord = defineResource<number>("CapacityResourceWord");
const wordCodec: ComponentCodec<number> = {
  write(view, offset, value) {
    view.setUint32(offset, value, true);
    return offset + 4;
  },
  read(view, offset) {
    return { value: view.getUint32(offset, true), offset: offset + 4 };
  },
};

const CContacts = defineComponent<number[]>("CapacityContacts");
const RContacts = defineResource<number[]>("CapacityResourceContacts");
const MAX_CONTACTS = 1203;
const CONTACT_BYTES = 2 + 8 * MAX_CONTACTS;
const contactCodec: ComponentCodec<number[]> = {
  maxBytes: CONTACT_BYTES,
  write(view, offset, value) {
    view.setUint16(offset, value.length, true);
    for (let i = 0; i < value.length; i++) {
      view.setFloat64(offset + 2 + i * 8, value[i], true);
    }
    return offset + 2 + value.length * 8;
  },
  read(view, offset) {
    const length = view.getUint16(offset, true);
    const value = Array.from({ length }, (_, i) =>
      view.getFloat64(offset + 2 + i * 8, true),
    );
    return { value, offset: offset + 2 + length * 8 };
  },
};

function words(values: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
  });
  return buffer;
}

describe("per-codec write capacity", () => {
  it("round-trips oversized components and resources through snapshots, deltas, and every baseline", () => {
    const serializer = () =>
      new Serializer()
        .register(CWord, wordCodec)
        .register(CContacts, contactCodec)
        .registerResource(RContacts, contactCodec);
    const source = new World();
    const entity = source.spawn();
    const contacts = Array.from({ length: MAX_CONTACTS }, (_, i) => i + 1);
    source.add(entity, CWord, 123);
    source.add(entity, CContacts, contacts);
    source.setResource(RContacts, contacts);
    const sender = serializer();
    const receiver = serializer();
    const restored = new World();
    receiver.restore(restored, sender.snapshot(source));
    expect(restored.get(entity, CContacts)).toEqual(contacts);
    expect(restored.getResource(RContacts)).toEqual(contacts);
    expect(receiver.delta(restored)).toEqual(sender.delta(source));

    const changed = contacts.map((value) => value * 2);
    source.add(entity, CContacts, changed);
    source.setResource(RContacts, changed);
    receiver.applyDelta(restored, sender.delta(source));
    expect(restored.get(entity, CContacts)).toEqual(changed);
    expect(restored.getResource(RContacts)).toEqual(changed);
    expect(receiver.snapshot(restored)).toEqual(sender.snapshot(source));
    expect(receiver.delta(restored)).toEqual(sender.delta(source));
  });

  it("keeps ordinary component/resource scratch at the serializer default", () => {
    const ordinaryScratch: number[] = [];
    const largeScratch: number[] = [];
    const small = {
      ...wordCodec,
      write(view: DataView, offset: number, value: number) {
        if (offset === 0) ordinaryScratch.push(view.byteLength);
        return wordCodec.write(view, offset, value);
      },
    };
    const large = {
      ...contactCodec,
      write(view: DataView, offset: number, value: number[]) {
        if (offset === 0) largeScratch.push(view.byteLength);
        return contactCodec.write(view, offset, value);
      },
    };
    const world = new World();
    const entity = world.spawn();
    world.add(entity, CWord, 123);
    world.add(entity, CContacts, [42]);
    world.setResource(RWord, 456);
    world.setResource(RContacts, [43]);
    const serializer = new Serializer()
      .register(CWord, small)
      .register(CContacts, large)
      .registerResource(RWord, small)
      .registerResource(RContacts, large);
    serializer.snapshot(world);
    serializer.delta(world);
    expect(ordinaryScratch.length).toBe(6);
    expect(largeScratch.length).toBe(6);
    expect(new Set(ordinaryScratch)).toEqual(new Set([4096]));
    expect(new Set(largeScratch)).toEqual(new Set([CONTACT_BYTES]));
  });

  it("preserves the version-1 snapshot and delta bytes with or without overrides", () => {
    for (const capacity of [undefined, 4, CONTACT_BYTES]) {
      const codec = { ...wordCodec, maxBytes: capacity };
      const serializer = new Serializer()
        .register(CWord, codec)
        .registerResource(RWord, codec);
      const world = new World();
      const entity = world.spawn();
      world.add(entity, CWord, 0x12345678);
      world.setResource(RWord, 99);
      // Existing format: header, entity row, versioned component, resources.
      const snapshot = words([
        0x41454353,
        1,
        1,
        1,
        entity,
        1,
        CWord.id,
        0,
        0x12345678,
        1,
        RWord.id,
        99,
      ]);
      expect(serializer.snapshot(world)).toEqual(snapshot);
      const restored = new World();
      serializer.restore(restored, snapshot);
      expect(restored.get(entity, CWord)).toBe(0x12345678);
      expect(restored.getResource(RWord)).toBe(99);

      world.add(entity, CWord, 10);
      world.setResource(RWord, 20);
      // Existing delta: removals, changed row, resource changes/removals.
      expect(serializer.delta(world)).toEqual(
        words([
          0x41454353,
          2,
          1,
          0,
          1,
          entity,
          1,
          0,
          CWord.id,
          0,
          10,
          1,
          RWord.id,
          20,
          0,
        ]),
      );
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid capacity %s before writing",
    (maxBytes) => {
      expect(() => new Serializer({ maxComponentBytes: maxBytes })).toThrow(
        /positive safe integer/,
      );
      expect(() =>
        new Serializer().register(CWord, { ...wordCodec, maxBytes }),
      ).toThrow(/positive safe integer/);
      expect(() =>
        new Serializer().registerResource(RWord, { ...wordCodec, maxBytes }),
      ).toThrow(/positive safe integer/);
    },
  );

  it.each([-1, 0.5, 5, NaN, Infinity])(
    "rejects invalid codec write length %s even when the backing buffer has spare room",
    (length) => {
      const bad = {
        ...wordCodec,
        maxBytes: 4,
        write: (_view: DataView, offset: number) => offset + length,
      };
      const world = new World();
      world.add(world.spawn(), CWord, 123);
      world.setResource(RWord, 456);
      expect(() =>
        new Serializer().register(CWord, bad).snapshot(world),
      ).toThrow(/write offset exceeds its capacity/);
      expect(() =>
        new Serializer().registerResource(RWord, bad).snapshot(world),
      ).toThrow(/write offset exceeds its capacity/);
    },
  );

  it("fails loudly if a component or resource physically writes past its capacity", () => {
    const contacts = Array.from({ length: MAX_CONTACTS + 1 }, (_, i) => i);
    const world = new World();
    world.add(world.spawn(), CContacts, contacts);
    world.setResource(RContacts, contacts);
    expect(() =>
      new Serializer().register(CContacts, contactCodec).snapshot(world),
    ).toThrow(RangeError);
    expect(() =>
      new Serializer()
        .registerResource(RContacts, contactCodec)
        .snapshot(world),
    ).toThrow(RangeError);
  });
});
