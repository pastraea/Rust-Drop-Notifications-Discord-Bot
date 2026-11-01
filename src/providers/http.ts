/**
 * Shared HTTP helper for provider adapters.
 */

export interface RetryOptions {
    /** Total attempts including the first one. Defaults to 2. */
    maxAttempts?: number;
    /** Overrides the global fetch (resolved at call time so test mocks apply). */
    fetchImpl?: typeof fetch;
    /** Delay between attempts; overridable so tests do not wait. */
    sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 2;

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs a request, retrying transient failures (network errors and 5xx responses) with a short
 * jittered delay. Successful and 4xx responses are returned immediately, since retrying a client
 * error cannot help. After the final attempt the last failure is thrown.
 */
export async function fetchWithRetries(input: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const sleep = options.sleep ?? defaultSleep;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await (options.fetchImpl ?? fetch)(input, init);
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                return response;
            }

            lastError = new Error(`Request failed with status ${response.status}`);
        } catch (error) {
            lastError = error;
        }

        if (attempt < maxAttempts) {
            await sleep(250 + Math.random() * 250);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}
