import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TwitchDropsProvider } from "./twitch.js";

const FACEPUNCH = "https://twitch.facepunch.com/";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const START_MS = 1792778400000;
const END_MS = 1793577540000;
const START_ISO = new Date(START_MS).toISOString();
const END_ISO = new Date(END_MS).toISOString();
const NOW_MS = START_MS - 1000;
const SECRET = "super-secret-client-value";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

interface Harness {
    requests: Array<{ url: string; init?: RequestInit }>;
    warnings: unknown[][];
    errors: unknown[][];
}

/** Freezes time, silences logging (while recording it), and routes fetch by URL. */
function harness(t: TestContext, handler: Handler): Harness {
    const state: Harness = { requests: [], warnings: [], errors: [] };
    t.mock.method(Date, "now", () => NOW_MS);
    t.mock.method(console, "warn", (...args: unknown[]) => void state.warnings.push(args));
    t.mock.method(console, "error", (...args: unknown[]) => void state.errors.push(args));
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        state.requests.push({ url, init });
        const response = await handler(url, init);
        if (!response) throw new Error(`Unexpected request: ${url}`);
        return response;
    });
    return state;
}

function facepunch(...blocks: string[]): string {
    return blocks.join("\n");
}

/** One published campaign; every part can be overridden to build deliberately broken markup. */
function campaign(options: { index?: number; title?: string; start?: string; end?: string } = {}): string {
    const index = options.index ?? 0;
    const start = options.start ?? `<span data-date-id="start-${START_MS / 1000}">start</span>`;
    const end = options.end ?? `<span data-date-id="end-${END_MS / 1000}">end</span>`;
    const title = options.title ?? "Base Invaders";
    return `<div class="campaign campaign-${index}"><h2 class="event-title">${title}</h2>${start}${end}</div>`;
}

const helixOk = (campaigns: unknown) => (url: string): Response | undefined => {
    if (url.startsWith(TOKEN_URL)) return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/games?")) return Response.json({ data: [{ id: "rust-id" }] });
    if (url.includes("/drops/campaigns?")) return Response.json(campaigns);
    return undefined;
};

/** Facepunch is down, so the Helix fallback decides the outcome. */
const withFacepunchDown = (inner: Handler): Handler => (url, init) =>
    url === FACEPUNCH ? new Response("down", { status: 403 }) : inner(url, init);

const credentials = { useMockData: false, clientId: "client", clientSecret: SECRET };

test("mock mode returns one active drop without any network access", async (t) => {
    const { requests } = harness(t, () => undefined);
    const provider = new TwitchDropsProvider({ useMockData: true });

    const drops = await provider.fetchRustDrops();

    assert.equal(drops.length, 1);
    assert.equal(drops[0].externalId, "tw-rust-001");
    assert.equal(drops[0].status, "active");
    assert.equal(provider.getSourceStatus(), "mock data");
    assert.deepEqual(requests, []);
});

test("a campaign with only one published date fails the sync instead of inventing the other", async (t) => {
    harness(t, (url) => (url === FACEPUNCH ? new Response(facepunch(campaign({ end: "" }))) : undefined));
    const provider = new TwitchDropsProvider({ useMockData: false });

    await assert.rejects(provider.fetchRustDrops(), /missing or invalid published dates/);
    assert.equal(provider.getSourceStatus(), "error (provider fetch failed)");
});

for (const [label, parts] of [
    ["non-numeric timestamps", { start: '<span data-date-id="start-abc">x</span>', end: '<span data-date-id="end-def">x</span>' }],
    ["an end before the start", { start: `<span data-date-id="start-${END_MS / 1000}">x</span>`, end: `<span data-date-id="end-${START_MS / 1000}">x</span>` }],
    ["a zero timestamp", { start: '<span data-date-id="start-0">x</span>', end: `<span data-date-id="end-${END_MS / 1000}">x</span>` }]
] as const) {
    test(`published dates with ${label} are rejected`, async (t) => {
        harness(t, (url) => (url === FACEPUNCH ? new Response(facepunch(campaign(parts))) : undefined));

        await assert.rejects(new TwitchDropsProvider({ useMockData: false }).fetchRustDrops(), /invalid published dates|no valid campaign date range/);
    });
}

test("one malformed campaign among valid ones fails the whole sync, so stored data is not half-replaced", async (t) => {
    harness(t, (url) => (url === FACEPUNCH ? new Response(facepunch(campaign({ index: 0 }), campaign({ index: 1, end: "" }))) : undefined));

    await assert.rejects(new TwitchDropsProvider({ useMockData: false }).fetchRustDrops(), /Facepunch campaign 1/);
});

test("titles decode ampersands, strip nested tags, and fall back to a numbered name", async (t) => {
    harness(t, (url) =>
        url === FACEPUNCH
            ? new Response(facepunch(campaign({ index: 0, title: "Rust &amp; <b>Friends</b>" }), campaign({ index: 4, title: "   " })))
            : undefined
    );

    const drops = await new TwitchDropsProvider({ useMockData: false }).fetchRustDrops();

    assert.equal(drops.find((d) => d.externalId.startsWith("tw-facepunch-0-"))?.title, "Rust & Friends");
    assert.equal(drops.find((d) => d.externalId.startsWith("tw-facepunch-4-"))?.title, "Rust Twitch Drops Campaign 5");
});

test("a 5xx from Facepunch is retried before the fallback is considered", async (t) => {
    let calls = 0;
    harness(t, (url) => {
        if (url !== FACEPUNCH) return undefined;
        calls++;
        return calls === 1 ? new Response("oops", { status: 503 }) : new Response(facepunch(campaign()));
    });

    const drops = await new TwitchDropsProvider({ useMockData: false }).fetchRustDrops();

    assert.equal(calls, 2);
    assert.equal(drops.length, 1);
});

