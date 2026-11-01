import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { BotDb } from "./db.js";
import type { NormalizedDrop } from "./types.js";

const HOUR = 60 * 60 * 1000;

function createFixture(t: TestContext) {
    const directory = mkdtempSync(path.join(tmpdir(), "rust-drops-db-"));
    const filePath = path.join(directory, "bot.db");
    t.mock.method(console, "log", () => undefined);
    const db = new BotDb(filePath);
    const raw: Database.Database[] = [];
    // Closing every handle first keeps Windows from refusing to delete the folder.
    t.after(() => {
        db.close();
        for (const handle of raw) if (handle.open) handle.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        db,
        /** Direct SQL access for arranging data (such as old timestamps) the public API cannot create. */
        openRaw: () => {
            const handle = new Database(filePath);
            raw.push(handle);
            return handle;
        }
    };
}

function drop(overrides: Partial<NormalizedDrop> = {}): NormalizedDrop {
    return {
        platform: "twitch",
        externalId: "d1",
        title: "Campaign",
        channels: [],
        game: "Rust",
        startTime: new Date(Date.now() + 5 * HOUR).toISOString(),
        endTime: new Date(Date.now() + 9 * HOUR).toISOString(),
        status: "upcoming",
        ...overrides
    };
}

test("a new user gets the documented alert defaults", (t) => {
    const { db } = createFixture(t);
    const settings = db.getUserAlertSettings("u1");

    assert.equal(settings.alert1h, true);
    assert.equal(settings.alertCheckdrops, true);
    assert.equal(settings.alert24h6am, false);
    assert.equal(settings.alert12h6pm, false);
});

test("alert toggles persist, ignore duplicates, and an empty list changes nothing", (t) => {
    const { db } = createFixture(t);

    db.setAlertsEnabled("u1", ["alert_24h_6am", "alert_24h_6am", "alert_12h_6pm"], true);
    assert.deepEqual(
        [db.isAlertEnabled("u1", "alert_24h_6am"), db.isAlertEnabled("u1", "alert_12h_6pm"), db.isAlertEnabled("u1", "alert_1h")],
        [true, true, true]
    );

    db.setAlertEnabled("u1", "alert_1h", false);
    assert.equal(db.isAlertEnabled("u1", "alert_1h"), false);

    const before = JSON.stringify(db.getUserAlertSettings("u1"));
    db.setAlertsEnabled("u1", [], false);
    assert.equal(JSON.stringify(db.getUserAlertSettings("u1")), before);

    assert.deepEqual(db.getUserIdsForAlert("alert_24h_6am"), ["u1"]);
});

test("auto-ping follows whether any alert is enabled", (t) => {
    const { db } = createFixture(t);

    db.setAlertsEnabled("u1", ["alert_24h_6am", "alert_12h_6pm", "alert_1h", "alert_checkdrops"], false);
    assert.equal(db.isAutoPingEnabled("u1"), false);
    assert.deepEqual(db.getAutoPingUserIds(), []);

    db.setAlertEnabled("u1", "alert_12h_6pm", true);
    assert.equal(db.isAutoPingEnabled("u1"), true);
    assert.deepEqual(db.getAutoPingUserIds(), ["u1"]);

    db.setAutoPing("u2", true);
    assert.equal(db.isAutoPingEnabled("u2"), true);
    assert.equal(db.isAutoPingEnabled("never-seen"), false);
});

test("user notification dedupe excludes already-notified users per drop and notification type", (t) => {
    const { db } = createFixture(t);
    const stored = db.upsertDrop(drop());
    const other = db.upsertDrop(drop({ externalId: "d2" }));
    db.setAutoPing("a", true);
    db.setAutoPing("b", true);
    db.setAutoPing("c", true);

    assert.deepEqual(db.getEligibleAutoPingUserIdsForDrop(stored.id, "drop_1h").sort(), ["a", "b", "c"]);

    db.markUserNotificationSent("a", stored.id, "drop_1h");
    db.markUserNotificationSent("a", stored.id, "drop_1h"); // idempotent
    db.markUserNotificationsSentBatch([
        { discordUserId: "b", dropId: stored.id, notificationType: "drop_1h" },
        { discordUserId: "c", dropId: other.id, notificationType: "drop_1h" }
    ]);
    db.markUserNotificationsSentBatch([]);

    assert.equal(db.wasUserNotificationSent("a", stored.id, "drop_1h"), true);
    assert.equal(db.wasUserNotificationSent("a", stored.id, "drop_12h_6pm"), false, "a different notification type is independent");
    assert.equal(db.wasUserNotificationSent("a", other.id, "drop_1h"), false, "a different drop is independent");
    assert.deepEqual(db.getEligibleAutoPingUserIdsForDrop(stored.id, "drop_1h"), ["c"]);
    assert.deepEqual(
        db.getEligibleAutoPingUserIdsForDrop(stored.id, "drop_12h_6pm").sort(),
        ["a", "b", "c"],
        "having received one notification type must not exclude a user from another type"
    );

    const batch = db.getEligibleAutoPingUserIdsForDrops([stored.id, other.id, other.id, Number.NaN], "drop_1h");
    assert.deepEqual([...batch.keys()].sort(), [stored.id, other.id].sort(), "duplicates and non-finite ids are dropped");
    assert.deepEqual(batch.get(stored.id), ["c"]);
    assert.deepEqual(batch.get(other.id)?.sort(), ["a", "b"]);
    assert.deepEqual(db.getEligibleAutoPingUserIdsForDrops([], "drop_1h"), new Map());
});

test("watch-based dedupe records are tracked separately from user notifications", (t) => {
    const { db } = createFixture(t);
    const stored = db.upsertDrop(drop());

    assert.equal(db.wasNotificationSent(1, stored.id, "drop_1h"), false);
    db.markNotificationSent(1, stored.id, "drop_1h");
    assert.equal(db.wasNotificationSent(1, stored.id, "drop_1h"), true);
    assert.equal(db.wasUserNotificationSent("1", stored.id, "drop_1h"), false);
});

test("pruning removes only history older than the retention window and reports counts", (t) => {
    const { db, openRaw } = createFixture(t);
    const stored = db.upsertDrop(drop());
    db.markUserNotificationSent("old", stored.id, "drop_1h");
    db.markUserNotificationSent("recent", stored.id, "drop_1h");
    db.markNotificationSent(1, stored.id, "drop_1h");
    db.markNotificationSent(2, stored.id, "drop_1h");

    const raw = openRaw();
    raw.prepare("UPDATE user_notifications_sent SET sent_at = datetime('now', '-90 days') WHERE discord_user_id = 'old'").run();
    raw.prepare("UPDATE notifications_sent SET sent_at = datetime('now', '-90 days') WHERE watch_id = 1").run();

    assert.deepEqual(db.pruneOldNotificationHistory(60), { userNotificationsDeleted: 1, watchNotificationsDeleted: 1 });
    assert.equal(db.wasUserNotificationSent("old", stored.id, "drop_1h"), false);
    assert.equal(db.wasUserNotificationSent("recent", stored.id, "drop_1h"), true);
    assert.equal(db.wasNotificationSent(2, stored.id, "drop_1h"), true);
    assert.deepEqual(db.pruneOldNotificationHistory(60), { userNotificationsDeleted: 0, watchNotificationsDeleted: 0 }, "pruning is idempotent");
});

test("a retention below one day is treated as one day, never as 'delete everything'", (t) => {
    const { db, openRaw } = createFixture(t);
    const stored = db.upsertDrop(drop());
    db.markUserNotificationSent("half-day-old", stored.id, "drop_1h");
    db.markNotificationSent(1, stored.id, "drop_1h");
    const raw = openRaw();
    raw.prepare("UPDATE user_notifications_sent SET sent_at = datetime('now', '-12 hours')").run();
    raw.prepare("UPDATE notifications_sent SET sent_at = datetime('now', '-12 hours')").run();

    for (const retention of [0, -5, 0.4]) {
        assert.deepEqual(db.pruneOldNotificationHistory(retention), { userNotificationsDeleted: 0, watchNotificationsDeleted: 0 }, `retention ${retention}`);
    }
    assert.equal(db.wasUserNotificationSent("half-day-old", stored.id, "drop_1h"), true);
    assert.equal(db.wasNotificationSent(1, stored.id, "drop_1h"), true);

    raw.prepare("UPDATE user_notifications_sent SET sent_at = datetime('now', '-30 hours')").run();
    assert.deepEqual(db.pruneOldNotificationHistory(0), { userNotificationsDeleted: 1, watchNotificationsDeleted: 0 }, "a floor of one day still prunes older rows");
});

test("upserting updates an existing campaign in place and normalizes channels and game", (t) => {
    const { db } = createFixture(t);
    const first = db.upsertDrop(drop({ channels: ["a", "a", "b"], hasGeneralDrops: false }));
    const second = db.upsertDrop(drop({ title: "Renamed", channels: ["c"], hasGeneralDrops: true, status: "active" }));

    assert.equal(second.id, first.id);
    assert.equal(second.title, "Renamed");
    assert.deepEqual(first.channels, ["a", "b"]);
    assert.deepEqual(second.channels, ["c"]);
    assert.equal(second.hasGeneralDrops, true);
    assert.equal(second.status, "active");
    assert.equal(second.game, "rust");
    assert.equal(db.upsertDrops([]).length, 0);
});

test("a platform's campaigns that are no longer listed are ended, other platforms are untouched", (t) => {
    const { db } = createFixture(t);
    db.upsertDrops([
        drop({ externalId: "keep" }),
        drop({ externalId: "gone" }),
        drop({ platform: "kick", externalId: "kick-1" })
    ]);

    db.endMissingDropsForPlatform("twitch", ["keep", "  "]);

    assert.deepEqual(
        db.getUpcomingDropsWithinHours().map((d) => d.externalId).sort(),
        ["keep", "kick-1"],
        "'gone' was not listed, so it is ended; the other platform is untouched"
    );

    db.endMissingDropsForPlatform("kick", []);
    assert.deepEqual(db.getUpcomingDropsWithinHours().map((d) => d.externalId), ["keep"], "an empty seen list ends every campaign of that platform");
});

test("active and upcoming queries respect status, time, and the optional horizon", (t) => {
    const { db } = createFixture(t);
    db.upsertDrops([
        drop({ externalId: "soon", startTime: new Date(Date.now() + 2 * HOUR).toISOString(), endTime: new Date(Date.now() + 4 * HOUR).toISOString() }),
        drop({ externalId: "later", startTime: new Date(Date.now() + 30 * HOUR).toISOString(), endTime: new Date(Date.now() + 40 * HOUR).toISOString() }),
        drop({ externalId: "live", status: "active", startTime: new Date(Date.now() - HOUR).toISOString(), endTime: new Date(Date.now() + HOUR).toISOString() }),
        drop({ externalId: "stale-live", status: "active", startTime: new Date(Date.now() - 5 * HOUR).toISOString(), endTime: new Date(Date.now() - HOUR).toISOString() }),
        drop({ externalId: "over", status: "ended", startTime: new Date(Date.now() - 5 * HOUR).toISOString(), endTime: new Date(Date.now() - 4 * HOUR).toISOString() })
    ]);

    assert.deepEqual(db.getActiveDrops().map((d) => d.externalId), ["live"], "an 'active' campaign whose end time has passed is not active");
    assert.deepEqual(db.getUpcomingDropsWithinHours(24).map((d) => d.externalId), ["soon"]);
    assert.deepEqual(db.getUpcomingDropsWithinHours().map((d) => d.externalId), ["soon", "later"], "no horizon returns all, soonest first");
});

test("settings and GIF mode have safe defaults and reject unknown values", (t) => {
    const { db } = createFixture(t);

    assert.equal(db.getSetting("missing"), undefined);
    db.setSetting("reminder_channel_id", "123");
    db.setSetting("reminder_channel_id", "456");
    assert.equal(db.getSetting("reminder_channel_id"), "456");

    assert.equal(db.getGifMode(), "default");
    db.setGifMode("both");
    assert.equal(db.getGifMode(), "both");
    db.setSetting("gif_mode", "something-else");
    assert.equal(db.getGifMode(), "default");

    assert.equal(db.isBlahBlahIdkLmaoEnabled(), true, "enabled until explicitly turned off");
    db.setBlahBlahIdkLmaoEnabled(false);
    assert.equal(db.isBlahBlahIdkLmaoEnabled(), false);
    for (const value of ["1", "true", "ON", " On "]) {
        db.setSetting("blah_blah_idk_lmao_enabled", value);
        assert.equal(db.isBlahBlahIdkLmaoEnabled(), true, value);
    }
});

test("custom GIFs are per-user: duplicates rejected, only the owner can rename or remove", (t) => {
    const { db } = createFixture(t);
    const url = "https://tenor.com/view/rust-1";

    assert.equal(db.addCustomGif("alice", url), true);
    assert.equal(db.addCustomGif("alice", url), false, "the same URL cannot be added twice by one user");
    assert.equal(db.addCustomGif("bob", url), true, "another user may add the same URL");
    assert.equal(db.addCustomGif("alice", "https://tenor.com/view/rust-2"), true);

    const [first] = db.listCustomGifs("alice");
    assert.equal(db.listCustomGifs("alice").length, 2);
    assert.equal(db.renameCustomGif("bob", first.id, "stolen"), false);
    assert.equal(db.removeCustomGif("bob", first.id), false);
    assert.equal(db.renameCustomGif("alice", first.id, "Nice one"), true);
    assert.equal(db.listCustomGifs("alice").find((gif) => gif.id === first.id)?.displayName, "Nice one");
    assert.deepEqual(db.listAllCustomGifViewUrls().sort(), [url, "https://tenor.com/view/rust-2"].sort(), "distinct URLs across all users");

    assert.equal(db.removeCustomGif("alice", first.id), true);
    assert.equal(db.removeCustomGif("alice", first.id), false);
    assert.equal(db.listCustomGifs("alice").length, 1);
});

test("secret discovery counts each secret once per user and can be reset", (t) => {
    const { db } = createFixture(t);

    assert.deepEqual(db.markSecretFound("u1", "rare_bee"), { isNew: true, foundCount: 1, totalSecrets: 3 });
    assert.deepEqual(db.markSecretFound("u1", "rare_bee"), { isNew: false, foundCount: 1, totalSecrets: 3 });
    assert.equal(db.markSecretFound("u1", "no_cheating").foundCount, 2);
    assert.equal(db.markSecretFound("u2", "rare_bee").foundCount, 1, "progress is per user");

    db.resetSecrets("u1");
    assert.equal(db.getSecretsFoundCount("u1"), 0);
    assert.equal(db.getSecretsFoundCount("u2"), 1);
});

test("watches are unique per user, platform and streamer, and removable only by their owner", (t) => {
    const { db } = createFixture(t);

    assert.equal(db.addWatch("u1", "twitch", "Streamer"), true);
    assert.equal(db.addWatch("u1", "twitch", "Streamer"), false);
    assert.equal(db.addWatch("u1", "kick", "Streamer"), true);

    const [watch] = db.listWatches("u1");
    assert.equal(db.removeWatch("u2", watch.id), false);
    assert.equal(db.removeWatch("u1", watch.id), true);
    assert.equal(db.getWatchesForPlatform("kick").length + db.getWatchesForPlatform("twitch").length, 1);
});
