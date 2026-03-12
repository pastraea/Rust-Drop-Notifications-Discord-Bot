/**
 * Helpers for formatting campaign channel summaries in announcement text.
 */
export type AnnouncementPlatform = "twitch" | "kick";

const DEFAULT_ANNOUNCEMENT_STREAMERS: Record<AnnouncementPlatform, string[]> = {
    twitch: [],
    kick: []
};

/**
 * Returns configured announcement streamers for the requested platform.
 */
export function getAnnouncementStreamers(platform: string): string[] {
    const normalized = platform.toLowerCase();
    if (normalized === "twitch") {
        return DEFAULT_ANNOUNCEMENT_STREAMERS.twitch;
    }

    if (normalized === "kick") {
        return DEFAULT_ANNOUNCEMENT_STREAMERS.kick;
    }

    return [];
}

/**
 * Returns the canonical profile base URL for a platform.
 */
export function getAnnouncementPlatformBaseUrl(platform: string): string {
    const normalized = platform.toLowerCase();
    if (normalized === "kick") {
        return "https://kick.com";
    }

    return "https://twitch.tv";
}

/**
 * Builds channel summary text for announcement payloads.
 */
export function getAnnouncementChannelsSummary(platform: string): string {
    const baseUrl = getAnnouncementPlatformBaseUrl(platform);
    const streamers = getAnnouncementStreamers(platform);

    if (streamers.length === 0) {
        const officialCampaignUrl =
            String(platform).toLowerCase() === "kick"
                ? "https://kick.facepunch.com/"
                : "https://twitch.facepunch.com/";

        return `none yet (participating channels are not published for this window; check ${officialCampaignUrl})`;
    }

    return streamers.map((streamer) => `${streamer} (${baseUrl}/${streamer})`).join(", ");
}
