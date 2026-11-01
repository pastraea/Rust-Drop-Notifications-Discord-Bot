import assert from "node:assert/strict";
import test from "node:test";
import {
    createTenorMediaResolver,
    decodeEscapedTenorUrl,
    downloadMedia,
    getMediaBaseId,
    getMediaToken,
    parseTenorPage,
    scoreMediaUrl
} from "./tenorMedia.js";

const VIEW = "https://tenor.com/view/rust-meme-12345";
const SMALL = "https://media.tenor.com/abcAAAAM/rust.gif";
const PRIMARY = "https://media.tenor.com/abcAAAAP/rust.gif";
const OTHER = "https://media1.tenor.com/zzzAAAAC/other.gif";

const page = (body: string, og = "") => `<html><head>${og}</head><body>${body}</body></html>`;
const links = (...urls: string[]) => urls.map((url) => `<a href="${url}">x</a>`).join(" ");
const og = (url: string) => `<meta property="og:image" content="${url}">`;

interface Call {
    url: string;
    method?: string;
}

function mockFetch(routes: Record<string, () => Response>): { impl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method });
        const route = routes[`${init?.method ?? "GET"} ${url}`];
        if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
        return route();
    }) as typeof fetch;
    return { impl, calls };
}

test("escaped URLs are decoded: entities, unicode and JSON slashes", () => {
    assert.equal(decodeEscapedTenorUrl("https:\\u002F\\u002Fmedia.tenor.com\\u002Fa\\u002Fb.gif?x=1&amp;y=2"), "https://media.tenor.com/a/b.gif?x=1&y=2");
    assert.equal(decodeEscapedTenorUrl("https:\\/\\/media.tenor.com\\/a.gif"), "https://media.tenor.com/a.gif");
});

test("media tokens and base ids are extracted from media URLs", () => {
    assert.equal(getMediaToken("https://media.tenor.com/abcAAAAP/rust.gif"), "abcAAAAP");
    assert.equal(getMediaToken("https://media1.tenor.com/m/abcAAAAP/rust.gif"), "abcAAAAP");
    assert.equal(getMediaToken("https://example.com/abc/x.gif"), undefined);
    assert.equal(getMediaBaseId("abcAAAAP"), "abc");
    assert.equal(getMediaBaseId("plain"), "plain");
});

test("URL scoring prefers gif files, primary variants, and the page's own asset", () => {
    assert.ok(scoreMediaUrl(PRIMARY) > scoreMediaUrl(SMALL));
    assert.ok(scoreMediaUrl(SMALL, "abc") > scoreMediaUrl(SMALL));
    assert.ok(scoreMediaUrl("https://media.tenor.com/x/y.mp4") < scoreMediaUrl(SMALL));
});

test("parseTenorPage finds escaped and plain GIF URLs, drops non-GIFs, de-duplicates, and reads the og:image asset", () => {
    const html = page(
        `<a href="${SMALL}">a</a> <a href="${SMALL}">dup</a>
         <script>{"url":"https:\\u002F\\u002Fmedia.tenor.com\\u002FabcAAAAP\\u002Frust.gif"}</script>
         <video src="https://media.tenor.com/abcAAAAP/rust.mp4"></video>`,
        og("https://media.tenor.com/abcAAAAP/rust.png")
    );

    const parsed = parseTenorPage(html);

    assert.deepEqual(parsed.candidates, [SMALL, PRIMARY]);
    assert.equal(parsed.baseId, "abc");
    assert.deepEqual(parseTenorPage("<html>nothing</html>"), { candidates: [], baseId: undefined });
});

test("og:image is recognised with attributes in either order", () => {
    const reversed = `<meta content="https://media.tenor.com/abcAAAAP/x.png" property="og:image">`;
    assert.equal(parseTenorPage(reversed).baseId, "abc");
});