test("without credentials a Facepunch failure is reported, and the missing-credentials warning is logged only once", async (t) => {
    const { warnings } = harness(t, withFacepunchDown(() => undefined));
    const provider = new TwitchDropsProvider({ useMockData: false });

    await assert.rejects(provider.fetchRustDrops(), /status 403/);
    assert.equal(provider.getSourceStatus(), "error (provider fetch failed)");
    await assert.rejects(provider.fetchRustDrops(), /status 403/);

    const credentialWarnings = warnings.filter((args) => String(args[0]).includes("TWITCH_CLIENT_ID"));
    assert.equal(credentialWarnings.length, 1);
});

test("Helix fallback returns campaigns, marks the source, and sends the bearer token and client id", async (t) => {
    const { requests } = harness(
        t,
        withFacepunchDown(
            helixOk({
                data: [
                    {
                        id: "c1",
                        name: "  Helix Event  ",
                        starts_at: START_ISO,
                        ends_at: END_ISO,
                        allow: { channels: [{ broadcaster_login: " Alpha " }, { login: "beta" }] },
                        channels: [{ broadcaster_name: "gamma" }, { display_name: "Alpha" }, {}],
                        allowed_channels: [{ name: "delta" }, { login: "beta" }]
                    },
                    { id: "c2", starts_at: START_ISO, ends_at: END_ISO }
                ]
            })
        )
    );
    const provider = new TwitchDropsProvider(credentials);

    const drops = await provider.fetchRustDrops();

    assert.equal(provider.getSourceStatus(), "live fallback (Twitch Helix API)");
    assert.equal(drops[0].title, "Helix Event");
    assert.deepEqual([...(drops[0].channels ?? [])].sort(), ["Alpha", "beta", "delta", "gamma"].sort());
    assert.equal(drops[1].title, "Twitch Rust Drops Campaign c2");

    const helixCall = requests.find((r) => r.url.includes("/drops/campaigns?"));
    const headers = helixCall?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok");
    assert.equal(headers["Client-Id"], "client");
    assert.ok(helixCall?.url.includes("game_id=rust-id"));
});

test("Helix app tokens are cached until shortly before expiry, then refreshed", async (t) => {
    let now = NOW_MS;
    const { requests } = harness(
        t,
        withFacepunchDown(helixOk({ data: [{ id: "c1", starts_at: START_ISO, ends_at: END_ISO }] }))
    );
    t.mock.method(Date, "now", () => now);
    const provider = new TwitchDropsProvider(credentials);
    const tokenRequests = () => requests.filter((r) => r.url.startsWith(TOKEN_URL)).length;

    await provider.fetchRustDrops();
    await provider.fetchRustDrops();
    assert.equal(tokenRequests(), 1, "the second cycle reuses the cached token");

    now += 3600 * 1000 - 30_000; // inside the 60 second safety margin before expiry
    await provider.fetchRustDrops();
    assert.equal(tokenRequests(), 2, "a token about to expire is refreshed");
});

test("Helix ended campaigns are filtered out", async (t) => {
    harness(
        t,
        withFacepunchDown(
            helixOk({
                data: [
                    { id: "live", starts_at: START_ISO, ends_at: END_ISO },
                    { id: "cancelled", status: "EXPIRED", starts_at: START_ISO, ends_at: END_ISO }
                ]
            })
        )
    );

    const drops = await new TwitchDropsProvider(credentials).fetchRustDrops();

    assert.deepEqual(drops.map((d) => d.externalId), ["tw-helix-live"]);
});

for (const [label, handler] of [
    ["the OAuth request fails", (url: string) => (url.startsWith(TOKEN_URL) ? new Response("no", { status: 401 }) : undefined)],
    ["Rust is not found in the games list", (url: string) => (url.startsWith(TOKEN_URL) ? Response.json({ access_token: "t", expires_in: 60 }) : url.includes("/games?") ? Response.json({ data: [] }) : undefined)],
    ["the games response has no data array", (url: string) => (url.startsWith(TOKEN_URL) ? Response.json({ access_token: "t", expires_in: 60 }) : url.includes("/games?") ? Response.json({}) : undefined)],
    ["the campaigns response is not the expected shape", helixOk({ unexpected: true })],
    ["the campaigns data is not an array", helixOk({ data: "nope" })],
    ["one Helix campaign has invalid dates", helixOk({ data: [{ id: "ok", starts_at: START_ISO, ends_at: END_ISO }, { id: "bad", starts_at: "nonsense", ends_at: END_ISO }] })],
    ["the campaigns request returns an error status", (url: string) => (url.startsWith(TOKEN_URL) ? Response.json({ access_token: "t", expires_in: 60 }) : url.includes("/games?") ? Response.json({ data: [{ id: "g" }] }) : new Response("no", { status: 404 }))]
] as const) {
    test(`when ${label} the Facepunch failure is surfaced and no partial data is returned`, async (t) => {
        harness(t, withFacepunchDown(handler as Handler));
        const provider = new TwitchDropsProvider(credentials);

        await assert.rejects(provider.fetchRustDrops(), /status 403/);
        assert.equal(provider.getSourceStatus(), "error (provider fetch failed)");
    });
}

test("the client secret is never written to the logs, even when every source fails", async (t) => {
    const { warnings, errors } = harness(t, withFacepunchDown(() => new Response("no", { status: 401 })));

    await assert.rejects(new TwitchDropsProvider(credentials).fetchRustDrops());

    const logged = JSON.stringify([...warnings, ...errors].map((args) => args.map((arg) => (arg instanceof Error ? arg.message : arg))));
    assert.doesNotMatch(logged, new RegExp(SECRET));
});
