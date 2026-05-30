import type { CommandBuffer } from "./command-buffer";
import type { System, World } from "./types";

interface SystemGroup {
  label: string;
  systems: System[];
}

export interface ScheduleConfig {
  /** Flush deferred despawns after every group. Default true. */
  flushBetweenGroups?: boolean;
  /**
   * When set, this CommandBuffer is applied (world.applyCommands) after each
   * group's systems run and BEFORE the per-group flush(). Lets systems record
   * deferred add/remove and have them applied at the group boundary. Default
   * undefined: no command buffer.
   */
  commandBuffer?: CommandBuffer;
}

export class Schedule {
  private readonly groups: SystemGroup[] = [];
  private readonly flushBetweenGroups: boolean;
  private readonly commandBuffer: CommandBuffer | undefined;

  constructor(config?: ScheduleConfig) {
    this.flushBetweenGroups = config?.flushBetweenGroups ?? true;
    this.commandBuffer = config?.commandBuffer;
  }

  /** Add a named group of systems to the end of the schedule. */
  addGroup(label: string, ...systems: System[]): this {
    this.groups.push({ label, systems });
    return this;
  }

  /** Run all system groups in order. Flushes between groups per the policy. */
  run(world: World, dt = 1): void {
    for (const group of this.groups) {
      for (const system of group.systems) {
        system(world, dt);
      }
      if (this.commandBuffer !== undefined)
        world.applyCommands(this.commandBuffer);
      if (this.flushBetweenGroups) world.flush();
    }
  }

  private requireLabel(label: string): void {
    for (const g of this.groups) if (g.label === label) return;
    throw new Error(`Schedule: no group labeled "${label}"`);
  }

  /** Run groups up to and including the named group. */
  runUpTo(world: World, upToLabel: string, dt = 1): void {
    this.requireLabel(upToLabel);
    for (const group of this.groups) {
      for (const system of group.systems) {
        system(world, dt);
      }
      if (this.commandBuffer !== undefined)
        world.applyCommands(this.commandBuffer);
      if (this.flushBetweenGroups) world.flush();
      if (group.label === upToLabel) break;
    }
  }

  /** Run groups starting from (exclusive) the named group. */
  runFrom(world: World, afterLabel: string, dt = 1): void {
    this.requireLabel(afterLabel);
    let started = false;
    for (const group of this.groups) {
      if (!started) {
        if (group.label === afterLabel) started = true;
        continue;
      }
      for (const system of group.systems) {
        system(world, dt);
      }
      if (this.commandBuffer !== undefined)
        world.applyCommands(this.commandBuffer);
      if (this.flushBetweenGroups) world.flush();
    }
  }

  /** Get group labels (for debugging). */
  getGroupLabels(): string[] {
    return this.groups.map((g) => g.label);
  }

  /**
   * Build a single-group schedule from a priority-sorted system list,
   * preserving exact order (stable sort on priority). Defaults to
   * flushBetweenGroups=false (overridable via `config`) with one group "main":
   * a convenient entry point when porting a priority-number scheduler.
   */
  static fromPriorityList(
    systems: { priority: number; update: System }[],
    config?: ScheduleConfig,
  ): Schedule {
    const schedule = new Schedule({ flushBetweenGroups: false, ...config });
    const ordered = systems
      .map((s, index) => ({ s, index }))
      .sort((a, b) => a.s.priority - b.s.priority || a.index - b.index)
      .map((w) => w.s.update);
    schedule.addGroup("main", ...ordered);
    return schedule;
  }
}
