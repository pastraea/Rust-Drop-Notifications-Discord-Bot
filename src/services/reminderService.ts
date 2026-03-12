import { AttachmentBuilder, ChannelType, Client, TextChannel } from "discord.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { GifCodec } from "gifwrap";
import type { BotDb, TimedAlertType } from "../db.js";
import { getAnnouncementChannelsSummary } from "./announcementTargets.js";
import {
    APPROVED_RUST_GIF_VIEW_URLS,
    RARE_BEE_GIF_CHANCE,
    RARE_BEE_GIF_VIEW_URL
} from "./rustGifAllowlist.js";

/**
 * Reminder pipeline: computes due alert windows, builds snapshots, and sends announcements.
 */

/**
 * Reminder/announcement service: builds snapshot messages, resolves GIF media, and dispatches alerts.
 */

function resolveReminderChannelId(db: BotDb, envChannelId?: string): string | undefined {
    return db.getSetting("reminder_channel_id") ?? envChannelId;
}

interface ReminderOptions {
    forceAnnounce?: boolean;
    forceAnnounceMode?: "verified" | "full";
    intervalMs?: number;
}

type TimedDrop = {
    id: number;
    platform: string;
    title: string;
    channels?: string[];
    startTime: string;
    startTimeMs: number;
    endTime: string;
    endTimeMs: number;
};

const SYDNEY_TIME_ZONE = "Australia/Sydney";
const SYDNEY_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
});
const MAX_GIF_RESOLVE_ATTEMPTS = 4;
const TENOR_VIEW_FETCH_TIMEOUT_MS = 2500;
const GIF_DOWNLOAD_TIMEOUT_MS = 3000;
const GIF_PROBE_TIMEOUT_MS = 1500;
const GIF_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const GIF_PROBE_LIMIT = 8;
const MIN_GIF_WIDTH = 560;
const MAX_GIF_UPSCALE_FACTOR = 2;
const GIF_UPSCALE_TIMEOUT_MS = 12000;
const PERF_LOG_ENABLED = process.env.RUST_DROPS_PERF_LOG === "1";
const HOUR_MS = 60 * 60 * 1000;

const tenorMediaCache = new Map<string, string | null>();
const gifContentLengthCache = new Map<string, { length: number; expiresAt: number }>();
const recentGifHistory: string[] = [];
const recentGifHistorySet = new Set<string>();
const RECENT_GIF_HISTORY_LIMIT = 25;

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

