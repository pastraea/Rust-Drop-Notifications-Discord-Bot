import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { ChannelType, Client } from "discord.js";
import { BotDb } from "../db.js";
import { TwitchDropsProvider } from "../providers/twitch.js";
import { runDropsCycle } from "../scheduler.js";
import { syncDrops } from "./dropService.js";
import { buildSnapshotContentLines } from "./reminderService.js";

function createTestDb(t: TestContext, legacy = false): BotDb {
    const directory = mkdtempSync(path.join(tmpdir(), "rust-drops-flow-"));
    const dbPath = path.join(directory, "bot.db");
    if (legacy) {
        const oldDb = new Database(dbPath);
        oldDb.exec(`CREATE TABLE drops (
            id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
            external_id TEXT NOT NULL, title TEXT NOT NULL, channels_json TEXT NOT NULL DEFAULT '[]',
            game TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
            status TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(platform, external_id)
        )`);
        oldDb.close();
    }
    const db = new BotDb(dbPath);
    t.after(() => {
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return db;
}

function campaignHtml(start: number, end: number, login = "TwitchRivals", general = true): string {
    return `
        <div class="campaign campaign-0">
            <h2 class="event-title">Base Invaders</h2>
            <span data-date-id="start-${start / 1000}">Start</span>
            <span data-date-id="end-${end / 1000}">End</span>
        </div>
        <script>setupCountdown('.campaign-0', 0, ${start});</script>
        ${general ? '<div class="general-drops-grid"><a class="drop-box">Rug</a></div>' : ""}
        <div class="section streamer-drops campaign campaign-0">
            ${login ? `<a class="streamer-info" href="https://www.twitch.tv/${login}">Streamer</a>` : ""}
        </div>`;
}

function mockUpstream(t: TestContext, html: string): string[] {
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://twitch.facepunch.com/") {
            return new Response(html);
        }
        // Keep GIF lookup offline; exercise the existing text notification fallback.
        if (url.startsWith("https://tenor.com/") || url.startsWith("https://media.tenor.com/")) {
            return new Response("", { status: 404 });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    return requests;
}

function mockDiscord(t: TestContext, db: BotDb): { client: Client; messages: string[] } {
    const client = new Client({ intents: [] });
    t.after(() => client.destroy());
    const messages: string[] = [];
    db.setSetting("reminder_channel_id", "test-channel");
    db.setBlahBlahIdkLmaoEnabled(false);
    t.mock.method(client.channels, "fetch", async () => ({
        type: ChannelType.GuildText,
        send: async (payload: { content: string }) => {
            messages.push(payload.content);
        }
    }));
    return { client, messages };
}

test("checkdrops flows from official HTML through SQLite to Discord for campaigns over 24h away", async (t) => {
    const db = createTestDb(t);
    const { client, messages } = mockDiscord(t, db);
    const start = Math.floor(Date.now() / 1000) * 1000 + 6 * 86400000;
    const end = start + 9 * 86400000;
    const requests = mockUpstream(t, campaignHtml(start, end));
    const provider = new TwitchDropsProvider({ useMockData: false });
    db.setAlertsEnabled("123456789", ["alert_checkdrops"], true);

    await runDropsCycle({ client, db, providers: [provider], intervalMs: 300000 }, {
        forceAnnounce: true
    });

    assert.equal(db.getUpcomingDropsWithinHours(24).length, 0);
    const [stored] = db.getUpcomingDropsWithinHours();
    assert.deepEqual(stored?.channels, ["twitchrivals"]);
    assert.equal(stored?.hasGeneralDrops, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Status: upcoming/);
    assert.match(messages[0], /Campaigns: Base Invaders/);
    assert.match(messages[0], /General drops: any drops-enabled Rust stream/);
    assert.match(messages[0], /https:\/\/www\.twitch\.tv\/directory\/all\/tags\/Rust/);
    assert.match(messages[0], /Streamer drops: twitchrivals \(https:\/\/twitch\.tv\/twitchrivals\)/);
    assert.match(messages[0], /Channel confidence: listed/);
    assert.ok(messages[0].includes(`Starts: <t:${start / 1000}:R>`));
    assert.ok(!messages[0].includes("Ends:"));
    assert.ok(messages[0].includes("<@123456789>"));
    assert.ok(!requests.some((url) => url.includes("gql.twitch.tv")));
});

test("general-only campaigns survive the default checkdrops participation filter", async (t) => {
    const db = createTestDb(t);
    const { client, messages } = mockDiscord(t, db);
    const start = Math.floor(Date.now() / 1000) * 1000 + 6 * 86400000;
    mockUpstream(t, campaignHtml(start, start + 86400000, ""));
    await runDropsCycle({
        client, db, providers: [new TwitchDropsProvider({ useMockData: false })], intervalMs: 300000
    }, { forceAnnounce: true });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Status: upcoming/);
    assert.match(messages[0], /General drops: any drops-enabled Rust stream/);
    assert.ok(!messages[0].includes("Streamer drops:"));
});

test("full manual checks include unknown participation without guessing channels", async (t) => {
    const db = createTestDb(t);
    const { client, messages } = mockDiscord(t, db);
    const start = Math.floor(Date.now() / 1000) * 1000 + 6 * 86400000;
    mockUpstream(t, campaignHtml(start, start + 86400000, "", false));
    const deps = {
        client, db, providers: [new TwitchDropsProvider({ useMockData: false })], intervalMs: 300000
    };
    await runDropsCycle(deps, { forceAnnounce: true });
    assert.ok(!messages[0].includes("Campaigns: Base Invaders"));
    await runDropsCycle(deps, { forceAnnounce: true, forceAnnounceMode: "full" });
    assert.match(messages[1], /Status: upcoming/);
    assert.match(messages[1], /Campaigns: Base Invaders/);
    assert.match(messages[1], /participating channels are not published/);
    assert.ok(!messages[1].includes("Channel confidence: listed"));
});

test("manual checks do not hide upcoming participants when another campaign is active", async (t) => {
    const db = createTestDb(t);
    const { client, messages } = mockDiscord(t, db);
    const now = Math.floor(Date.now() / 1000) * 1000;
    const current = campaignHtml(now - 3600000, now + 86400000);
    const upcoming = campaignHtml(now + 6 * 86400000, now + 9 * 86400000, "NextStreamer", false)
        .replaceAll("campaign-0", "campaign-1").replace("Base Invaders", "Next Event");
    mockUpstream(t, current + upcoming);
    await runDropsCycle({
        client, db, providers: [new TwitchDropsProvider({ useMockData: false })], intervalMs: 300000
    }, { forceAnnounce: true });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Status: active/);
    assert.match(messages[0], /Status: upcoming/);
    assert.match(messages[0], /Campaigns: Base Invaders/);
    assert.match(messages[0], /Campaigns: Next Event/);
    assert.match(messages[0], /Streamer drops: nextstreamer/);
});

