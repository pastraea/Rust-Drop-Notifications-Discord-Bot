import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { BotDb } from "./db.js";
import { type Migration, MigrationError, runMigrations, SchemaVersionError } from "./migrations.js";

function createFixture(t: TestContext) {
    const directory = mkdtempSync(path.join(tmpdir(), "rust-drops-migrations-"));
    const filePath = path.join(directory, "bot.db");
    const logs: string[] = [];
    const opened: Database.Database[] = [];
    const open = () => {
        const db = new Database(filePath);
        db.pragma("journal_mode = WAL");
        opened.push(db);
        return db;
    };
    // Handles must close before the folder is removed, or Windows refuses the delete.
    t.after(() => {
        for (const db of opened) {
            if (db.open) db.close();
        }
        rmSync(directory, { recursive: true, force: true });
    });
    return { directory, filePath, logs, log: (message: string) => logs.push(message), open };
}

const createItems: Migration = {
    version: 1,
    description: "create items",
    up: (db) => db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
};
const addColor: Migration = {
    version: 2,
    description: "add color",
    up: (db) => db.exec("ALTER TABLE items ADD COLUMN color TEXT NOT NULL DEFAULT 'none'")
};

const backupsIn = (directory: string) => {
    const folder = path.join(directory, "backups");
    return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
};

