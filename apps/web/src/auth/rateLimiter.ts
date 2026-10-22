// A small admin tool with few users: an in-memory per-IP counter is enough, no Redis needed.
// Resets on process restart, which is an acceptable tradeoff for this scope.
export class LoginRateLimiter {
    private readonly attempts = new Map<string, { count: number; resetAt: number }>();
    constructor(private readonly maxAttempts = 5, private readonly windowMs = 15 * 60_000, private readonly now: () => number = Date.now) {}

    isLocked(key: string): boolean {
        const entry = this.attempts.get(key);
        return !!entry && entry.count >= this.maxAttempts && entry.resetAt > this.now();
    }

    recordFailure(key: string): void {
        const current = this.now();
        const entry = this.attempts.get(key);
        if (!entry || entry.resetAt <= current) { this.attempts.set(key, { count: 1, resetAt: current + this.windowMs }); return; }
        entry.count += 1;
    }

    recordSuccess(key: string): void {
        this.attempts.delete(key);
    }
}
