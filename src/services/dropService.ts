import type { BotDb } from "../db.js";
import type { DropsProvider } from "../providers/base.js";
import type { Drop } from "../types.js";

/**
 * Drop synchronization service that merges provider output and reconciles ended campaigns.
 */

/**
 * Fetches drops from all providers, marks missing platform drops as ended, and upserts results.
 */
export async function syncDrops(db: BotDb, providers: DropsProvider[]): Promise<Drop[]> {
    const results = await Promise.all(providers.map((provider) => provider.fetchRustDrops()));
    const flattened = results.flat();

    const seenTwitch = new Set<string>();
    const seenKick = new Set<string>();
    for (const drop of flattened) {
        const platform = String(drop.platform).toLowerCase();
        if (platform === "twitch") {
            seenTwitch.add(drop.externalId);
        } else if (platform === "kick") {
            seenKick.add(drop.externalId);
        }
    }

    db.endMissingDropsForPlatform("twitch", Array.from(seenTwitch));
    db.endMissingDropsForPlatform("kick", Array.from(seenKick));

    return db.upsertDrops(flattened);
}