test("live announcements preserve listed streamer and general drop eligibility", async (t) => {
    const db = createTestDb(t);
    const { client, messages } = mockDiscord(t, db);
    const start = Math.floor(Date.now() / 1000) * 1000 - 3600000;
    const end = start + 86400000;
    mockUpstream(t, campaignHtml(start, end));
    db.setAutoPing("123456789", true);
    const deps = {
        client, db, providers: [new TwitchDropsProvider({ useMockData: false })], intervalMs: 300000
    };
    await runDropsCycle(deps);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Streamer drops: twitchrivals/);
    assert.match(messages[0], /General drops: any drops-enabled Rust stream/);
    assert.ok(messages[0].includes(`Ends: <t:${end / 1000}:R>`));
    await runDropsCycle(deps);
    assert.equal(messages.length, 1, "successful live announcements must remain deduplicated");
});

test("schema migration and both upsert paths preserve general-drop availability", (t) => {
    const db = createTestDb(t, true);
    const drop = {
        platform: "twitch" as const, externalId: "migration-test", title: "General only",
        channels: [], hasGeneralDrops: true, game: "rust",
        startTime: new Date(Date.now() - 3600000).toISOString(),
        endTime: new Date(Date.now() + 86400000).toISOString(),
        status: "active" as const
    };
    assert.equal(db.upsertDrop(drop).hasGeneralDrops, true);
    assert.equal(db.getActiveDrops()[0]?.hasGeneralDrops, true);
    assert.equal(db.upsertDrops([{ ...drop, hasGeneralDrops: false }])[0]?.hasGeneralDrops, false);
    assert.equal(db.getActiveDrops()[0]?.hasGeneralDrops, false);
    assert.equal(db.upsertDrop({ ...drop, hasGeneralDrops: undefined }).hasGeneralDrops, false);
});

test("successful sync removes stale participants and incorrect old campaign records", async (t) => {
    const db = createTestDb(t);
    const start = Math.floor(Date.now() / 1000) * 1000 - 3600000;
    const end = start + 86400000;
    const provider = new TwitchDropsProvider({ useMockData: false });
    db.upsertDrop({
        platform: "twitch", externalId: `tw-facepunch-0-0-${start}`,
        title: "Incorrect legacy campaign", channels: ["unrelatedstreamer"], game: "rust",
        startTime: new Date(0).toISOString(), endTime: new Date(end).toISOString(), status: "active"
    });
    mockUpstream(t, campaignHtml(start, end));
    await syncDrops(db, [provider]);
    assert.equal(db.getActiveDrops().length, 1);
    assert.deepEqual(db.getActiveDrops()[0]?.channels, ["twitchrivals"]);
    mockUpstream(t, campaignHtml(start, end, "Replacement", false));
    await syncDrops(db, [provider]);
    assert.equal(db.getActiveDrops().length, 1);
    assert.deepEqual(db.getActiveDrops()[0]?.channels, ["replacement"]);
    assert.equal(db.getActiveDrops()[0]?.hasGeneralDrops, false);
    assert.ok(!buildSnapshotContentLines("Check", db.getActiveDrops(), [], "none", false)
        .join("\n").includes("unrelatedstreamer"));
});

test("provider failures preserve stored campaign participation instead of ending it", async (t) => {
    const db = createTestDb(t);
    const start = Math.floor(Date.now() / 1000) * 1000 - 3600000;
    mockUpstream(t, campaignHtml(start, start + 86400000));
    const provider = new TwitchDropsProvider({ useMockData: false });
    await syncDrops(db, [provider]);
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
    await assert.rejects(syncDrops(db, [provider]), /status 403/);
    assert.deepEqual(db.getActiveDrops()[0]?.channels, ["twitchrivals"]);
    assert.equal(db.getActiveDrops()[0]?.hasGeneralDrops, true);
});
