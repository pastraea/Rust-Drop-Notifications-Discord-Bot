import { logger } from "./logger.js";

/**
 * Ordered, idempotent graceful shutdown used by the bot entrypoint.
 */

export interface ShutdownStep {
    name: string;
    run: () => void | Promise<void>;
}

export interface ShutdownOptions {
    steps: ShutdownStep[];
    /** Upper bound for the whole shutdown before the process is forced to exit. */
    timeoutMs: number;
    exit: (code: number) => void;
    log?: (message: string) => void;
    logError?: (message: string, error: unknown) => void;
}

/**
 * Builds a shutdown function that runs each step once, in order. A failing step is logged and does not
 * prevent later steps (for example closing the database) from running. Repeated calls while a shutdown is
 * already in progress are ignored.
 */
export function createShutdown(options: ShutdownOptions) {
    const log = options.log ?? ((message: string) => logger.child("shutdown").info(message));
    const logError = options.logError ?? ((message: string, error: unknown) => logger.child("shutdown").error(message, error));
    let started = false;

    return async function shutdown(reason: string, exitCode = 0): Promise<void> {
        if (started) return;
        started = true;
        log(`Shutting down (${reason}).`);

        let failed = false;
        const timer = setTimeout(() => {
            logError(`Shutdown did not finish within ${options.timeoutMs}ms; forcing exit.`, undefined);
            options.exit(exitCode || 1);
        }, options.timeoutMs);
        timer.unref?.();

        for (const step of options.steps) {
            try {
                await step.run();
            } catch (error) {
                failed = true;
                logError(`Shutdown step failed: ${step.name}`, error);
            }
        }

        clearTimeout(timer);
        options.exit(exitCode !== 0 ? exitCode : failed ? 1 : 0);
    };
}
