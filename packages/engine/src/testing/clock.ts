/*
 * A clock a test moves by hand. The engine takes its time as `now: () => Date` (publishing, editing,
 * comments) or as a `Date` (scheduling, metrics); `now` fits the first and `date` the second, and
 * each answer is a fresh Date so nothing the engine does to one changes the clock.
 */

export class FakeClock {
  #ms: number;

  constructor(start: Date | string = '2026-11-03T09:00:00.000Z') {
    this.#ms = new Date(start).getTime();
  }

  /** The current time; bound, so it can be handed over as `now` */
  readonly now = (): Date => new Date(this.#ms);

  get date(): Date {
    return this.now();
  }

  get iso(): string {
    return this.now().toISOString();
  }

  set(to: Date | string): this {
    this.#ms = new Date(to).getTime();
    return this;
  }

  advance(by: { ms?: number; minutes?: number; hours?: number; days?: number }): this {
    this.#ms += (by.ms ?? 0) + (by.minutes ?? 0) * 60_000 + (by.hours ?? 0) * 3_600_000 + (by.days ?? 0) * 86_400_000;
    return this;
  }

  /** A moment relative to now, without moving the clock: `clock.in({ hours: 2 })` */
  in(by: { minutes?: number; hours?: number; days?: number }): Date {
    return new Date(this.#ms + (by.minutes ?? 0) * 60_000 + (by.hours ?? 0) * 3_600_000 + (by.days ?? 0) * 86_400_000);
  }
}
