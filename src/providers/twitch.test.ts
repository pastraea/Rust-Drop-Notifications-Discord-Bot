import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TwitchDropsProvider } from "./twitch.js";

const START_MS = 1792778400000;
const END_MS = 1793577540000;
const START_ISO = "2026-10-23T18:00:00.000Z";
const END_ISO = "2026-11-01T23:59:00.000Z";

function campaignHtml(index = 0, startMs = START_MS, endMs = END_MS): string {
    return `
        <div class="campaign campaign-${index} not-started">
            <h2 class="event-title">Base Invaders</h2>
            <div class="event-date">
                <span class="date" data-date-id="start-${startMs / 1000}">October 23, 2026 at 6:00 PM UTC</span>
                <script>
                    document.querySelectorAll("[data-date-id='start-${startMs / 1000}']");
                    new Date(${startMs}).toLocaleString();
                </script>
                <span class="date" data-date-id="end-${endMs / 1000}">November 1, 2026 at 11:59 PM UTC</span>
                <script>
                    document.querySelectorAll("[data-date-id='end-${endMs / 1000}']");
                    new Date(${endMs}).toLocaleString();
                </script>
            </div>
        </div>
        <script>setupCountdown('.campaign-${index}', 0, ${startMs});</script>
        <div class="hero-countdown counter campaign-${index}">starts in</div>
        <div class="section drops streamer-drops campaign campaign-${index} not-started"></div>
    `;
}

function mockFacepunch(t: TestContext, html: string, nowMs = START_MS - 1000): TwitchDropsProvider {
    t.mock.method(Date, "now", () => nowMs);
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        if (String(input) === "https://twitch.facepunch.com/") {
            return new Response(html);
        }
        throw new Error(`Unexpected request: ${String(input)}`);
    });
    return new TwitchDropsProvider({ useMockData: false });
}

test("upcoming Facepunch countdown uses published dates, not epoch-to-start range", async (t) => {
    const provider = mockFacepunch(t, campaignHtml());
    assert.deepEqual(await provider.fetchRustDrops(), [{
        platform: "twitch",
        externalId: `tw-facepunch-0-${START_MS}-${END_MS}`,
        title: "Base Invaders",
        channels: [],
        hasGeneralDrops: false,
        game: "rust",
        startTime: START_ISO,
        endTime: END_ISO,
        status: "upcoming"
    }]);
    assert.equal(new Date(START_ISO).toLocaleString("en-AU", {
        timeZone: "Australia/Sydney", hour12: false
    }), "24/10/2026, 05:00:00");
    assert.equal(new Date(END_ISO).toLocaleString("en-AU", {
        timeZone: "Australia/Sydney", hour12: false
    }), "02/11/2026, 10:59:00");
});

for (const [label, nowMs, status] of [
    ["before start", START_MS - 1, "upcoming"],
    ["at start", START_MS, "active"],
    ["during campaign", END_MS - 1, "active"],
    ["at end", END_MS, "ended"]
] as const) {
    test(`Facepunch status ${label} is ${status}`, async (t) => {
        const provider = mockFacepunch(t, campaignHtml(), nowMs);
        const [drop] = await provider.fetchRustDrops();
        assert.equal(drop?.status, status);
        assert.equal(drop?.endTime, END_ISO);
    });
}

test("published dates override countdown timing and preserve identity after launch", async (t) => {
    const html = campaignHtml();
    const provider = mockFacepunch(t, html);
    const [upcoming] = await provider.fetchRustDrops();
    t.mock.method(Date, "now", () => START_MS);
    t.mock.method(globalThis, "fetch", async () => new Response(
        html.replace(`0, ${START_MS}`, `${START_MS}, ${END_MS}`)
    ));
    const [active] = await provider.fetchRustDrops();
    assert.equal(active?.externalId, upcoming?.externalId);
    assert.equal(active?.status, "active");
    assert.equal(active?.endTime, END_ISO);
});

test("each campaign gets its own dates without duplicate streamer sections", async (t) => {
    const provider = mockFacepunch(t, campaignHtml() + campaignHtml(1, END_MS, END_MS + 86400000));
    const drops = await provider.fetchRustDrops();
    assert.equal(drops.length, 2);
    assert.equal(drops[0]?.startTime, START_ISO);
    assert.equal(drops[0]?.endTime, END_ISO);
    assert.equal(drops[1]?.startTime, END_ISO);
    assert.equal(drops[1]?.endTime, "2026-11-02T23:59:00.000Z");
});

test("published dates work without a countdown script", async (t) => {
    const provider = mockFacepunch(t, campaignHtml().replace(/<script>setupCountdown[^<]*<\/script>/, ""));
    const [drop] = await provider.fetchRustDrops();
    assert.equal(drop?.startTime, START_ISO);
    assert.equal(drop?.endTime, END_ISO);
});

test("legacy countdown-only pages still parse and deduplicate", async (t) => {
    const countdown = `setupCountdown('.campaign-0', ${START_MS}, ${END_MS});`;
    const provider = mockFacepunch(t, countdown + countdown);
    const drops = await provider.fetchRustDrops();
    assert.equal(drops.length, 1);
    assert.equal(drops[0]?.startTime, START_ISO);
    assert.equal(drops[0]?.endTime, END_ISO);
    assert.equal(drops[0]?.status, "upcoming");
});

