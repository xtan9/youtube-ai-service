import type { AdmissionClock } from "../lib/resource-limits.js";

export class ManualClock implements AdmissionClock {
  private currentTime = 0;
  private readonly deadlines = new Set<{
    readonly dueAt: number;
    readonly callback: () => void;
  }>();

  now(): number {
    return this.currentTime;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const deadline = { dueAt: this.currentTime + delayMs, callback };
    this.deadlines.add(deadline);
    return () => this.deadlines.delete(deadline);
  }

  advanceBy(milliseconds: number): void {
    this.currentTime += milliseconds;
    for (const deadline of [...this.deadlines]) {
      if (deadline.dueAt <= this.currentTime) {
        this.deadlines.delete(deadline);
        deadline.callback();
      }
    }
  }
}
