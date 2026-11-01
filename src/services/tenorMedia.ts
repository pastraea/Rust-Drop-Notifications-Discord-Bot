/**
 * Tenor GIF resolution and download shared by the command handlers and the reminder service.
 *
 * Two selection strategies exist on purpose:
 * - "first": the first GIF URL found on the page. Fast, so it suits interactive commands that must answer
 *   within Discord's response window.
 * - "best": prefers variants of the page's own asset, then probes candidate sizes with HEAD requests and picks
 *   the largest. Slower, so it is used for scheduled announcements.
 */

import { decodeHtmlEntities } from "./tenor.js";

export type TenorSelection = "first" | "best";

const USER_AGENT = "Mozilla/5.0";
const VIEW_FETCH_TIMEOUT_MS = 2500;
const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const PROBE_LIMIT = 8;

/** Decodes escaped Tenor media URL fragments extracted from page sources. */
export function decodeEscapedTenorUrl(value: string): string {
    return decodeHtmlEntities(value)
        .replaceAll("\\u002F", "/")
        .replaceAll("\\/", "/")
        .replace(/^https:\/\//i, "https://");
}

/** Extracts the Tenor media token segment from a direct media URL. */
export function getMediaToken(url: string): string | undefined {
    return url.match(/https:\/\/media(?:1)?\.tenor\.com\/(?:m\/)?([^/]+)\//i)?.[1];
}

/** Normalizes a Tenor media token to its base id for variant matching. */
export function getMediaBaseId(token: string): string {
    return token.replace(/AAA[A-Za-z0-9]+$/i, "");
}

/** Scores media URLs using heuristics that prefer larger/primary GIF variants. */
export function scoreMediaUrl(url: string, baseId?: string): number {
    const lower = url.toLowerCase();
    let score = 0;

    if (lower.endsWith(".gif")) score += 70;
    if (lower.includes("aaap")) score += 50;
    if (lower.includes("aaaam")) score += 30;
    if (lower.includes("aaaa")) score += 10;
    if (baseId && lower.includes(`/${baseId.toLowerCase()}`)) score += 40;

    return score;
}

export interface ParsedTenorPage {
    /** Unique direct GIF URLs found anywhere in the page, in page order. */
    candidates: string[];
    /** Base id of the page's own `og:image` asset, when present. */
    baseId?: string;
}

/** Pure parser for a Tenor view page. */
export function parseTenorPage(html: string): ParsedTenorPage {
    const ogImageMatch =
        html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
        html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    const ogImageUrl = decodeHtmlEntities(ogImageMatch?.[1] ?? "");
    const token = getMediaToken(ogImageUrl);

    const unescaped = html.match(/https:\/\/(?:media|media1)\.tenor\.com\/[^"'\s>]+/gi) ?? [];
    const escaped = html.match(/https:\\u002F\\u002F(?:media|media1)\.tenor\.com\\u002F[^"'\s>]+/gi) ?? [];
    const candidates = Array.from(new Set([...unescaped, ...escaped].map(decodeEscapedTenorUrl))).filter((url) =>
        /\.gif($|\?)/i.test(url)
    );

    return { candidates, baseId: token ? getMediaBaseId(token) : undefined };
}

export interface TenorMediaResolverOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** How long resolutions (including failures) and size probes are remembered. */
    ttlMs?: number;
}

export interface TenorMediaResolver {
    /** Resolves a Tenor view URL to one direct GIF URL, or undefined when none could be found. */
    resolve(viewUrl: string, selection: TenorSelection): Promise<string | undefined>;
    clear(): void;
}

export function createTenorMediaResolver(options: TenorMediaResolverOptions = {}): TenorMediaResolver {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const request = (input: string, init: RequestInit) => (options.fetchImpl ?? fetch)(input, init);
    const resolved = new Map<string, { mediaUrl: string | undefined; expiresAt: number }>();
    const lengths = new Map<string, { length: number; expiresAt: number }>();

    async function contentLength(url: string): Promise<number> {
        const cached = lengths.get(url);
        if (cached && cached.expiresAt > now()) return cached.length;

        let length = 0;
        try {
            const head = await request(url, {
                method: "HEAD",
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
            });
            const parsed = Number(head.headers.get("content-length"));
            length = Number.isFinite(parsed) ? parsed : 0;
        } catch {
            length = 0;
        }
        lengths.set(url, { length, expiresAt: now() + ttlMs });
        return length;
    }

    /** Combines URL heuristics with content-length probes of the most promising candidates. */
    async function chooseLargest(candidates: string[], baseId?: string): Promise<string | undefined> {
        const promising = candidates
            .map((url) => ({ url, heuristic: scoreMediaUrl(url, baseId) }))
            .sort((left, right) => right.heuristic - left.heuristic)
            .slice(0, PROBE_LIMIT);

        const scored = await Promise.all(
            promising.map(async ({ url, heuristic }) => ({ url, score: heuristic + (await contentLength(url)) }))
        );
        scored.sort((left, right) => right.score - left.score);
        return scored[0]?.url;
    }

    async function lookup(viewUrl: string, selection: TenorSelection): Promise<string | undefined> {
        try {
            const response = await request(viewUrl, {
                method: "GET",
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(VIEW_FETCH_TIMEOUT_MS)
            });
            if (!response.ok) return undefined;

            const { candidates, baseId } = parseTenorPage(await response.text());
            if (candidates.length === 0) return undefined;
            if (selection === "first") return candidates[0];

            const sameAsset = baseId
                ? candidates.filter((url) => {
                      const token = getMediaToken(url);
                      return token ? getMediaBaseId(token).toLowerCase() === baseId.toLowerCase() : false;
                  })
                : [];
            return chooseLargest(sameAsset.length > 0 ? sameAsset : candidates, baseId);
        } catch {
            return undefined;
        }
    }

    return {
        async resolve(viewUrl, selection) {
            if (!viewUrl) return undefined;

            const key = `${selection}|${viewUrl}`;
            const cached = resolved.get(key);
            if (cached && cached.expiresAt > now()) return cached.mediaUrl;

            const mediaUrl = await lookup(viewUrl, selection);
            resolved.set(key, { mediaUrl, expiresAt: now() + ttlMs });
            return mediaUrl;
        },
        clear() {
            resolved.clear();
            lengths.clear();
        }
    };
}

/** Shared resolver used by the application. */
export const tenorMedia = createTenorMediaResolver();

/** Downloads a media URL into memory, or returns undefined on any failure. */
export async function downloadMedia(
    mediaUrl: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): Promise<Buffer | undefined> {
    try {
        const response = await fetchImpl(mediaUrl, {
            method: "GET",
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) return undefined;
        return Buffer.from(await response.arrayBuffer());
    } catch {
        return undefined;
    }
}
