import type { DropsProvider } from "./base.js";
import type { NormalizedDrop } from "../types.js";

/**
 * Twitch drops provider with Helix-first fetch and Facepunch/public-web fallback discovery.
 */

interface TwitchProviderOptions {
    useMockData: boolean;
    clientId?: string;
    clientSecret?: string;
}

const TWITCH_FACEPUNCH_URL = "https://twitch.facepunch.com/";
const COUNTDOWN_REGEX = /setupCountdown\(\s*['\"]\.campaign-(\d+)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi;
const TWITCH_PUBLIC_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_PUBLIC_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const CHANNEL_CACHE_TTL_MS = 3 * 60 * 1000;

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
 * Twitch provider that combines Helix API data with Facepunch/public fallback discovery.
 */
export class TwitchDropsProvider implements DropsProvider {
    readonly platform = "twitch" as const;
    private cachedToken?: { value: string; expiresAtMs: number };
    private hasWarnedMissingCreds = false;
    private sourceStatus = "live fallback (Facepunch timing parser)";
    private cachedPublicChannels?: { value: string[]; expiresAtMs: number };

    /** Creates a Twitch provider with runtime flags and optional API credentials. */
    constructor(private readonly options: TwitchProviderOptions) { }

    /** Fetches Rust campaigns via API first, then falls back to Facepunch/public discovery. */
    async fetchRustDrops(): Promise<NormalizedDrop[]> {
        if (this.options.useMockData) {
            this.sourceStatus = "mock data";
            return this.getMockDrops();
        }

        try {
            const apiDrops = await this.fetchApiDrops();
            if (apiDrops.length > 0) {
                this.sourceStatus = "live (Twitch Helix API)";
                return apiDrops;
            }

            const html = await this.fetchCampaignPage();
            const countdownDrops = this.parseCountdownDrops(html, []);
            if (countdownDrops.length === 0) {
                this.sourceStatus = "live fallback (Facepunch timing parser)";
                return countdownDrops;
            }

            const channels = await this.fetchRustChannelsFromPublicWeb();
            this.sourceStatus = channels.length > 0
                ? "live fallback (Facepunch timing + Twitch public web discovery)"
                : "live fallback (Facepunch timing parser)";
            if (channels.length === 0) {
                return countdownDrops;
            }

            return countdownDrops.map((drop) => ({ ...drop, channels }));
        } catch (error) {
            this.sourceStatus = "error (provider fetch failed)";
            console.error("Failed to fetch Twitch drops:", error);
            return [];
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
                    "TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set. Twitch provider is using Facepunch timing fallback only."
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
            console.warn("Twitch Helix drops fetch failed, falling back to Facepunch page:", error);
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
        const startMs = campaign.starts_at ? Date.parse(campaign.starts_at) : now;
        const endMs = campaign.ends_at ? Date.parse(campaign.ends_at) : now + 24 * 60 * 60 * 1000;
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

    /** Discovers likely Rust channels from Twitch public directory GraphQL data. */
    private async fetchRustChannelsFromPublicWeb(limit = 20): Promise<string[]> {
        if (this.cachedPublicChannels && Date.now() < this.cachedPublicChannels.expiresAtMs) {
            return this.cachedPublicChannels.value;
        }

        try {
            const payload = {
                query: `query RustDirectoryChannels($first: Int!) {\n  game(name: \"Rust\") {\n    streams(first: $first) {\n      edges {\n        node {\n          title\n          broadcaster {\n            login\n          }\n        }\n      }\n    }\n  }\n}`,
                variables: { first: Math.max(5, Math.min(limit * 2, 50)) }
            };

            const response = await this.fetchWithRetries(TWITCH_PUBLIC_GQL_URL, {
                method: "POST",
                headers: {
                    "Client-Id": TWITCH_PUBLIC_CLIENT_ID,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000)
            });

            if (!response.ok) {
                return [];
            }

            const body = (await response.json()) as {
                data?: {
                    game?: {
                        streams?: {
                            edges?: Array<{
                                node?: {
                                    title?: string;
                                    broadcaster?: { login?: string };
                                };
                            }>;
                        };
                    };
                };
            };

            const all = (body.data?.game?.streams?.edges ?? [])
                .map((edge) => ({
                    login: edge.node?.broadcaster?.login?.trim(),
                    title: edge.node?.title ?? ""
                }))
                .filter((entry): entry is { login: string; title: string } => Boolean(entry.login));

            const preferred = all.filter((entry) => /\bdrops?\b/i.test(entry.title));
            const ordered = preferred.length > 0 ? preferred : all;

            const channels = Array.from(new Set(ordered.map((entry) => entry.login))).slice(0, limit);
            this.cachedPublicChannels = {
                value: channels,
                expiresAtMs: Date.now() + CHANNEL_CACHE_TTL_MS
            };
            return channels;
        } catch {
            return [];
        }
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

    /** Parses Facepunch countdown script blocks into normalized drop campaigns. */
    private parseCountdownDrops(html: string, channels: string[]): NormalizedDrop[] {
        const drops: NormalizedDrop[] = [];
        const now = Date.now();
        const seen = new Set<string>();

        for (const match of html.matchAll(COUNTDOWN_REGEX)) {
            const campaignIndex = Number(match[1]);
            const startMs = Number(match[2]);
            const endMs = Number(match[3]);

            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
                continue;
            }

            const externalId = `tw-facepunch-${campaignIndex}-${startMs}-${endMs}`;
            if (seen.has(externalId)) {
                continue;
            }

            seen.add(externalId);
            drops.push({
                platform: "twitch",
                externalId,
                title: `Rust Twitch Drops Campaign ${campaignIndex + 1}`,
                channels,
                game: "rust",
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                status: this.normalizeStatus(now, startMs, endMs)
            });
        }

        return drops;
    }

    /** Derives canonical drop status from explicit status text or start/end timestamps. */
    private normalizeStatus(
        nowMs: number,
        startMs: number,
        endMs: number,
        rawStatus?: string
    ): "upcoming" | "active" | "ended" {
        const normalized = (rawStatus ?? "").toLowerCase();
        if (normalized.includes("active") || normalized.includes("live")) {
            return "active";
        }

        if (normalized.includes("upcoming") || normalized.includes("scheduled")) {
            return "upcoming";
        }

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
