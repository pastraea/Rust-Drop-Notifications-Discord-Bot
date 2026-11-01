import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KickDropsProvider } from "./kick.js";

const HOUR = 60 * 60 * 1000;
const API_V2 = "https://kick.com/api/v2/drops/campaigns";
const API_V1 = "https://kick.com/api/v1/drops/campaigns";
const FACEPUNCH = "https://kick.facepunch.com/";
const TILE = "https://kick.facepunch.com/?handler=Tile&hashedId=";

type Route = (url: string) => Response | Promise<Response> | undefined;

/** Routes fetch by URL, records every requested URL, and fails loudly on anything unexpected. */
function mockFetch(t: TestContext, route: Route): string[] {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        const response = await route(url);
        if (!response) throw new Error(`Unexpected request: ${url}`);
        return response;
    });
    return requests;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body: string, status = 200) => new Response(body, { status });

function countdownPage(startMs: number, endMs: number, index = 0): string {
    return `<script>setupCountdown('.campaign-${index}', ${startMs}, ${endMs});</script>`;
}

test("mock mode returns one deterministic upcoming drop and never touches the network", async (t) => {
    const requests = mockFetch(t, () => undefined);
    const provider = new KickDropsProvider(true);

    const drops = await provider.fetchRustDrops();

    assert.equal(drops.length, 1);
    assert.equal(drops[0].externalId, "ki-rust-001");
    assert.equal(drops[0].status, "upcoming");
    assert.equal(provider.getSourceStatus(), "mock data");
    assert.deepEqual(requests, []);
});

test("API campaigns are normalized: ids, titles, channels, statuses, and ended campaigns dropped", async (t) => {
    const now = Date.now();
    const requests = mockFetch(t, (url) =>
        url === API_V2
            ? json([
                  {
                      id: 7,
                      title: "  Scrap Week ",
                      starts_at: new Date(now - HOUR).toISOString(),
                      ends_at: new Date(now + HOUR).toISOString(),
                      channels: [{ slug: " Alpha " }, { username: "beta" }, { name: "alpha" }, { slug: "Alpha" }, {}]
                  },
                  { slug: "future-event", name: "Fallback Name", start_at: new Date(now + 2 * HOUR).toISOString(), end_at: new Date(now + 4 * HOUR).toISOString() },
                  { id: "old", title: "Old", starts_at: new Date(now - 4 * HOUR).toISOString(), ends_at: new Date(now - 2 * HOUR).toISOString() },
                  { id: "forced", status: "LIVE now", starts_at: new Date(now + 5 * HOUR).toISOString(), ends_at: new Date(now + 6 * HOUR).toISOString() },
                  { starts_at: new Date(now + HOUR).toISOString(), ends_at: new Date(now + 2 * HOUR).toISOString() }
              ])
            : undefined
    );
    const provider = new KickDropsProvider(false);

    const drops = await provider.fetchRustDrops();

    assert.deepEqual(requests, [API_V2], "a successful API answer must not trigger the Facepunch fallback");
    assert.equal(provider.getSourceStatus(), "live (Kick API campaigns endpoint)");
    assert.equal(drops.length, 4, "the ended campaign is filtered out");

    const byId = new Map(drops.map((drop) => [drop.externalId, drop]));
    const scrap = byId.get("ki-api-7");
    assert.equal(scrap?.title, "Scrap Week");
    assert.equal(scrap?.status, "active");
    assert.deepEqual([...(scrap?.channels ?? [])].sort(), ["Alpha", "alpha", "beta"], "channels are trimmed and exactly-duplicate names collapse");
    assert.equal(scrap?.game, "rust");
    assert.equal(scrap?.platform, "kick");

    const future = byId.get("ki-api-future-event");
    assert.equal(future?.title, "Fallback Name");
    assert.equal(future?.status, "upcoming");
    assert.equal(byId.get("ki-api-forced")?.status, "active", "an explicit status wins over timestamps");
    assert.equal(byId.get("ki-api-4")?.title, "Kick Rust Drops Campaign 5", "id and title fall back to the list position");
});

test("API payloads may be wrapped in data or campaigns", async (t) => {
    const now = Date.now();
    const campaign = { id: 1, title: "A", starts_at: new Date(now + HOUR).toISOString(), ends_at: new Date(now + 2 * HOUR).toISOString() };

    for (const body of [{ data: [campaign] }, { campaigns: [campaign] }]) {
        mockFetch(t, (url) => (url === API_V2 ? json(body) : undefined));
        const drops = await new KickDropsProvider(false).fetchRustDrops();
        assert.equal(drops.length, 1);
        t.mock.reset();
    }
});

test("when v2 fails the v1 endpoint is used", async (t) => {
    const now = Date.now();
    const requests = mockFetch(t, (url) => {
        if (url === API_V2) return json({ error: "blocked" }, 403);
        if (url === API_V1) {
            return json([{ id: 9, title: "From v1", starts_at: new Date(now + HOUR).toISOString(), ends_at: new Date(now + 3 * HOUR).toISOString() }]);
        }
        return undefined;
    });

    const drops = await new KickDropsProvider(false).fetchRustDrops();

    assert.deepEqual(requests, [API_V2, API_V1]);
    assert.equal(drops[0].title, "From v1");
});