test("a new database is migrated to the latest version without a backup", (t) => {
    const { directory, filePath, log, open } = createFixture(t);
    const db = open();
    const result = runMigrations(db, [createItems, addColor], { filePath, log });

    assert.deepEqual(result.applied, [1, 2]);
    assert.equal(result.backupPath, undefined);
    assert.equal(db.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(backupsIn(directory), []);
});

test("an up-to-date database is left alone", (t) => {
    const { directory, filePath, log, open } = createFixture(t);
    const db = open();
    runMigrations(db, [createItems], { filePath, log });
    const second = runMigrations(db, [createItems], { filePath, log });

    assert.deepEqual(second, { from: 1, to: 1, applied: [] });
    assert.deepEqual(backupsIn(directory), []);
});

test("an existing database is backed up first, and the backup holds the pre-upgrade data", (t) => {
    const { directory, filePath, logs, log, open } = createFixture(t);
    const db = open();
    runMigrations(db, [createItems], { filePath, log });
    db.prepare("INSERT INTO items (name) VALUES ('rug')").run();

    const result = runMigrations(db, [createItems, addColor], { filePath, log, now: () => new Date("2026-11-01T05:15:00Z") });

    assert.deepEqual(result.applied, [2]);
    assert.equal(path.basename(result.backupPath ?? ""), "bot.db.20261101T051500Z.v1-to-v2.bak");
    assert.deepEqual(backupsIn(directory), ["bot.db.20261101T051500Z.v1-to-v2.bak"]);

    const backup = new Database(result.backupPath as string, { readonly: true });
    try {
        assert.equal(backup.pragma("user_version", { simple: true }), 1);
        assert.deepEqual(backup.prepare("SELECT name FROM items").all(), [{ name: "rug" }]);
        assert.equal(backup.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'color'").get(), undefined);
    } finally {
        backup.close();
    }
    assert.deepEqual(db.prepare("SELECT name, color FROM items").all(), [{ name: "rug", color: "none" }]);
    assert.ok(logs.some((line) => /backup/i.test(line)) && logs.some((line) => line.includes("version 2")));
});

test("a database from a newer bot is refused and not modified", (t) => {
    const { directory, filePath, log, open } = createFixture(t);
    const db = open();
    runMigrations(db, [createItems, addColor], { filePath, log });

    assert.throws(
        () => runMigrations(db, [createItems], { filePath, log }),
        (error: unknown) => error instanceof SchemaVersionError && error.databaseVersion === 2 && error.supportedVersion === 1
    );
    assert.equal(db.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(backupsIn(directory), []);
});

test("a failing migration rolls back completely, keeps the version, and reports the backup", (t) => {
    const { filePath, log, open } = createFixture(t);
    const db = open();
    runMigrations(db, [createItems], { filePath, log });
    db.prepare("INSERT INTO items (name) VALUES ('keep')").run();

    const broken: Migration = {
        version: 2,
        description: "partly applied then fails",
        up: (target) => {
            target.exec("ALTER TABLE items ADD COLUMN color TEXT");
            target.exec("INSERT INTO missing_table VALUES (1)");
        }
    };

    assert.throws(
        () => runMigrations(db, [createItems, broken], { filePath, log }),
        (error: unknown) =>
            error instanceof MigrationError && error.version === 2 && /rolled back/.test(error.message) && /\.bak/.test(error.message)
    );
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'color'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT name FROM items").all(), [{ name: "keep" }]);
});

test("if the backup cannot be written the database is not migrated", (t) => {
    const { directory, filePath, log, open } = createFixture(t);
    const db = open();
    runMigrations(db, [createItems], { filePath, log });
    // A file where the backups folder should be makes the backup impossible.
    fs.writeFileSync(path.join(directory, "backups"), "not a folder");

    assert.throws(() => runMigrations(db, [createItems, addColor], { filePath, log }), /left unchanged/);
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'color'").get(), undefined);
});

test("only the newest backups are kept", (t) => {
    const { directory, filePath, log, open } = createFixture(t);
    const db = open();
    const migrations: Migration[] = [createItems];
    runMigrations(db, migrations, { filePath, log });

    for (let version = 2; version <= 6; version++) {
        migrations.push({ version, description: `v${version}`, up: (target) => target.exec(`CREATE TABLE extra_${version} (id INTEGER)`) });
        runMigrations(db, migrations, { filePath, log, keepBackups: 3, now: () => new Date(Date.UTC(2026, 10, version)) });
    }

    const kept = backupsIn(directory);
    assert.equal(kept.length, 3);
    assert.deepEqual(
        kept.map((name) => /\.v(\d+)-to-v(\d+)\.bak$/.exec(name)?.slice(1).join("->")),
        ["3->4", "4->5", "5->6"]
    );
});

test("migrations must be numbered consecutively from 1", (t) => {
    const { filePath, log, open } = createFixture(t);
    const db = open();

    assert.throws(() => runMigrations(db, [addColor], { filePath, log }), /without gaps/);
    assert.throws(() => runMigrations(db, [createItems, createItems], { filePath, log }), /without gaps/);
    assert.equal(db.pragma("user_version", { simple: true }), 0);
});

test("BotDb upgrades a very old users table that predates the alert columns and keeps its rows", (t) => {
    const { directory, filePath } = createFixture(t);
    t.mock.method(console, "log", () => undefined);
    const legacy = new Database(filePath);
    legacy.exec("CREATE TABLE users (discord_user_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    legacy.prepare("INSERT INTO users (discord_user_id, timezone) VALUES ('legacy-user', 'Australia/Sydney')").run();
    legacy.close();

    new BotDb(filePath).close();

    const upgraded = new Database(filePath, { readonly: true });
    try {
        assert.equal(upgraded.pragma("user_version", { simple: true }), 1);
        assert.deepEqual(
            upgraded.prepare("SELECT discord_user_id, timezone, auto_ping, alert_1h, alert_checkdrops FROM users").all(),
            [{ discord_user_id: "legacy-user", timezone: "Australia/Sydney", auto_ping: 0, alert_1h: 1, alert_checkdrops: 1 }]
        );
        assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_auto_ping'").get());
    } finally {
        upgraded.close();
    }
    assert.equal(backupsIn(directory).length, 1);
});

test("BotDb upgrades a legacy unversioned database, backs it up, and refuses a newer one", (t) => {
    const { directory, filePath } = createFixture(t);
    t.mock.method(console, "log", () => undefined);
    const legacy = new Database(filePath);
    legacy.exec(`CREATE TABLE drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
        external_id TEXT NOT NULL, title TEXT NOT NULL, game TEXT NOT NULL,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, status TEXT NOT NULL,
        last_seen TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(platform, external_id)
    )`);
    legacy.prepare(
        "INSERT INTO drops (platform, external_id, title, game, start_time, end_time, status) VALUES ('twitch','a','Old','rust','2026-01-01','2026-01-02','ended')"
    ).run();
    legacy.close();

    new BotDb(filePath).close();

    const upgraded = new Database(filePath, { readonly: true });
    try {
        assert.equal(upgraded.pragma("user_version", { simple: true }), 1);
        assert.deepEqual(upgraded.prepare("SELECT title, channels_json FROM drops").all(), [{ title: "Old", channels_json: "[]" }]);
    } finally {
        upgraded.close();
    }
    assert.equal(backupsIn(directory).length, 1);

    const newer = new Database(filePath);
    newer.pragma("user_version = 99");
    newer.close();
    assert.throws(() => new BotDb(filePath), SchemaVersionError);
});
