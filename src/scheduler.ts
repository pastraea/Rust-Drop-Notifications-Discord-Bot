import type { Client } from "discord.js";
import type { BotDb } from "./db.js";
import type { DropsProvider } from "./providers/base.js";
import { syncDrops } from "./services/dropService.js";
import { sendActiveDropReminders } from "./services/reminderService.js";

/**
 * Scheduler orchestration for syncing drops and sending reminder announcements.
 */

/**
 * Dependencies required by the scheduler loop.
 */
export interface SchedulerDeps {
    client: Client;
    db: BotDb;
    providers: DropsProvider[];
    intervalMs: number;
    envChannelId?: string;
}

/**
 * Optional behavior modifiers for one cycle execution.
 */
export interface RunCycleOptions {
    forceAnnounce?: boolean;
    forceAnnounceMode?: "verified" | "full";
}

/**
 * Runs one full drops cycle: provider sync then reminder dispatch.
 */
export async function runDropsCycle(deps: SchedulerDeps, options?: RunCycleOptions) {
    await syncDrops(deps.db, deps.providers);
    await sendActiveDropReminders(deps.client, deps.db, deps.envChannelId, {
        forceAnnounce: options?.forceAnnounce,
        forceAnnounceMode: options?.forceAnnounceMode,
        intervalMs: deps.intervalMs
    });
}

/**
 * Starts the recurring scheduler and executes one immediate initial cycle.
 */
export function startScheduler(deps: SchedulerDeps) {
    let cycleInFlight = false;
    let lastCleanupAtMs = 0;
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const NOTIFICATION_RETENTION_DAYS = 60;

    const runCycleSafely = async (label: string) => {
        if (cycleInFlight) {
            console.warn(`Skipping ${label} drop cycle because previous cycle is still running.`);
            return;
        }

        cycleInFlight = true;
        const startMs = Date.now();
        try {
            await runDropsCycle(deps);

            const now = Date.now();
            if (now - lastCleanupAtMs >= CLEANUP_INTERVAL_MS) {
                lastCleanupAtMs = now;
                const pruned = deps.db.pruneOldNotificationHistory(NOTIFICATION_RETENTION_DAYS);
                if (pruned.userNotificationsDeleted > 0 || pruned.watchNotificationsDeleted > 0) {
                    console.log(
                        `Pruned old notifications: user=${pruned.userNotificationsDeleted}, watch=${pruned.watchNotificationsDeleted}`
                    );
                }
            }

            const durationMs = Date.now() - startMs;
            console.log(`Drop cycle (${label}) completed in ${durationMs}ms.`);
        } finally {
            cycleInFlight = false;
        }
    };

    void runCycleSafely("initial").catch((error) => {
        console.error("Initial drop cycle failed:", error);
    });

    return setInterval(() => {
        void runCycleSafely("scheduled").catch((error) => {
            console.error("Scheduled drop cycle failed:", error);
        });
    }, deps.intervalMs);
}
