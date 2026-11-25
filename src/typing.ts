/**
 * Repeating "typing" pulse for a running turn.
 *
 * Telegram's `sendChatAction("typing")` lasts ~5 s and Discord's
 * `sendTyping()` ~10 s, so a one-shot call disappears while the model works.
 * Failures are swallowed: a typing indicator must never break a turn.
 */
export class TypingPulse {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;

  constructor(
    private readonly send: () => unknown,
    private readonly intervalMs: number,
  ) {}

  get active(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.fire();
    this.timer = setInterval(() => void this.fire(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.send();
    } catch {
      /* typing is cosmetic */
    }
  }
}
