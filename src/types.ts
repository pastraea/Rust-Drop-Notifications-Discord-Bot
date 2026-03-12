/**
 * Shared domain types used across providers, persistence, and reminder flows.
 */
export type Platform = "twitch" | "kick";

/**
 * Stored user watch entry for legacy watch-based notification mode.
 */
export interface Watch {
    id: number;
    discordUserId: string;
    platform: Platform;
    streamer: string;
    game: string;
    enabled: 0 | 1;
    createdAt: string;
}

/**
 * Persisted drop campaign record.
 */
export interface Drop {
    id: number;
    platform: Platform;
    externalId: string;
    title: string;
    channels: string[];
    game: string;
    startTime: string;
    endTime: string;
    status: "upcoming" | "active" | "ended";
    lastSeen: string;
}

/**
 * Provider-normalized drop shape before database upsert.
 */
export interface NormalizedDrop {
    platform: Platform;
    externalId: string;
    title: string;
    channels?: string[];
    game: string;
    startTime: string;
    endTime: string;
    status: "upcoming" | "active" | "ended";
}
