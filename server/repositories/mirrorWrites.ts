type MirrorWrite = () => Promise<void>;

export class MirrorWriteCoordinator {
  private pending: MirrorWrite[] | null = null;
  private failed = false;

  constructor(private readonly onFailure?: (error: unknown) => void) {}

  begin(): void {
    if (this.pending) throw new Error("A mirror transaction is already active.");
    this.pending = [];
  }

  async write(callback: MirrorWrite): Promise<void> {
    if (this.pending) {
      this.pending.push(callback);
      return;
    }
    await this.publish(callback);
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      const result = await callback();
      await this.commit();
      return result;
    } catch (error) {
      this.pending = null;
      throw error;
    }
  }

  private async commit(): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new Error("No mirror transaction is active.");
    this.pending = null;
    for (const write of pending) {
      await this.publish(write);
    }
  }

  hasFailures(): boolean {
    return this.failed;
  }

  private async publish(write: MirrorWrite): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.failed = true;
      let markerError: unknown;
      try {
        this.onFailure?.(error);
      } catch (failure) {
        markerError = failure;
      }
      console.error("SQLite committed, but a filesystem mirror write failed:", error);
      if (markerError) console.error("Tend also failed to persist the mirror-repair marker:", markerError);
    }
  }
}