/** Returns monotonic time in milliseconds for lightweight perf instrumentation. */
function nowMs(): number {
    return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Emits a perf segment duration when runtime perf logging is enabled. */
function logPerfSegment(name: string, startMs: number): void {
    if (!PERF_LOG_ENABLED) {
        return;
    }

    const durationMs = nowMs() - startMs;
    console.log(`[perf] ${name}: ${durationMs.toFixed(2)}ms`);
}

/** Returns a shuffled copy using Fisher-Yates in-place permutation. */
function shuffledCopy<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

/** Normalizes Tenor view URLs and corrects malformed duplicated protocol prefixes. */
function normalizeTenorViewUrl(url: string): string {
    return url.trim().replace(/^https:\/\/https:\/\//i, "https://");
}

/** Validates whether a URL matches the expected Tenor view URL shape. */
function isValidTenorViewUrl(url: string): boolean {
    return /^https:\/\/tenor\.com\/view\/[a-z0-9\-]+/i.test(url);
}

/** Decodes HTML entities encountered in scraped Tenor metadata. */
function decodeHtmlEntities(value: string): string {
    return value.replaceAll("&amp;", "&");
}

/** Extracts Tenor media token segment from a direct media URL. */
function getMediaToken(url: string): string | undefined {
    const match = url.match(/https:\/\/media(?:1)?\.tenor\.com\/(?:m\/)?([^/]+)\//i);
    return match?.[1];
}

/** Normalizes a Tenor media token to its base id for variant matching. */
function getMediaBaseId(token: string): string {
    return token.replace(/AAA[A-Za-z0-9]+$/i, "");
}

/** Scores media URLs using heuristics that prefer larger/primary GIF variants. */
function scoreMediaUrl(url: string, baseId?: string): number {
    const lower = url.toLowerCase();
    let score = 0;

    if (lower.endsWith(".gif")) {
        score += 70;
    }

    if (lower.includes("aaap")) {
        score += 50;
    }

    if (lower.includes("aaaam")) {
        score += 30;
    }

    if (lower.includes("aaaa")) {
        score += 10;
    }

    if (baseId && lower.includes(`/${baseId.toLowerCase()}`)) {
        score += 40;
    }

    return score;
}

/** Retrieves (and caches) content length for a media URL to improve candidate ranking. */
async function getMediaContentLength(url: string): Promise<number> {
    const now = Date.now();
    const cached = gifContentLengthCache.get(url);
    if (cached && cached.expiresAt > now) {
        return cached.length;
    }

    try {
        const head = await fetch(url, {
            method: "HEAD",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(GIF_PROBE_TIMEOUT_MS)
        });

        const headerValue = head.headers.get("content-length");
        const parsed = headerValue ? Number(headerValue) : NaN;
        const length = Number.isFinite(parsed) ? parsed : 0;
        gifContentLengthCache.set(url, {
            length,
            expiresAt: now + GIF_PROBE_CACHE_TTL_MS
        });
        return length;
    } catch {
        gifContentLengthCache.set(url, {
            length: 0,
            expiresAt: now + GIF_PROBE_CACHE_TTL_MS
        });
        return 0;
    }
}

/** Selects the best GIF candidate by combining URL heuristics with content-length probes. */
async function chooseLargestGifCandidate(candidates: string[], baseId?: string): Promise<string | undefined> {
    if (candidates.length === 0) {
        return undefined;
    }

    const candidatesByHeuristic = candidates
        .map((url) => ({ url, heuristic: scoreMediaUrl(url, baseId) }))
        .sort((left, right) => right.heuristic - left.heuristic)
        .slice(0, Math.min(GIF_PROBE_LIMIT, candidates.length));

    const scored = await Promise.all(
        candidatesByHeuristic.map(async ({ url, heuristic }) => {
            const length = await getMediaContentLength(url);
            return { url, score: heuristic + length };
        })
    );

    scored.sort((left, right) => right.score - left.score);
    return scored[0]?.url;
}

/** Resolves a Tenor view page to a direct media GIF URL and caches the result. */
async function resolveTenorMediaAssetUrl(viewUrl: string): Promise<string | undefined> {
    if (!viewUrl) {
        return undefined;
    }

    if (tenorMediaCache.has(viewUrl)) {
        const cached = tenorMediaCache.get(viewUrl);
        return cached ?? undefined;
    }

    try {
        const response = await fetch(viewUrl, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(TENOR_VIEW_FETCH_TIMEOUT_MS)
        });

        if (!response.ok) {
            tenorMediaCache.set(viewUrl, null);
            return undefined;
        }

        const html = await response.text();

        const decodeEscapedTenorUrl = (value: string): string =>
            decodeHtmlEntities(value)
                .replaceAll("\\u002F", "/")
                .replaceAll("\\/", "/")
                .replace(/^https:\/\//i, "https://");

        const ogImageMatch =
            html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
            html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);

        const ogImageUrl = decodeHtmlEntities(ogImageMatch?.[1] ?? "");

        const baseId = (() => {
            const token = getMediaToken(ogImageUrl);
            return token ? getMediaBaseId(token) : undefined;
        })();

        const unescapedMatches = html.match(/https:\/\/(?:media|media1)\.tenor\.com\/[^"'\s>]+/gi) ?? [];
        const escapedMatches =
            html.match(/https:\\u002F\\u002F(?:media|media1)\.tenor\.com\\u002F[^"'\s>]+/gi) ?? [];

        const mediaMatches = Array.from(
            new Set([...unescapedMatches, ...escapedMatches].map((url) => decodeEscapedTenorUrl(url)))
        ).filter((url) => /\.gif($|\?)/i.test(url));

        if (mediaMatches.length === 0) {
            tenorMediaCache.set(viewUrl, null);
            return undefined;
        }

        const sameAssetMatches =
            baseId && mediaMatches.length > 0
                ? mediaMatches.filter((url) => {
                    const token = getMediaToken(url);
                    return token ? getMediaBaseId(token).toLowerCase() === baseId.toLowerCase() : false;
                })
                : [];

        const candidatePool = sameAssetMatches.length > 0 ? sameAssetMatches : mediaMatches;
        if (candidatePool.length > 0) {
            const selected = await chooseLargestGifCandidate(candidatePool, baseId);

            if (selected) {
                tenorMediaCache.set(viewUrl, selected);
                return selected;
            }
        }

        tenorMediaCache.set(viewUrl, null);
        return undefined;
    } catch {
        tenorMediaCache.set(viewUrl, null);
        return undefined;
    }
}

async function getRandomRustMemeMediaGifUrl(
    db: BotDb,
    options?: { allowRareBee?: boolean }
): Promise<{ mediaGifUrl?: string; rareBeeFound: boolean }> {
    let mode = db.getGifMode();
    const normalizedAllowlist = Array.from(
        new Set(APPROVED_RUST_GIF_VIEW_URLS.map((url) => normalizeTenorViewUrl(url)).filter(isValidTenorViewUrl))
    );
    const normalizedCustomPool = Array.from(
        new Set(db.listAllCustomGifViewUrls().map((url) => normalizeTenorViewUrl(url)).filter(isValidTenorViewUrl))
    );

    if ((mode === "custom" || mode === "both") && normalizedCustomPool.length === 0) {
        mode = "default";
        db.setGifMode(mode);
    }

    const allUniqueViewUrls =
        mode === "custom"
            ? normalizedCustomPool
            : mode === "both"
                ? Array.from(new Set([...normalizedAllowlist, ...normalizedCustomPool]))
                : normalizedAllowlist;

    if (allUniqueViewUrls.length === 0) {
        return { mediaGifUrl: undefined, rareBeeFound: false };
    }

    const normalizedRareBee = normalizeTenorViewUrl(RARE_BEE_GIF_VIEW_URL);
    const nonRareViewUrls = allUniqueViewUrls.filter((url) => url !== normalizedRareBee);
    const includeRareBee =
        options?.allowRareBee === true &&
        mode === "default" &&
        allUniqueViewUrls.includes(normalizedRareBee) &&
        Math.random() < RARE_BEE_GIF_CHANCE;

    const sourceViewUrls = includeRareBee
        ? [normalizedRareBee]
        : nonRareViewUrls.length > 0
            ? nonRareViewUrls
            : allUniqueViewUrls;

    const shuffled = shuffledCopy(sourceViewUrls);
    const limited = shuffled.slice(0, Math.min(MAX_GIF_RESOLVE_ATTEMPTS, shuffled.length));
    const selectedCandidates: string[] = [];

    for (const viewUrl of limited) {
        const mediaUrl = await resolveTenorMediaAssetUrl(viewUrl);
        if (mediaUrl) {
            selectedCandidates.push(mediaUrl);
        }
    }

    if (selectedCandidates.length === 0) {
        const remaining = shuffled.slice(limited.length);
        for (const viewUrl of remaining) {
            const mediaUrl = await resolveTenorMediaAssetUrl(viewUrl);
            if (mediaUrl) {
                selectedCandidates.push(mediaUrl);
                if (selectedCandidates.length >= MAX_GIF_RESOLVE_ATTEMPTS) {
                    break;
                }
            }
        }
    }

    if (selectedCandidates.length === 0 && includeRareBee) {
        const fallbackShuffled = shuffledCopy(nonRareViewUrls);
        const fallbackLimited = fallbackShuffled.slice(
            0,
            Math.min(MAX_GIF_RESOLVE_ATTEMPTS, fallbackShuffled.length)
        );

        for (const viewUrl of fallbackLimited) {
            const mediaUrl = await resolveTenorMediaAssetUrl(viewUrl);
            if (mediaUrl) {
                selectedCandidates.push(mediaUrl);
            }
        }

        if (selectedCandidates.length === 0) {
            const fallbackRemaining = fallbackShuffled.slice(fallbackLimited.length);
            for (const viewUrl of fallbackRemaining) {
                const mediaUrl = await resolveTenorMediaAssetUrl(viewUrl);
                if (mediaUrl) {
                    selectedCandidates.push(mediaUrl);
                    if (selectedCandidates.length >= MAX_GIF_RESOLVE_ATTEMPTS) {
                        break;
                    }
                }
            }
        }
    }

    const uniqueCurated = Array.from(new Set(selectedCandidates));
    const freshCurated = uniqueCurated.filter((url) => !recentGifHistorySet.has(url));

    const selectedCurated =
        freshCurated.length > 0
            ? pickRandom(freshCurated)
            : uniqueCurated.length > 0
                ? pickRandom(uniqueCurated)
                : undefined;

    if (!selectedCurated) {
        return { mediaGifUrl: undefined, rareBeeFound: false };
    }

    recentGifHistory.push(selectedCurated);
    recentGifHistorySet.add(selectedCurated);
    if (recentGifHistory.length > RECENT_GIF_HISTORY_LIMIT) {
        const removed = recentGifHistory.splice(0, recentGifHistory.length - RECENT_GIF_HISTORY_LIMIT);
        for (const url of removed) {
            recentGifHistorySet.delete(url);
        }
    }

    return { mediaGifUrl: selectedCurated, rareBeeFound: includeRareBee && selectedCurated !== undefined };
}

async function sendMemeNotification(
    textChannel: TextChannel,
    db: BotDb,
    lines: string[]
): Promise<void> {
    const { mediaGifUrl } = await getRandomRustMemeMediaGifUrl(db);
    const content = lines.join("\n");

    if (!mediaGifUrl) {
        await textChannel.send({ content });
        return;
    }

    try {
        const gifResponse = await fetch(mediaGifUrl, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(GIF_DOWNLOAD_TIMEOUT_MS)
        });

        if (!gifResponse.ok) {
            await textChannel.send({ content });
            return;
        }

        const downloadedBuffer = Buffer.from(await gifResponse.arrayBuffer());
        const gifBuffer = await upscaleGifIfNeeded(downloadedBuffer);
        const attachment = new AttachmentBuilder(gifBuffer, {
            name: `rust-meme-${Date.now()}.gif`
        });

        await textChannel.send({
            content,
            files: [attachment]
        });
    } catch {
        await textChannel.send({ content });
    }
}

async function upscaleGifIfNeeded(sourceBuffer: Buffer): Promise<Buffer> {
    try {
        const codec = new GifCodec();
        const decoded = await codec.decodeGif(sourceBuffer);

        const sourceWidth = decoded.frames[0]?.bitmap.width ?? 0;
        if (sourceWidth <= 0 || sourceWidth >= MIN_GIF_WIDTH) {
            return sourceBuffer;
        }

        const targetScale = Math.min(MAX_GIF_UPSCALE_FACTOR, Math.ceil(MIN_GIF_WIDTH / sourceWidth));
        if (targetScale <= 1) {
            return sourceBuffer;
        }

        const targetWidth = sourceWidth * targetScale;
        const upscaled = await upscaleGifWithFfmpeg(sourceBuffer, targetWidth);
        return upscaled ?? sourceBuffer;
    } catch {
        return sourceBuffer;
    }
}

async function upscaleGifWithFfmpeg(sourceBuffer: Buffer, targetWidth: number): Promise<Buffer | undefined> {
    const ffmpegBinary = typeof ffmpegPath === "string" ? ffmpegPath : undefined;
    if (!ffmpegBinary) {
        return undefined;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rust-gif-upscale-"));
    const inputPath = path.join(tempDir, "in.gif");
    const outputPath = path.join(tempDir, "out.gif");

    try {
        await fs.writeFile(inputPath, sourceBuffer);

        const filter = [
            `[0:v]scale='if(gte(iw,${targetWidth}),iw,${targetWidth})':-1:flags=lanczos,split[v1][v2]`,
            "[v1]palettegen=stats_mode=single[p]",
            "[v2][p]paletteuse=dither=sierra2_4a"
        ].join(";");

        await runFfmpeg(ffmpegBinary, [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-filter_complex",
            filter,
            "-gifflags",
            "-offsetting",
            outputPath
        ]);

        const outputBuffer = await fs.readFile(outputPath);
        if (outputBuffer.length === 0) {
            return undefined;
        }

        return outputBuffer;
    } catch {
        return undefined;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

function runFfmpeg(ffmpegBinary: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const process = spawn(ffmpegBinary, args, {
            windowsHide: true,
            signal: AbortSignal.timeout(GIF_UPSCALE_TIMEOUT_MS)
        });

        let stderr = "";
        process.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });

        process.once("error", (error) => {
            reject(error);
        });

        process.once("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
    });
}

function getSydneyClock(date: Date) {
    const parts = SYDNEY_CLOCK_FORMATTER.formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

    return { hour, minute };
}

/** Returns whether current Sydney time is inside a target hour bounded minute window. */
function isSydneyWindow(date: Date, targetHour: number, windowMinutes: number): boolean {
    const clock = getSydneyClock(date);
    return clock.hour === targetHour && clock.minute >= 0 && clock.minute < windowMinutes;
}

/**
 * Returns due timed alert types for a drop start time within the scheduler interval.
 */
/**
 * Returns timed alert types that are due for a campaign start time in the current cycle window.
 */
export function getTimedAlertDueTypes(dropStart: Date, now: Date, intervalMs: number): TimedAlertType[] {
    return getTimedAlertDueTypesFromMs(dropStart.getTime(), now.getTime(), now, intervalMs);
}

function getTimedAlertDueTypesFromMsWithWindows(
    dropStartMs: number,
    nowMs: number,
    intervalMs: number,
    isMorningWindow: boolean,
    isEveningWindow: boolean
): TimedAlertType[] {
    const dueTypes: TimedAlertType[] = [];
    const msUntilStart = dropStartMs - nowMs;

    if (msUntilStart <= 0) {
        return dueTypes;
    }

    if (msUntilStart < 24 * HOUR_MS && isMorningWindow) {
        dueTypes.push("alert_24h_6am");
    }

    if (msUntilStart < 12 * HOUR_MS && isEveningWindow) {
        dueTypes.push("alert_12h_6pm");
    }

    const lowerBoundMs = HOUR_MS - intervalMs;
    if (msUntilStart <= HOUR_MS && msUntilStart > lowerBoundMs) {
        dueTypes.push("alert_1h");
    }

    return dueTypes;
}

function getTimedAlertDueTypesFromMs(
    dropStartMs: number,
    nowMs: number,
    nowDate: Date,
    intervalMs: number
): TimedAlertType[] {
    const windowMinutes = Math.max(5, Math.ceil(intervalMs / (60 * 1000)));
    return getTimedAlertDueTypesFromMsWithWindows(
        dropStartMs,
        nowMs,
        intervalMs,
        isSydneyWindow(nowDate, 6, windowMinutes),
        isSydneyWindow(nowDate, 18, windowMinutes)
    );
}

/** Aggregates platform drops into merged channels/campaigns and extreme (min/max) time. */
function aggregatePlatformDrops(
    drops: Array<{ title: string; channels?: string[] }>,
    timeSelector: (drop: { endTime?: string; startTime?: string; endTimeMs?: number; startTimeMs?: number }) => number,
    timeMode: "max" | "min"
): { campaignSummary: string; mergedChannels: string[]; extremeTimeMs: number } {
    const titleSet = new Set<string>();
    const channelSet = new Set<string>();
    let extremeTimeMs = Number.NaN;

    for (const drop of drops) {
        titleSet.add(drop.title);
        for (const channel of drop.channels ?? []) {
            channelSet.add(channel);
        }

        const parsed = timeSelector(drop as { endTime?: string; startTime?: string; endTimeMs?: number; startTimeMs?: number });
        if (Number.isNaN(parsed)) {
            continue;
        }

        if (Number.isNaN(extremeTimeMs)) {
            extremeTimeMs = parsed;
            continue;
        }

        if (timeMode === "max" && parsed > extremeTimeMs) {
            extremeTimeMs = parsed;
        }
        if (timeMode === "min" && parsed < extremeTimeMs) {
            extremeTimeMs = parsed;
        }
    }

    return {
        campaignSummary: Array.from(titleSet).join(", "),
        mergedChannels: Array.from(channelSet),
        extremeTimeMs
    };
}

function getNotificationTypeForTimedAlert(alertType: TimedAlertType): string {
    if (alertType === "alert_24h_6am") {
        return "drop_24h_6am";
    }

    if (alertType === "alert_12h_6pm") {
        return "drop_12h_6pm";
    }

    return "drop_1h";
}

function getTimedAlertLabel(alertType: TimedAlertType): string {
    if (alertType === "alert_24h_6am") {
        return "24h morning reminder";
    }

    if (alertType === "alert_12h_6pm") {
        return "12h evening reminder";
    }

    return "1h reminder";
}

function getSnapshotHeading(kind: TimedAlertType | "checkdrops" | "live"): string {
    if (kind === "alert_24h_6am") {
        return "**Rust Drop Update (After 24 Hours Before Drop)**";
    }

    if (kind === "alert_12h_6pm") {
        return "**Rust Drop Update (After 12 Hours Before Drop)**";
    }

    if (kind === "alert_1h") {
        return "**Rust Drop Update (1 Hour Before)**";
    }

    if (kind === "checkdrops") {
        return "**Rust Drop Update (/checkdrops)**";
    }

    return "Rust drop update";
}

/** Builds a cross-platform snapshot message body for timed/checkdrops announcements. */
function buildSnapshotContentLines(
    heading: string,
    activeDrops: Array<{ platform: string; title: string; endTime: string; endTimeMs?: number; channels?: string[] }>,
    upcomingDrops: Array<{ platform: string; title: string; startTime: string; startTimeMs?: number; channels?: string[] }>,
    mentionText: string,
    includeBlahLine: boolean
): string[] {
    const lines = [heading];
    const activeByPlatform = groupDropsByPlatform(activeDrops);
    const upcomingByPlatform = groupDropsByPlatform(upcomingDrops);

    for (const platform of ["twitch", "kick"] as const) {
        const platformActive = activeByPlatform.get(platform) ?? [];
        const platformUpcoming = upcomingByPlatform.get(platform) ?? [];

        lines.push(`Platform: **${capitalizePlatform(platform)}**`);

        if (platformActive.length > 0) {
            const { campaignSummary, mergedChannels, extremeTimeMs } = aggregatePlatformDrops(
                platformActive,
                (entry) => entry.endTimeMs ?? Date.parse(entry.endTime ?? ""),
                "max"
            );
            const channelsSummary = getChannelsSummaryForDrop({ platform, channels: mergedChannels });
            const channelConfidence = getChannelConfidence("active", mergedChannels);

            lines.push("Status: active");
            lines.push(`Channels: ${channelsSummary}`);
            if (mergedChannels.length > 0) {
                lines.push(`Channel confidence: ${channelConfidence}`);
            }
            lines.push(`Campaigns: ${campaignSummary || "none"}`);
            lines.push(`Ends: <t:${Math.floor(extremeTimeMs / 1000)}:R>`);
            continue;
        }

        if (platformUpcoming.length > 0) {
            const { campaignSummary, mergedChannels, extremeTimeMs } = aggregatePlatformDrops(
                platformUpcoming,
                (entry) => entry.startTimeMs ?? Date.parse(entry.startTime ?? ""),
                "min"
            );
            const channelsSummary = getChannelsSummaryForDrop({ platform, channels: mergedChannels });
            const channelConfidence = getChannelConfidence("upcoming", mergedChannels);

            lines.push("Status: upcoming");
            lines.push(`Channels: ${channelsSummary}`);
            if (mergedChannels.length > 0) {
                lines.push(`Channel confidence: ${channelConfidence}`);
            }
            lines.push(`Campaigns: ${campaignSummary || "none"}`);
            lines.push(`Starts: <t:${Math.floor(extremeTimeMs / 1000)}:R>`);
            continue;
        }

        lines.push("Status: none");
        lines.push("Channels: none");
        lines.push("Campaigns: none");
    }

    lines.push(`Auto-ping: ${mentionText}`);
    if (includeBlahLine) {
        lines.push("blah blah idk lmao");
    }
    return lines;
}

/** Formats channel summaries with links or fallback announcement text. */
function getChannelsSummaryForDrop(drop: { platform: string; channels?: string[] }): string {
    const channels = Array.from(new Set((drop.channels ?? []).map((value) => value.trim()).filter(Boolean)));
    if (channels.length === 0) {
        return getAnnouncementChannelsSummary(String(drop.platform));
    }

    const baseUrl = String(drop.platform).toLowerCase() === "kick" ? "https://kick.com" : "https://twitch.tv";
    return channels.map((channel) => `${channel} (${baseUrl}/${channel})`).join(", ");
}

/** Maps drop status and channel presence to user-facing confidence labels. */
function getChannelConfidence(
    dropStatus: "active" | "upcoming" | "none",
    channels: string[]
): "verified" | "discovered" | "unknown" {
    if (channels.length === 0) {
        return "unknown";
    }

    if (dropStatus === "active") {
        return "verified";
    }

    if (dropStatus === "upcoming") {
        return "discovered";
    }

    return "unknown";
}

/** Evaluates timed due windows, sends timed snapshots, and marks dedupe records. */
async function sendTimedUpcomingAlerts(
    textChannel: TextChannel,
    db: BotDb,
    intervalMs: number,
    now: Date,
    activeDrops: TimedDrop[],
    upcomingDrops: TimedDrop[]
): Promise<void> {
    const drops = upcomingDrops;
    const includeBlahLine = db.isBlahBlahIdkLmaoEnabled();
    const dueDropIdsByType = new Map<TimedAlertType, Set<number>>();
    const sentCheckCache = new Map<string, boolean>();
    const nowMs = now.getTime();
    const windowMinutes = Math.max(5, Math.ceil(intervalMs / (60 * 1000)));
    const isMorningWindow = isSydneyWindow(now, 6, windowMinutes);
    const isEveningWindow = isSydneyWindow(now, 18, windowMinutes);

    for (const drop of drops) {
        const dueTypes = getTimedAlertDueTypesFromMsWithWindows(
            drop.startTimeMs,
            nowMs,
            intervalMs,
            isMorningWindow,
            isEveningWindow
        );
        for (const dueType of dueTypes) {
            const existing = dueDropIdsByType.get(dueType) ?? new Set<number>();
            existing.add(drop.id);
            dueDropIdsByType.set(dueType, existing);
        }
    }

    for (const [dueType, dueDropIds] of dueDropIdsByType.entries()) {
        if (dueDropIds.size === 0) {
            continue;
        }

        const notificationType = getNotificationTypeForTimedAlert(dueType);
        const dueDropIdList = Array.from(dueDropIds);
        const eligibleUserIds = db.getUserIdsForAlert(dueType).filter((discordUserId) => {
            for (const dropId of dueDropIdList) {
                const cacheKey = `${discordUserId}:${dropId}:${notificationType}`;
                const wasSent = sentCheckCache.has(cacheKey)
                    ? sentCheckCache.get(cacheKey)
                    : db.wasUserNotificationSent(discordUserId, dropId, notificationType);

                if (!sentCheckCache.has(cacheKey)) {
                    sentCheckCache.set(cacheKey, Boolean(wasSent));
                }

                if (!wasSent) {
                    return true;
                }
            }

            return false;
        });

        const mentionText =
            eligibleUserIds.length > 0
                ? Array.from(new Set(eligibleUserIds.map((userId) => `<@${userId}>`))).join(" ")
                : "no mentions";

        const contentLines = buildSnapshotContentLines(
            getSnapshotHeading(dueType),
            activeDrops,
            upcomingDrops,
            mentionText,
            includeBlahLine
        );

        await sendMemeNotification(textChannel, db, contentLines);
        const notificationsToMark: Array<{ discordUserId: string; dropId: number; notificationType: string }> = [];
        for (const discordUserId of eligibleUserIds) {
            for (const dropId of dueDropIdList) {
                notificationsToMark.push({
                    discordUserId,
                    dropId,
                    notificationType
                });
            }
        }
        db.markUserNotificationsSentBatch(notificationsToMark);

        for (const discordUserId of eligibleUserIds) {
            for (const dropId of dueDropIdList) {
                sentCheckCache.set(`${discordUserId}:${dropId}:${notificationType}`, true);
            }
        }
    }
}

/**
 * Sends timed, live, and checkdrops reminder announcements for the current cycle.
 */
/**
 * Sends timed and live reminder announcements for the configured reminder channel.
 */
export async function sendActiveDropReminders(
    client: Client,
    db: BotDb,
    envChannelId?: string,
    options?: ReminderOptions
) {
    const totalStartMs = nowMs();
    const reminderChannelId = resolveReminderChannelId(db, envChannelId);
    if (!reminderChannelId) {
        return;
    }

    const fetchChannelStartMs = nowMs();
    const channel = await client.channels.fetch(reminderChannelId);
    logPerfSegment("reminders.fetchChannel", fetchChannelStartMs);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return;
    }

    const textChannel = channel as TextChannel;
    const intervalMs = options?.intervalMs ?? 5 * 60 * 1000;
    const loadDropsStartMs = nowMs();
    const activeDrops = db.getActiveDrops().map((drop) => ({
        ...drop,
        startTimeMs: Date.parse(drop.startTime),
        endTimeMs: Date.parse(drop.endTime)
    }));
    const upcomingDrops = db.getUpcomingDropsWithinHours(24).map((drop) => ({
        ...drop,
        startTimeMs: Date.parse(drop.startTime),
        endTimeMs: Date.parse(drop.endTime)
    }));
    logPerfSegment("reminders.loadDrops", loadDropsStartMs);

    const timedAlertsStartMs = nowMs();
    const now = new Date();
    await sendTimedUpcomingAlerts(textChannel, db, intervalMs, now, activeDrops, upcomingDrops);
    logPerfSegment("reminders.timedAlerts", timedAlertsStartMs);

    const includeBlahLine = db.isBlahBlahIdkLmaoEnabled();

    if (options?.forceAnnounce) {
        const forceMode = options.forceAnnounceMode ?? "verified";
        const snapshotActiveDrops =
            forceMode === "full"
                ? activeDrops
                : activeDrops.filter((drop) => (drop.channels ?? []).length > 0);
        const snapshotUpcomingDrops = forceMode === "full" ? upcomingDrops : [];
        const checkdropsUsers = db.getUserIdsForAlert("alert_checkdrops");
        const mentionText =
            checkdropsUsers.length > 0
                ? Array.from(new Set(checkdropsUsers.map((userId) => `<@${userId}>`))).join(" ")
                : "no mentions";

        await sendMemeNotification(
            textChannel,
            db,
            buildSnapshotContentLines(
                getSnapshotHeading("checkdrops"),
                snapshotActiveDrops,
                snapshotUpcomingDrops,
                mentionText,
                includeBlahLine
            )
        );
        logPerfSegment("reminders.total", totalStartMs);
        return;
    }

    type AnnouncedDrop = {
        drop: (typeof activeDrops)[number];
        eligibleUserIds: string[];
    };

    const announcedDrops: AnnouncedDrop[] = [];
    const eligibleUsersByDropId = db.getEligibleAutoPingUserIdsForDrops(
        activeDrops.map((drop) => drop.id),
        "drop_live"
    );
    for (const drop of activeDrops) {
        const eligibleUserIds = eligibleUsersByDropId.get(drop.id) ?? [];

        if (!options?.forceAnnounce && eligibleUserIds.length === 0) {
            continue;
        }

        announcedDrops.push({ drop, eligibleUserIds });
    }

    if (announcedDrops.length === 0) {
        return;
    }

    const mentionUserIdsSet = new Set<string>();
    for (const item of announcedDrops) {
        for (const userId of item.eligibleUserIds) {
            mentionUserIdsSet.add(userId);
        }
    }
    const allMentionUserIds = Array.from(mentionUserIdsSet);
    const mentionText =
        allMentionUserIds.length > 0
            ? allMentionUserIds.map((userId) => `<@${userId}>`).join(" ")
            : "no mentions";

    const dropsByPlatform = new Map<string, Array<(typeof activeDrops)[number]>>();
    for (const item of announcedDrops) {
        const key = String(item.drop.platform).toLowerCase();
        const existing = dropsByPlatform.get(key) ?? [];
        existing.push(item.drop);
        dropsByPlatform.set(key, existing);
    }

    const contentLines = ["Rust drop update"];
    for (const [platform, platformDrops] of dropsByPlatform) {
        const mergedChannelsSet = new Set<string>();
        const campaignSummarySet = new Set<string>();
        let furthestEndMs = Number.NaN;
        for (const entry of platformDrops) {
            campaignSummarySet.add(entry.title);
            for (const channel of entry.channels ?? []) {
                mergedChannelsSet.add(channel);
            }

            const endMs = entry.endTimeMs;
            if (Number.isNaN(furthestEndMs) || endMs > furthestEndMs) {
                furthestEndMs = endMs;
            }
        }
        const mergedChannels = Array.from(mergedChannelsSet);
        const channelsSummary = getChannelsSummaryForDrop({
            platform,
            channels: mergedChannels
        });
        const channelConfidence = getChannelConfidence("active", mergedChannels);
        const dedupedCampaignSummary = Array.from(campaignSummarySet).join(", ");

        contentLines.push(`Platform: **${capitalizePlatform(platform)}**`);
        contentLines.push(`Channels: ${channelsSummary}`);
        if (mergedChannels.length > 0) {
            contentLines.push(`Channel confidence: ${channelConfidence}`);
        }
        contentLines.push(`Campaigns: ${dedupedCampaignSummary || "none"}`);
        contentLines.push(`Ends: <t:${Math.floor(furthestEndMs / 1000)}:R>`);
    }

    contentLines.push(`Auto-ping: ${mentionText}`);
    if (includeBlahLine) {
        contentLines.push("blah blah idk lmao");
    }

    await sendMemeNotification(
        textChannel,
        db,
        contentLines
    );

    const liveNotificationsToMark: Array<{ discordUserId: string; dropId: number; notificationType: string }> = [];
    for (const item of announcedDrops) {
        for (const discordUserId of item.eligibleUserIds) {
            liveNotificationsToMark.push({
                discordUserId,
                dropId: item.drop.id,
                notificationType: "drop_live"
            });
        }
    }
    db.markUserNotificationsSentBatch(liveNotificationsToMark);
    logPerfSegment("reminders.total", totalStartMs);
}

function capitalizePlatform(platform: string): string {
    if (!platform) {
        return platform;
    }

    return platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase();
}

function groupDropsByPlatform<T extends { platform: string }>(
    drops: T[]
): Map<string, T[]> {
    const grouped = new Map<string, T[]>();

    for (const drop of drops) {
        const key = String(drop.platform).toLowerCase();
        const existing = grouped.get(key);
        if (existing) {
            existing.push(drop);
        } else {
            grouped.set(key, [drop]);
        }
    }

    return grouped;
}
