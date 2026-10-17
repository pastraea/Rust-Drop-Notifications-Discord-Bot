/**
 * Helpers for formatting campaign channel summaries in announcement text.
 */
export type AnnouncementPlatform = "twitch" | "kick";

export interface AnnouncementDropChannels {
    platform: string;
    channels?: string[];
    hasGeneralDrops?: boolean;
}

export function hasListedDropChannels(drop: AnnouncementDropChannels): boolean {
    return Boolean(drop.hasGeneralDrops || drop.channels?.some((channel) => channel.trim()));
}

export function getDropChannelConfidence(drop: AnnouncementDropChannels): "listed" | "unknown" {
    return hasListedDropChannels(drop) ? "listed" : "unknown";
}

export function getChannelsSummaryForDrop(drop: AnnouncementDropChannels): string {
    const channels = Array.from(new Set((drop.channels ?? []).map((value) => value.trim()).filter(Boolean)));
    const summaries: string[] = [];
    if (drop.hasGeneralDrops && drop.platform.toLowerCase() === "twitch") {
        summaries.push("General drops: any drops-enabled Rust stream (https://www.twitch.tv/directory/all/tags/Rust)");
    }
    if (channels.length > 0) {
        const baseUrl = getAnnouncementPlatformBaseUrl(drop.platform);
        summaries.push(`Streamer drops: ${channels.map((channel) => `${channel} (${baseUrl}/${channel})`).join(", ")}`);
    }
    return summaries.length > 0 ? summaries.join("\n") : getAnnouncementChannelsSummary(drop.platform);
}

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