for (const [label, html] of [
    ["upcoming countdown with no published range", `setupCountdown('.campaign-0', 0, ${START_MS});`],
    ["partial published range", campaignHtml().replace(/<span class="date" data-date-id="end-[^<]+<\/span>/, "")],
    ["reversed published range", campaignHtml(0, END_MS, START_MS)],
    ["out-of-range countdown", "setupCountdown('.campaign-0', 1792778400000, 999999999999999999);"]
] as const) {
    test(`${label} fails explicitly instead of returning false campaign data`, async (t) => {
        const provider = mockFacepunch(t, html);
        await assert.rejects(provider.fetchRustDrops(), /campaign.*(dates|date range)/);
        assert.equal(provider.getSourceStatus(), "error (provider fetch failed)");
    });
}

test("page with no campaigns returns an empty list", async (t) => {
    const provider = mockFacepunch(t, "<html>No Rust drops currently available</html>");
    assert.deepEqual(await provider.fetchRustDrops(), []);
});

test("official Facepunch data is authoritative even with Twitch API credentials configured", async (t) => {
    mockFacepunch(t, campaignHtml());
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        requests.push(String(input));
        assert.equal(String(input), "https://twitch.facepunch.com/");
        return new Response(campaignHtml());
    });
    const provider = new TwitchDropsProvider({
        useMockData: false, clientId: "test-client", clientSecret: "test-secret"
    });
    const [drop] = await provider.fetchRustDrops();
    assert.equal(drop?.externalId, `tw-facepunch-0-${START_MS}-${END_MS}`);
    assert.deepEqual(requests, ["https://twitch.facepunch.com/"]);
});

for (const [label, campaign, valid] of [
    ["missing dates", { id: "api", status: "ACTIVE" }, false],
    ["invalid dates", { id: "api", starts_at: "not-a-date", ends_at: END_ISO }, false],
    ["reversed dates", { id: "api", starts_at: END_ISO, ends_at: START_ISO }, false],
    ["inactive status", { id: "api", status: "INACTIVE", starts_at: START_ISO, ends_at: END_ISO }, false],
    ["premature active status", {
        id: "api", status: "ACTIVE", starts_at: START_ISO, ends_at: END_ISO,
        allow: { channels: [{ broadcaster_login: "twitchrivals" }] }
    }, true]
] as const) {
    test(`Helix fallback ${label} uses valid dates and respects campaign availability`, async (t) => {
        mockFacepunch(t, "");
        t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
            const url = String(input);
            if (url.startsWith("https://id.twitch.tv/")) {
                return Response.json({ access_token: "test-token", expires_in: 3600 });
            }
            if (url.includes("/games?")) {
                return Response.json({ data: [{ id: "rust" }] });
            }
            if (url.includes("/drops/campaigns?")) {
                return Response.json({ data: [campaign] });
            }
            if (url === "https://twitch.facepunch.com/") {
                return new Response("Service unavailable", { status: 403 });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        const provider = new TwitchDropsProvider({
            useMockData: false, clientId: "test-client", clientSecret: "test-secret"
        });
        if (!valid) {
            await assert.rejects(provider.fetchRustDrops(), /status 403/);
            return;
        }
        const [drop] = await provider.fetchRustDrops();
        assert.equal(drop?.startTime, START_ISO);
        assert.equal(drop?.endTime, END_ISO);
        assert.equal(drop?.status, "upcoming");
        assert.ok(drop?.externalId.startsWith("tw-helix-"));
        assert.deepEqual(drop?.channels, ["twitchrivals"]);
    });
}

function withParticipation(html: string, index: number, login: string, general = false): string {
    return html.replace(
        `<div class="section drops streamer-drops campaign campaign-${index} not-started"></div>`,
        `<div class="section drops streamer-drops campaign campaign-${index} not-started">
            <a href="https://www.twitch.tv/${login}" class="streamer-info">Streamer</a>
            <a class="drop-box-body" href="https://www.twitch.tv/${login.toUpperCase()}">Item</a>
            <a class="streamer-info" href="https://www.twitch.tv/directory">Directory</a>
            <a class="streamer-info" href="https://www.twitch.tv.evil.example/stranger">Not Twitch</a>
            <a href="https://www.twitch.tv/unrelated">Unrelated link</a>
            ${general ? '<div class="drops-container general-drops-grid"><a class="drop-box" href="">General drop</a></div>' : ""}
        </div>`
    );
}

test("streamer channels come only from campaign drop cards, not directories or unrelated links", async (t) => {
    const provider = mockFacepunch(t, withParticipation(campaignHtml(), 0, "TwitchRivals", true));
    const [drop] = await provider.fetchRustDrops();
    assert.deepEqual(drop?.channels, ["twitchrivals"]);
    assert.equal(drop?.hasGeneralDrops, true);
});

test("multiple campaigns keep streamer lists and general-drop availability separate", async (t) => {
    const html = withParticipation(campaignHtml(), 0, "TwitchRivals", true)
        + withParticipation(campaignHtml(1, END_MS, END_MS + 86400000), 1, "OtherStreamer");
    const provider = mockFacepunch(t, html);
    const drops = await provider.fetchRustDrops();
    assert.deepEqual(drops.map((drop) => drop.channels), [["twitchrivals"], ["otherstreamer"]]);
    assert.deepEqual(drops.map((drop) => drop.hasGeneralDrops), [true, false]);
});

test("a successful refresh replaces participants instead of using stale discovery results", async (t) => {
    const provider = mockFacepunch(t, withParticipation(campaignHtml(), 0, "OldStreamer"));
    const [before] = await provider.fetchRustDrops();
    assert.deepEqual(before?.channels, ["oldstreamer"]);
    t.mock.method(globalThis, "fetch", async () => new Response(
        withParticipation(campaignHtml(), 0, "NewStreamer")
    ));
    const [after] = await provider.fetchRustDrops();
    assert.deepEqual(after?.channels, ["newstreamer"]);
});