test("with no API data the Facepunch countdown is parsed, with channels discovered from the page and tiles", async (t) => {
    const now = Date.now();
    const page = `
        ${countdownPage(now + HOUR, now + 5 * HOUR, 0)}
        <a href="https://kick.com/Streamer_One">one</a>
        <a href="https://kick.com/category">not a channel</a>
        <a href="https://kick.com/drops">not a channel</a>
        <a href="/streamer-two">two</a>
        <div data-streamer-hash="hash/with space"></div>`;
    const requests = mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html(page);
        if (url === `${TILE}${encodeURIComponent("hash/with space")}`) return html('<a href="https://kick.com/tile-streamer">x</a>');
        return undefined;
    });
    const provider = new KickDropsProvider(false);

    const drops = await provider.fetchRustDrops();

    assert.equal(drops.length, 1);
    assert.equal(drops[0].externalId, `ki-facepunch-0-${now + HOUR}-${now + 5 * HOUR}`);
    assert.equal(drops[0].title, "Rust Kick Drops Campaign 1");
    assert.equal(drops[0].status, "upcoming");
    assert.deepEqual([...(drops[0].channels ?? [])].sort(), ["streamer-two", "streamer_one", "tile-streamer"]);
    assert.equal(provider.getSourceStatus(), "live fallback (Facepunch timing + tile/html channel discovery)");
    assert.ok(requests.includes(`${TILE}${encodeURIComponent("hash/with space")}`), "tile lookups must URL-encode the hash");
});

test("discovered channels are cached, so a second cycle does not refetch tiles", async (t) => {
    const now = Date.now();
    const page = `${countdownPage(now + HOUR, now + 2 * HOUR)}<div data-streamer-hash="h1"></div>`;
    const requests = mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html(page);
        if (url.startsWith(TILE)) return html('<a href="https://kick.com/cached-streamer">x</a>');
        return undefined;
    });
    const provider = new KickDropsProvider(false);

    const first = await provider.fetchRustDrops();
    const second = await provider.fetchRustDrops();

    assert.deepEqual(first[0].channels, ["cached-streamer"]);
    assert.deepEqual(second[0].channels, ["cached-streamer"]);
    assert.equal(requests.filter((url) => url.startsWith(TILE)).length, 1);
});

test("a failing tile does not lose the other channels", async (t) => {
    const now = Date.now();
    const page = `${countdownPage(now + HOUR, now + 2 * HOUR)}<a href="https://kick.com/page-streamer">x</a><div data-streamer-hash="bad"></div><div data-streamer-hash="good"></div>`;
    mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html(page);
        if (url === `${TILE}bad`) return html("nope", 404);
        if (url === `${TILE}good`) return html('<a href="https://kick.com/good-streamer">x</a>');
        return undefined;
    });

    const drops = await new KickDropsProvider(false).fetchRustDrops();

    assert.deepEqual([...(drops[0].channels ?? [])].sort(), ["good-streamer", "page-streamer"]);
});

test("a Facepunch page with a countdown but no channels still returns the drop", async (t) => {
    const now = Date.now();
    mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html(countdownPage(now + HOUR, now + 2 * HOUR));
        return undefined;
    });
    const provider = new KickDropsProvider(false);

    const drops = await provider.fetchRustDrops();

    assert.equal(drops.length, 1);
    assert.deepEqual(drops[0].channels, []);
    assert.equal(provider.getSourceStatus(), "live fallback (Facepunch timing parser)");
});

test("invalid and duplicate countdowns are ignored", async (t) => {
    const now = Date.now();
    const page = [
        countdownPage(now + 2 * HOUR, now + HOUR, 0), // ends before it starts
        countdownPage(now + HOUR, now + 2 * HOUR, 1),
        countdownPage(now + HOUR, now + 2 * HOUR, 1) // exact duplicate
    ].join("\n");
    mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html(page);
        return undefined;
    });

    const drops = await new KickDropsProvider(false).fetchRustDrops();

    assert.equal(drops.length, 1);
    assert.equal(drops[0].title, "Rust Kick Drops Campaign 2");
});

test("a page with no countdown yields no drops without error", async (t) => {
    mockFetch(t, (url) => {
        if (url === API_V2 || url === API_V1) return json([]);
        if (url === FACEPUNCH) return html("<html>nothing scheduled</html>");
        return undefined;
    });
    const provider = new KickDropsProvider(false);

    assert.deepEqual(await provider.fetchRustDrops(), []);
    assert.equal(provider.getSourceStatus(), "live fallback (Facepunch timing parser)");
});

test("when every source fails the provider returns no drops, reports an error status, and logs it", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    mockFetch(t, (url) => (url === FACEPUNCH ? html("blocked", 403) : json({ error: "blocked" }, 403)));
    const provider = new KickDropsProvider(false);

    assert.deepEqual(await provider.fetchRustDrops(), []);
    assert.equal(provider.getSourceStatus(), "error (provider fetch failed)");
    assert.equal(logged.length, 1);
});