test("'first' returns the first GIF without probing any sizes", async () => {
    const { impl, calls } = mockFetch({ [`GET ${VIEW}`]: () => new Response(page(links(SMALL, PRIMARY))) });
    const resolver = createTenorMediaResolver({ fetchImpl: impl });

    assert.equal(await resolver.resolve(VIEW, "first"), SMALL);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("'best' keeps to the page's own asset and picks the larger variant using HEAD probes", async () => {
    const html = page(links(SMALL, PRIMARY, OTHER), og("https://media.tenor.com/abcAAAAM/rust.png"));
    const { impl, calls } = mockFetch({
        [`GET ${VIEW}`]: () => new Response(html),
        [`HEAD ${SMALL}`]: () => new Response(null, { headers: { "content-length": "100" } }),
        [`HEAD ${PRIMARY}`]: () => new Response(null, { headers: { "content-length": "900000" } })
    });
    const resolver = createTenorMediaResolver({ fetchImpl: impl });

    assert.equal(await resolver.resolve(VIEW, "best"), PRIMARY);
    assert.ok(!calls.some((c) => c.url === OTHER), "a variant of a different asset must not even be probed");
});

test("'best' still returns a result when size probes fail", async () => {
    const { impl } = mockFetch({
        [`GET ${VIEW}`]: () => new Response(page(links(SMALL, PRIMARY))),
        [`HEAD ${SMALL}`]: () => {
            throw new Error("timeout");
        },
        [`HEAD ${PRIMARY}`]: () => new Response(null, { headers: { "content-length": "not-a-number" } })
    });

    assert.equal(await createTenorMediaResolver({ fetchImpl: impl }).resolve(VIEW, "best"), PRIMARY, "heuristics still rank the primary variant first");
});

test("results are cached per strategy until the TTL passes, then refetched", async () => {
    let clock = 1_000;
    let fetches = 0;
    const { impl } = mockFetch({
        [`GET ${VIEW}`]: () => {
            fetches++;
            return new Response(page(links(SMALL)));
        },
        [`HEAD ${SMALL}`]: () => new Response(null, { headers: { "content-length": "1" } })
    });
    const resolver = createTenorMediaResolver({ fetchImpl: impl, now: () => clock, ttlMs: 60_000 });

    await resolver.resolve(VIEW, "first");
    await resolver.resolve(VIEW, "first");
    assert.equal(fetches, 1, "the second call is served from cache");

    await resolver.resolve(VIEW, "best");
    assert.equal(fetches, 2, "a different strategy has its own cache entry");

    clock += 60_001;
    await resolver.resolve(VIEW, "first");
    assert.equal(fetches, 3, "an expired entry is refetched");
});

test("failures are cached too, so a dead link is not hammered, and expire like successes", async () => {
    let clock = 0;
    let fetches = 0;
    const statuses = [404, 200];
    const { impl } = mockFetch({
        [`GET ${VIEW}`]: () => {
            fetches++;
            return statuses[fetches - 1] === 200 ? new Response(page(links(SMALL))) : new Response("gone", { status: 404 });
        }
    });
    const resolver = createTenorMediaResolver({ fetchImpl: impl, now: () => clock, ttlMs: 1000 });

    assert.equal(await resolver.resolve(VIEW, "first"), undefined);
    assert.equal(await resolver.resolve(VIEW, "first"), undefined);
    assert.equal(fetches, 1);

    clock += 1001;
    assert.equal(await resolver.resolve(VIEW, "first"), SMALL, "a recovered page resolves once the failure expires");
});

test("pages without GIFs, network errors and empty input all resolve to undefined", async () => {
    const { impl } = mockFetch({ [`GET ${VIEW}`]: () => new Response(page("<p>no gifs here</p>")) });
    const resolver = createTenorMediaResolver({ fetchImpl: impl });
    assert.equal(await resolver.resolve(VIEW, "first"), undefined);
    assert.equal(await resolver.resolve("", "first"), undefined);

    const failing = createTenorMediaResolver({
        fetchImpl: (async () => {
            throw new TypeError("fetch failed");
        }) as typeof fetch
    });
    assert.equal(await failing.resolve(VIEW, "best"), undefined);
});

test("clear() forgets cached results", async () => {
    let fetches = 0;
    const { impl } = mockFetch({
        [`GET ${VIEW}`]: () => {
            fetches++;
            return new Response(page(links(SMALL)));
        }
    });
    const resolver = createTenorMediaResolver({ fetchImpl: impl });

    await resolver.resolve(VIEW, "first");
    resolver.clear();
    await resolver.resolve(VIEW, "first");

    assert.equal(fetches, 2);
});

test("downloadMedia returns the bytes, and undefined for error statuses and network failures", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const ok = (async () => new Response(bytes)) as typeof fetch;
    const notFound = (async () => new Response("no", { status: 404 })) as typeof fetch;
    const broken = (async () => {
        throw new TypeError("fetch failed");
    }) as typeof fetch;

    assert.deepEqual(await downloadMedia("https://media.tenor.com/a.gif", 1000, ok), bytes);
    assert.equal(await downloadMedia("https://media.tenor.com/a.gif", 1000, notFound), undefined);
    assert.equal(await downloadMedia("https://media.tenor.com/a.gif", 1000, broken), undefined);
});
