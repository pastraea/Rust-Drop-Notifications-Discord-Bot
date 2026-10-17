import type { DropsProvider } from "./base.js";
import type { NormalizedDrop } from "../types.js";

/**
 * Twitch drops provider using official Facepunch campaign details with a Helix fallback.
 */

interface TwitchProviderOptions {
    useMockData: boolean;
    clientId?: string;
    clientSecret?: string;
}

const TWITCH_FACEPUNCH_URL = "https://twitch.facepunch.com/";
const COUNTDOWN_REGEX = /setupCountdown\(\s*['\"]\.campaign-(\d+)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi;

interface TwitchAppTokenResponse {
    access_token: string;
    expires_in: number;
}

interface TwitchGamesResponse {
    data: Array<{ id: string }>;
}

interface TwitchCampaignChannel {
    id?: string;
    name?: string;
    display_name?: string;
    broadcaster_name?: string;
    broadcaster_login?: string;
    login?: string;
}

interface TwitchDropsCampaign {
    id: string;
    name?: string;
    status?: string;
    starts_at?: string;
    ends_at?: string;
    allow?: {
        channels?: TwitchCampaignChannel[];
    };
    channels?: TwitchCampaignChannel[];
    allowed_channels?: TwitchCampaignChannel[];
}

interface TwitchDropsCampaignsResponse {
    data: TwitchDropsCampaign[];
}

/**
 * Twitch provider that reads participating channels from the official campaign page.
 */
export class TwitchDropsProvider implements DropsProvider {
    readonly platform = "twitch" as const;
    private cachedToken?: { value: string; expiresAtMs: number };
    private hasWarnedMissingCreds = false;
    private sourceStatus = "live (Facepunch campaign page)";

    /** Creates a Twitch provider with runtime flags and optional API credentials. */
    constructor(private readonly options: TwitchProviderOptions) { }

    /** Uses Facepunch as the authority; never infers participation from live stream titles. */
    async fetchRustDrops(): Promise<NormalizedDrop[]> {
        if (this.options.useMockData) {
            this.sourceStatus = "mock data";
            return this.getMockDrops();
        }

        try {
            const html = await this.fetchCampaignPage();
            const drops = this.parseCountdownDrops(html);
            this.sourceStatus = "live (Facepunch campaign dates and participating channels)";
            return drops;
        } catch (error) {
            console.warn("Facepunch campaign fetch failed; trying Twitch Helix:", error);
            const apiDrops = await this.fetchApiDrops();
            if (apiDrops.length > 0) {
                this.sourceStatus = "live fallback (Twitch Helix API)";
                return apiDrops;
            }
            this.sourceStatus = "error (provider fetch failed)";
            console.error("Failed to fetch Twitch drops:", error);
            throw error;
        }
    }

    getSourceStatus(): string {
        return this.sourceStatus;
    }

    /** Retrieves campaigns from Twitch Helix when credentials are available. */
    private async fetchApiDrops(): Promise<NormalizedDrop[]> {
        if (!this.options.clientId || !this.options.clientSecret) {
            this.sourceStatus = "live fallback (missing Twitch API credentials)";
            if (!this.hasWarnedMissingCreds) {
                this.hasWarnedMissingCreds = true;
                console.warn(
                    "TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set. Twitch API fallback is unavailable."
                );
            }
            return [];
        }

        try {
            const token = await this.getAppAccessToken();
            const rustGameId = await this.fetchRustGameId(token);
            if (!rustGameId) {
                return [];
            }

            const response = await this.helixGet<TwitchDropsCampaignsResponse>(
                `/drops/campaigns?game_id=${encodeURIComponent(rustGameId)}`,
                token
            );

            const drops = response.data.map((campaign) => this.toNormalizedDropFromApi(campaign));
            return drops.filter((drop) => drop.status !== "ended");
        } catch (error) {
            console.warn("Twitch Helix fallback failed:", error);
            return [];
        }
    }

    /** Returns deterministic mock drops for local testing mode. */
    private getMockDrops(): NormalizedDrop[] {
        const now = Date.now();
        const hour = 60 * 60 * 1000;

        return [
            {
                platform: "twitch",
                externalId: "tw-rust-001",
                title: "Rust Fragments Pack",
                game: "rust",
                startTime: new Date(now - hour).toISOString(),
                endTime: new Date(now + 4 * hour).toISOString(),
                status: "active"
            }
        ];
    }

    /** Fetches the Facepunch Twitch campaign page HTML. */
    private async fetchCampaignPage(): Promise<string> {
        const response = await this.fetchWithRetries(TWITCH_FACEPUNCH_URL, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(`Twitch facepunch request failed with status ${response.status}`);
        }

        return response.text();
    }

    /** Retrieves and caches Twitch app access tokens for Helix requests. */
    private async getAppAccessToken(): Promise<string> {
        if (this.cachedToken && Date.now() < this.cachedToken.expiresAtMs - 60_000) {
            return this.cachedToken.value;
        }

        const url = new URL("https://id.twitch.tv/oauth2/token");
        url.searchParams.set("client_id", this.options.clientId ?? "");
        url.searchParams.set("client_secret", this.options.clientSecret ?? "");
        url.searchParams.set("grant_type", "client_credentials");

        const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(8000) });
        if (!response.ok) {
            throw new Error(`Twitch OAuth request failed with status ${response.status}`);
        }

        const body = (await response.json()) as TwitchAppTokenResponse;
        this.cachedToken = {
            value: body.access_token,
            expiresAtMs: Date.now() + body.expires_in * 1000
        };

        return body.access_token;
    }

    /** Resolves Twitch Rust game id from Helix games endpoint. */
    private async fetchRustGameId(token: string): Promise<string | undefined> {
        const response = await this.helixGet<TwitchGamesResponse>("/games?name=Rust", token);
        return response.data[0]?.id;
    }

    /** Performs typed Helix GET requests with shared headers/timeouts. */
    private async helixGet<T>(path: string, token: string): Promise<T> {
        const response = await this.fetchWithRetries(`https://api.twitch.tv/helix${path}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Client-Id": this.options.clientId ?? ""
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(`Twitch Helix request failed with status ${response.status}`);
        }

        return (await response.json()) as T;
    }

    /** Extracts and normalizes campaign channel handles from Helix payload variants. */
    private extractCampaignChannels(campaign: TwitchDropsCampaign): string[] {
        const candidates: TwitchCampaignChannel[] = [
            ...(campaign.allow?.channels ?? []),
            ...(campaign.channels ?? []),
            ...(campaign.allowed_channels ?? [])
        ];

        return Array.from(
            new Set(
                candidates
                    .map(
                        (channel) =>
                            channel.broadcaster_login ??
                            channel.login ??
                            channel.broadcaster_name ??
                            channel.display_name ??
                            channel.name
                    )
                    .filter((value): value is string => Boolean(value && value.trim()))
                    .map((value) => value.trim())
            )
        );
    }

    /** Converts a Helix campaign object into the normalized drop shape. */
    private toNormalizedDropFromApi(campaign: TwitchDropsCampaign): NormalizedDrop {
        const now = Date.now();
        const startMs = Date.parse(campaign.starts_at ?? "");
        const endMs = Date.parse(campaign.ends_at ?? "");
        if (!this.isValidCampaignRange(startMs, endMs)) {
            throw new Error(`Twitch campaign ${campaign.id} has missing or invalid campaign dates`);
        }
        const status = this.normalizeStatus(now, startMs, endMs, campaign.status);

        return {
            platform: "twitch",
            externalId: `tw-helix-${campaign.id}`,
            title: campaign.name?.trim() || `Twitch Rust Drops Campaign ${campaign.id}`,
            channels: this.extractCampaignChannels(campaign),
            game: "rust",
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            status
        };
    }

    /** Performs retrying fetch requests for transient upstream/network failures. */
    private async fetchWithRetries(input: string, init: RequestInit, maxAttempts = 2): Promise<Response> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const response = await fetch(input, init);
                if (response.ok || (response.status >= 400 && response.status < 500)) {
                    return response;
                }

                lastError = new Error(`Request failed with status ${response.status}`);
            } catch (error) {
                lastError = error;
            }

            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));
            }
        }

        throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
    }

    private isValidCampaignRange(startMs: number, endMs: number): boolean {
        return Number.isFinite(startMs) && Number.isFinite(endMs)
            && startMs > 0 && endMs > startMs
            && !Number.isNaN(new Date(startMs).getTime())
            && !Number.isNaN(new Date(endMs).getTime());
    }

    /** Reads published campaign dates; upcoming countdowns target the start, not the end. */
    private parseCountdownDrops(html: string): NormalizedDrop[] {
        const drops: NormalizedDrop[] = [];
        const now = Date.now();
        const seen = new Set<string>();
        const campaigns = Array.from(html.matchAll(
            /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bcampaign\b[^"']*\bcampaign-(\d+)\b[^"']*["'][^>]*>/gi
        ));
        const publishedRanges = new Map<number, { startMs: number; endMs: number; title?: string }>();
        const campaignChannels = new Map<number, Set<string>>();
        const generalCampaigns = new Set<number>();

        for (const [index, campaign] of campaigns.entries()) {
            const block = html.slice(campaign.index, campaigns[index + 1]?.index ?? html.length);
            const campaignIndex = Number(campaign[1]);
            const channels = campaignChannels.get(campaignIndex) ?? new Set<string>();
            for (const anchor of block.matchAll(/<a\b[^>]*>/gi)) {
                const classes = anchor[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1].split(/\s+/) ?? [];
                if (!classes.includes("streamer-info") && !classes.includes("drop-box-body")) {
                    continue;
                }
                const href = anchor[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
                const login = href?.match(/^https:\/\/(?:www\.)?twitch\.tv\/([a-z0-9_]{1,25})\/?(?:[?#].*)?$/i)?.[1];
                if (login && !["directory", "drops", "videos", "settings", "inventory"].includes(login.toLowerCase())) {
                    channels.add(login.toLowerCase());
                }
            }
            campaignChannels.set(campaignIndex, channels);
            if (/\bclass\s*=\s*["'][^"']*\bgeneral-drops-grid\b/i.test(block)) {
                generalCampaigns.add(campaignIndex);
            }
            const dateIds = Array.from(block.matchAll(/<span\b[^>]*\bdata-date-id\s*=\s*["']([^"']+)["'][^>]*>/gi));
            if (dateIds.length === 0) {
                continue;
            }

            const startMs = Number(dateIds[0]?.[1].match(/-(\d+)$/)?.[1]) * 1000;
            const endMs = Number(dateIds[1]?.[1].match(/-(\d+)$/)?.[1]) * 1000;
            if (!this.isValidCampaignRange(startMs, endMs)) {
                throw new Error(`Facepunch campaign ${campaign[1]} has missing or invalid published dates`);
            }

            const title = block.match(/<h2\b[^>]*\bclass\s*=\s*["'][^"']*\bevent-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1]
                .replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").trim();
            publishedRanges.set(Number(campaign[1]), { startMs, endMs, title });
        }

        const countdowns = new Map<number, { startMs: number; endMs: number }>();
        for (const match of html.matchAll(COUNTDOWN_REGEX)) {
            countdowns.set(Number(match[1]), { startMs: Number(match[2]), endMs: Number(match[3]) });
        }

        for (const campaignIndex of new Set([...publishedRanges.keys(), ...countdowns.keys()])) {
            const range = publishedRanges.get(campaignIndex) ?? countdowns.get(campaignIndex);
            if (!range || !this.isValidCampaignRange(range.startMs, range.endMs)) {
                throw new Error(`Facepunch campaign ${campaignIndex} has no valid campaign date range`);
            }
            const { startMs, endMs } = range;

            const externalId = `tw-facepunch-${campaignIndex}-${startMs}-${endMs}`;
            if (seen.has(externalId)) {
                continue;
            }

            seen.add(externalId);
            drops.push({
                platform: "twitch",
                externalId,
                title: publishedRanges.get(campaignIndex)?.title || `Rust Twitch Drops Campaign ${campaignIndex + 1}`,
                channels: Array.from(campaignChannels.get(campaignIndex) ?? []),
                hasGeneralDrops: generalCampaigns.has(campaignIndex),
                game: "rust",
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                status: this.normalizeStatus(now, startMs, endMs)
            });
        }

        return drops;
    }

    /** Dates determine availability; explicit ended statuses also cover cancelled campaigns. */
    private normalizeStatus(
        nowMs: number,
        startMs: number,
        endMs: number,
        rawStatus?: string
    ): "upcoming" | "active" | "ended" {
        const normalized = (rawStatus ?? "").toLowerCase();
        if (normalized.includes("ended") || normalized.includes("expired") || normalized.includes("inactive")) {
            return "ended";
        }

        if (nowMs < startMs) {
            return "upcoming";
        }

        if (nowMs >= endMs) {
            return "ended";
        }

        return "active";
    }
}
