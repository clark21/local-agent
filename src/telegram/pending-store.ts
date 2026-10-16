import { randomBytes } from 'node:crypto';

/**
 * Short-lived state behind inline-keyboard buttons. Telegram limits
 * callback_data to 64 bytes, so buttons carry a random token instead.
 */
export class PendingStore<T extends { chatId: number; userId: number }> {
  private readonly entries = new Map<string, { value: T; timer: NodeJS.Timeout }>();

  constructor(private readonly ttlMs: number) {}

  add(value: T): string {
    const token = randomBytes(6).toString('hex');
    const timer = setTimeout(() => this.delete(token), this.ttlMs);
    timer.unref();
    this.entries.set(token, { value, timer });
    return token;
  }

  get(token: string): T | undefined {
    return this.entries.get(token)?.value;
  }

  delete(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(token);
  }

  clear(): void {
    for (const token of [...this.entries.keys()]) this.delete(token);
  }
}
