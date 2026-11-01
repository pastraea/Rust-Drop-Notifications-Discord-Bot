import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "discord.js";
import { BotDb } from "./db.js";
import type { DropsProvider } from "./providers/base.js";
import { startScheduler } from "./scheduler.js";

function createFixture(t: TestContext) {
    const directory = mkdtempSync(path.join(tmpdir(), "rust-drops-scheduler-"));
    const db = new BotDb(path.join(directory, "bot.db"));
    const client = new Client({ intents: [] });
    t.mock.method(console, "log", () => undefined);
    t.mock.method(console, "warn", () => undefined);
    t.after(() => {
        db.close();
        void client.destroy();
        for (const file of readdirSync(directory)) unlinkSync(path.join(directory, file));
        rmdirSync(directory);
    });
    return { db, client };
}

test("stop() waits for the running cycle and no further cycles start afterwards", async (t) => {
    const { db, client } = createFixture(t);
    let fetches = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: DropsProvider = {
        platform: "twitch",
        async fetchRustDrops() {
            fetches++;
            await gate;
            return [];
        }
    };

    const scheduler = startScheduler({ client, db, providers: [provider], intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fetches, 1, "overlapping ticks must be skipped while a cycle is running");

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
        stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "stop() must wait for the in-flight cycle");

    release();
    await stopping;
    assert.equal(stopped, true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fetches, 1, "no cycle may start after stop()");
});

test("a failing cycle is logged and does not break later cycles or stop()", async (t) => {
    const { db, client } = createFixture(t);
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void errors.push(args));
    let fetches = 0;
    const provider: DropsProvider = {
        platform: "twitch",
        async fetchRustDrops() {
            fetches++;
            throw new Error("provider down");
        }
    };

    const scheduler = startScheduler({ client, db, providers: [provider], intervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();

    assert.ok(fetches >= 2, "scheduler must keep running after a failed cycle");
    assert.ok(errors.length >= 2);
});
