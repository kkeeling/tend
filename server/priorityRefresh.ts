type PriorityDomain = {
  refreshWorkspacePrioritiesWithResult(): Promise<{ changed: boolean }>;
  nextWorkspacePriorityBoundary(now?: Date): Promise<Date | null>;
};

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export class PriorityRefreshWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private refreshPending = false;
  private boundaryPending = false;
  private schedulePending = false;
  private stopped = true;

  constructor(
    private readonly domain: PriorityDomain,
    private readonly notify: (data: unknown) => void | Promise<void>,
    private readonly options: {
      now?: () => Date;
      onError?: (error: unknown) => void;
      retryMs?: number;
    } = {},
  ) {}

  start(): Promise<void> {
    if (!this.stopped) return this.current ?? Promise.resolve();
    this.stopped = false;
    return this.requestSchedule();
  }

  requestSchedule(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.clearTimer();
    this.schedulePending = true;
    return this.drain();
  }

  runOnce(): Promise<void> {
    if (this.stopped) this.stopped = false;
    this.refreshPending = true;
    return this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.refreshPending = false;
    this.boundaryPending = false;
    this.schedulePending = false;
    this.clearTimer();
    await this.current;
  }

  private drain(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.runPending()
      .catch((error) => this.handleFailure(error))
      .finally(() => {
        this.current = null;
        if (!this.stopped && !this.timer && (this.refreshPending || this.schedulePending)) void this.drain();
      });
    return this.current;
  }

  private async runPending(): Promise<void> {
    do {
      const shouldRefresh = this.refreshPending;
      const boundaryTriggered = this.boundaryPending;
      this.refreshPending = false;
      this.boundaryPending = false;
      this.schedulePending = false;

      try {
        if (shouldRefresh) {
          const result = await this.domain.refreshWorkspacePrioritiesWithResult();
          if (!this.stopped && (result.changed || boundaryTriggered)) {
            await this.notify({ changedAt: this.now().toISOString(), source: "priority-boundary" });
          }
        }
        if (!this.stopped) await this.armNextBoundary();
      } catch (error) {
        this.refreshPending ||= shouldRefresh;
        this.boundaryPending ||= boundaryTriggered;
        this.schedulePending = true;
        throw error;
      }
    } while (!this.stopped && (this.refreshPending || this.schedulePending));
  }

  private async armNextBoundary(): Promise<void> {
    this.clearTimer();
    const now = this.now();
    const boundary = await this.domain.nextWorkspacePriorityBoundary(now);
    if (this.stopped || !boundary) return;
    const delay = Math.max(1, boundary.getTime() - now.getTime());
    if (delay > MAX_TIMER_DELAY_MS) {
      this.timer = setTimeout(() => void this.requestSchedule(), MAX_TIMER_DELAY_MS);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.boundaryPending = true;
      this.refreshPending = true;
      void this.drain();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private handleFailure(error: unknown): void {
    if (this.stopped) return;
    try {
      this.options.onError?.(error);
    } catch (handlerError) {
      console.error("[priority-refresh] error handler failed:", handlerError);
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedulePending = true;
      void this.drain();
    }, this.options.retryMs ?? 1_000);
  }
}
