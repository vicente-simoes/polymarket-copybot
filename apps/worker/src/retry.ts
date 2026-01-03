// Retry utilities with exponential backoff
import pino from 'pino';

const logger = pino({ name: 'retry' });

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterMs?: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterMs: 500,
};

/**
 * Sleep for a specified duration with optional jitter
 */
export function sleep(ms: number, jitterMs: number = 0): Promise<void> {
    const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
    return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoff(attempt: number, options: RetryOptions): number {
    const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt),
        options.maxDelayMs
    );
    return delay;
}

/**
 * Execute a function with exponential backoff retry
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options: Partial<RetryOptions> = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt < opts.maxRetries) {
                const delay = calculateBackoff(attempt, opts);
                logger.warn({
                    label,
                    attempt: attempt + 1,
                    maxRetries: opts.maxRetries,
                    delayMs: delay,
                    error: lastError.message,
                }, 'Retrying after error');

                await sleep(delay, opts.jitterMs);
            }
        }
    }

    logger.error({
        label,
        maxRetries: opts.maxRetries,
        error: lastError?.message,
    }, 'All retries exhausted');

    throw lastError;
}

/**
 * Execute a function with circuit breaker pattern
 * After consecutive failures, pause for a longer period
 */
export class CircuitBreaker {
    private failureCount = 0;
    private lastFailure: Date | null = null;
    private isOpen = false;

    constructor(
        private readonly threshold: number = 5,
        private readonly resetTimeMs: number = 60000
    ) { }

    async execute<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
        // Check if circuit is open
        if (this.isOpen) {
            const timeSinceFailure = this.lastFailure
                ? Date.now() - this.lastFailure.getTime()
                : Infinity;

            if (timeSinceFailure < this.resetTimeMs) {
                logger.debug({ label, remainingMs: this.resetTimeMs - timeSinceFailure }, 'Circuit open, skipping');
                return null;
            }

            // Try to close circuit
            logger.info({ label }, 'Circuit breaker: attempting reset');
            this.isOpen = false;
        }

        try {
            const result = await fn();
            // Success - reset failure count
            this.failureCount = 0;
            return result;
        } catch (error) {
            this.failureCount++;
            this.lastFailure = new Date();

            if (this.failureCount >= this.threshold) {
                this.isOpen = true;
                logger.error({
                    label,
                    failureCount: this.failureCount,
                    resetTimeMs: this.resetTimeMs,
                }, 'Circuit breaker: OPEN');
            }

            throw error;
        }
    }

    getStatus() {
        return {
            isOpen: this.isOpen,
            failureCount: this.failureCount,
            lastFailure: this.lastFailure,
        };
    }
}
