// Typed Event Bus: frame-scoped event queues
// Events emitted during a frame are readable by later systems in the same frame.
// Reads are non-destructive, so many systems may read one queue per frame. The
// consumer owns the frame lifecycle: clearAll() empties every queue at frame
// start, and the framework never emits or clears events on its own.

import type { EventType } from "./types";

export class EventBus {
  private readonly queues = new Map<number, unknown[]>();

  /** Emit an event. Subsequent systems can read it this frame. */
  emit<T>(type: EventType<T>, data: T): void {
    let queue = this.queues.get(type.id);
    if (!queue) {
      queue = [];
      this.queues.set(type.id, queue);
    }
    queue.push(data);
  }

  /**
   * Read all events of a given type emitted this frame. Non-destructive: many
   * systems may read the same queue in one frame. Returns the LIVE internal queue;
   * do not mutate it or retain it across frames (clearAll() empties it in place).
   * Use {@link readCopy} for a retainable snapshot.
   */
  read<T>(type: EventType<T>): ReadonlyArray<T> {
    return (this.queues.get(type.id) as T[] | undefined) ?? _empty;
  }

  /** Like {@link read} but returns a fresh array safe to mutate or retain across frames. */
  readCopy<T>(type: EventType<T>): T[] {
    const queue = this.queues.get(type.id) as T[] | undefined;
    return queue === undefined ? [] : queue.slice();
  }

  /** Check if any events of a given type were emitted this frame. */
  has<T>(type: EventType<T>): boolean {
    const queue = this.queues.get(type.id);
    return queue !== undefined && queue.length > 0;
  }

  /** Clear all event queues. Called at frame start. */
  clearAll(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
  }
}

const _empty: ReadonlyArray<never> = [];
