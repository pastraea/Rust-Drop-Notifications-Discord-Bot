import type { DropsProvider } from "./base.js";
import type { NormalizedDrop } from "../types.js";

/**
 * Kick drops provider with API-first fetch and Facepunch fallback discovery.
 */

const KICK_FACEPUNCH_URL = "https://kick.facepunch.com/";
const COUNTDOWN_REGEX = /setupCountdown\(\s*['\"]\.campaign-(\d+)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi;
const KICK_FACEPUNCH_TILE_URL = "https://kick.facepunch.com/?handler=Tile&hashedId=";
const CHANNEL_CACHE_TTL_MS = 3 * 60 * 1000;

interface KickCampaignLike {
    id?: string | number;
    slug?: string;
    title?: string;
    name?: string;
    starts_at?: string;
    start_at?: string;
    start_time?: string;
    ends_at?: string;
    end_at?: string;
    end_time?: string;
    status?: string;
    channels?: Array<{ slug?: string; username?: string; name?: string }>;
}

/**
 * Kick provider that prefers API campaign data and falls back to Facepunch parsing/discovery.
 */
export class KickDropsProvider implements DropsProvider {
    readonly platform = "kick" as const;
    private sourceStatus = "live fallback (Facepunch timing parser)";
    private cachedDiscoveredChannels?: { value: string[]; expiresAtMs: number };

    /** Creates a Kick provider with optional mock-data mode toggle. */
    constructor(private readonly useMockData: boolean) { }

    /** Fetches Rust campaigns via API first, then falls back to Facepunch parsing/discovery. */
    async fetchRustDrops(): Promise<NormalizedDrop[]> {
        if (this.useMockData) {
            this.sourceStatus = "mock data";
            return this.getMockDrops();
        }

        try {
            const apiDrops = await this.fetchApiDrops();
            if (apiDrops.length > 0) {
                this.sourceStatus = "live (Kick API campaigns endpoint)";
                return apiDrops;
            }

            const html = await this.fetchCampaignPage();
            const countdownDrops = this.parseCountdownDrops(html, []);
            if (countdownDrops.length === 0) {
                this.sourceStatus = "live fallback (Facepunch timing parser)";
                return countdownDrops;
            }

            const channels = await this.extractChannelsFromFacepunch(html);
            this.sourceStatus = channels.length > 0
                ? "live fallback (Facepunch timing + tile/html channel discovery)"
                : "live fallback (Facepunch timing parser)";
            if (channels.length === 0) {
                return countdownDrops;
            }

            return countdownDrops.map((drop) => ({ ...drop, channels }));
        } catch (error) {
            this.sourceStatus = "error (provider fetch failed)";
            console.error("Failed to fetch Kick drops:", error);
            return [];
        }
    }

    getSourceStatus(): string {
        return this.sourceStatus;
    }

    /** Retrieves campaign payloads from known Kick API endpoints. */
    private async fetchApiDrops(): Promise<NormalizedDrop[]> {
        const endpoints = [
            "https://kick.com/api/v2/drops/campaigns",
            "https://kick.com/api/v1/drops/campaigns"
        ];

        for (const endpoint of endpoints) {
            try {
                const response = await this.fetchWithRetries(endpoint, {
                    method: "GET",
                    headers: {
                        "User-Agent": "Mozilla/5.0",
                        Accept: "application/json,text/plain,*/*"
                    },
                    signal: AbortSignal.timeout(8000)
                });

                if (!response.ok) {
                    continue;
                }

                const body = (await response.json()) as unknown;
                const campaigns = this.extractCampaignArray(body);
                if (campaigns.length === 0) {
                    continue;
                }

                const parsed = campaigns.map((campaign, index) => this.toNormalizedDropFromApi(campaign, index));
                return parsed.filter((drop) => drop.status !== "ended");
            } catch {
                // Try next endpoint.
            }
        }

        this.sourceStatus = "live fallback (Kick API blocked/unavailable)";
        return [];
    }

    /** Normalizes API payload shape differences into a campaign array. */
    private extractCampaignArray(body: unknown): KickCampaignLike[] {
        if (Array.isArray(body)) {
            return body as KickCampaignLike[];
        }

        if (body && typeof body === "object") {
            const asRecord = body as Record<string, unknown>;
            if (Array.isArray(asRecord.data)) {
                return asRecord.data as KickCampaignLike[];
            }

            if (Array.isArray(asRecord.campaigns)) {
                return asRecord.campaigns as KickCampaignLike[];
            }
        }

        return [];
    }

    /** Converts one Kick API campaign object into normalized drop format. */
    private toNormalizedDropFromApi(campaign: KickCampaignLike, index: number): NormalizedDrop {
        const now = Date.now();
        const rawStart = campaign.starts_at ?? campaign.start_at ?? campaign.start_time;
        const rawEnd = campaign.ends_at ?? campaign.end_at ?? campaign.end_time;
        const startMs = rawStart ? Date.parse(rawStart) : now;
        const endMs = rawEnd ? Date.parse(rawEnd) : now + 24 * 60 * 60 * 1000;
        const channels = Array.from(
            new Set(
                (campaign.channels ?? [])
                    .map((channel) => channel.slug ?? channel.username ?? channel.name)
                    .filter((value): value is string => Boolean(value && value.trim()))
                    .map((value) => value.trim())
            )
        );

        return {
            platform: "kick",
            externalId: `ki-api-${campaign.id ?? campaign.slug ?? index}`,
            title: campaign.title?.trim() || campaign.name?.trim() || `Kick Rust Drops Campaign ${index + 1}`,
            channels,
            game: "rust",
            startTime: new Date(startMs).toISOString(),
            endTime: new Date(endMs).toISOString(),
            status: this.normalizeStatus(now, startMs, endMs, campaign.status)
        };
    }

    /** Returns deterministic mock drops used during local/test runs. */
    private getMockDrops(): NormalizedDrop[] {
        const now = Date.now();
        const hour = 60 * 60 * 1000;

        return [
            {
                platform: "kick",
                externalId: "ki-rust-001",
                title: "Rust Scrap Bundle",
                game: "rust",
                startTime: new Date(now + 30 * 60 * 1000).toISOString(),
                endTime: new Date(now + 6 * hour).toISOString(),
                status: "upcoming"
            }
        ];
    }

    /** Fetches Facepunch Kick campaign page HTML. */
    private async fetchCampaignPage(): Promise<string> {
        const response = await this.fetchWithRetries(KICK_FACEPUNCH_URL, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(`Kick facepunch request failed with status ${response.status}`);
        }

        return response.text();
    }

    /** Extracts channel names from facepunch page/tile HTML and caches discovery results. */
    private async extractChannelsFromFacepunch(html: string): Promise<string[]> {
        if (this.cachedDiscoveredChannels && Date.now() < this.cachedDiscoveredChannels.expiresAtMs) {
            return this.cachedDiscoveredChannels.value;
        }

        const channels = new Set<string>();

        for (const channel of this.extractKickChannelsFromHtml(html)) {
            channels.add(channel);
        }

        const hashes = Array.from(
            new Set(
                [...html.matchAll(/data-streamer-hash=\"([^\"]+)\"/gi)]
                    .map((match) => match[1])
                    .filter((value): value is string => Boolean(value && value.trim()))
            )
        ).slice(0, 25);

        for (const hash of hashes) {
            try {
                const response = await this.fetchWithRetries(
                    `${KICK_FACEPUNCH_TILE_URL}${encodeURIComponent(hash)}`,
                    {
                        method: "GET",
                        headers: {
                            "User-Agent": "Mozilla/5.0"
                        },
                        signal: AbortSignal.timeout(8000)
                    }
                );

                if (!response.ok) {
                    continue;
                }

                const tileHtml = await response.text();
                for (const channel of this.extractKickChannelsFromHtml(tileHtml)) {
                    channels.add(channel);
                }
            } catch {
                // Continue with remaining hashes.
            }
        }

        const discovered = Array.from(channels).slice(0, 20);
        this.cachedDiscoveredChannels = {
            value: discovered,
            expiresAtMs: Date.now() + CHANNEL_CACHE_TTL_MS
        };

        return discovered;
    }

    /** Parses Kick channel handles from raw HTML anchors and absolute URLs. */
    private extractKickChannelsFromHtml(html: string): string[] {
        const matches = [
            ...html.matchAll(/https?:\/\/kick\.com\/([a-zA-Z0-9_-]+)/gi),
            ...html.matchAll(/href=["']\/([a-zA-Z0-9_-]+)["']/gi)
        ];

        const blocked = new Set(["category", "drops", "connect", "login", "register"]);
        return Array.from(
            new Set(
                matches
                    .map((match) => match[1]?.trim().toLowerCase())
                    .filter((value): value is string => Boolean(value && !blocked.has(value)))
            )
        );
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

            const externalId = `ki-facepunch-${campaignIndex}-${startMs}-${endMs}`;
            if (seen.has(externalId)) {
                continue;
            }

            seen.add(externalId);
            drops.push({
                platform: "kick",
                externalId,
                title: `Rust Kick Drops Campaign ${campaignIndex + 1}`,
                channels,
                game: "rust",
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                status: this.normalizeStatus(now, startMs, endMs)
            });
        }

        return drops;
    }

    /** Derives canonical drop status from explicit status text or timestamp bounds. */
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
}
