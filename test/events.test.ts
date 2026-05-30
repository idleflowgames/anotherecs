import { beforeEach, describe, expect, it } from "vitest";
import { defineEvent, EventBus } from "../src/index";

interface Beat {
  index: number;
}
const EBeat = defineEvent<Beat>("Beat");
const EWallCleared = defineEvent<void>("WallCleared");
const EOther = defineEvent<number>("Other");

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

describe("emit / read / has", () => {
  it("read returns all events emitted this frame in order", () => {
    bus.emit(EBeat, { index: 1 });
    bus.emit(EBeat, { index: 2 });
    expect(bus.read(EBeat)).toEqual([{ index: 1 }, { index: 2 }]);
    expect(bus.has(EBeat)).toBe(true);
  });

  it("read on an unused queue returns empty and has() is false", () => {
    expect(bus.read(EOther)).toEqual([]);
    expect(bus.has(EOther)).toBe(false);
  });

  it("void events: emit then has/read", () => {
    expect(bus.has(EWallCleared)).toBe(false);
    bus.emit(EWallCleared, undefined);
    expect(bus.has(EWallCleared)).toBe(true);
    expect(bus.read(EWallCleared)).toHaveLength(1);
  });
});

describe("non-destructive reads", () => {
  it("multiple reads in the same frame see the same events", () => {
    bus.emit(EWallCleared, undefined);
    const first = bus.read(EWallCleared);
    const second = bus.read(EWallCleared);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe("clearAll (frame start)", () => {
  it("clears all queues", () => {
    bus.emit(EBeat, { index: 1 });
    bus.emit(EOther, 5);
    bus.clearAll();
    expect(bus.has(EBeat)).toBe(false);
    expect(bus.has(EOther)).toBe(false);
    expect(bus.read(EBeat)).toEqual([]);
  });

  it("queues are reusable after clearAll", () => {
    bus.emit(EOther, 1);
    bus.clearAll();
    bus.emit(EOther, 2);
    expect(bus.read(EOther)).toEqual([2]);
  });
});
