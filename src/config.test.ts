import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHECK_INTERVAL_MS, MIN_CHECK_INTERVAL_MS, validateDeployEnv, validateRuntimeEnv } from "./config.js";

const baseEnv = { DISCORD_TOKEN: "fixture-token" };

function runtime(extra: Record<string, string | undefined> = {}) {
    return validateRuntimeEnv({ ...baseEnv, ...extra });
}

function dataOf(result: ReturnType<typeof runtime>) {
    assert.equal(result.ok, true, "expected valid configuration");
    if (!result.ok) throw new Error("unreachable");
    return result.data;
}

test("defaults apply when optional settings are absent", () => {
    const data = dataOf(runtime());
    assert.equal(data.CHECK_INTERVAL_MS, 300000);
    assert.equal(data.DATABASE_PATH, "./data/bot.db");
    assert.equal(data.TWITCH_MOCK_DROPS, false);
    assert.equal(data.KICK_MOCK_DROPS, false);
});

test("blank values, as written by `KEY=` lines, fall back to defaults", () => {
    const data = dataOf(runtime({ CHECK_INTERVAL_MS: "", DATABASE_PATH: "  ", TWITCH_MOCK_DROPS: "", KICK_MOCK_DROPS: " " }));
    assert.equal(data.CHECK_INTERVAL_MS, 300000);
    assert.equal(data.DATABASE_PATH, "./data/bot.db");
    assert.equal(data.TWITCH_MOCK_DROPS, false);
    assert.equal(data.KICK_MOCK_DROPS, false);
});

test("missing or empty Discord token is rejected", () => {
    assert.equal(validateRuntimeEnv({}).ok, false);
    assert.equal(validateRuntimeEnv({ DISCORD_TOKEN: "" }).ok, false);
});

test("valid check intervals are parsed to numbers, including the boundaries", () => {
    assert.equal(dataOf(runtime({ CHECK_INTERVAL_MS: "60000" })).CHECK_INTERVAL_MS, 60000);
    assert.equal(dataOf(runtime({ CHECK_INTERVAL_MS: ` ${MIN_CHECK_INTERVAL_MS} ` })).CHECK_INTERVAL_MS, MIN_CHECK_INTERVAL_MS);
    assert.equal(dataOf(runtime({ CHECK_INTERVAL_MS: String(MAX_CHECK_INTERVAL_MS) })).CHECK_INTERVAL_MS, MAX_CHECK_INTERVAL_MS);
});

test("check intervals that would cause a runaway or broken timer are rejected", () => {
    for (const value of ["abc", "NaN", "-1", "0", "999", "1.5", "1e3", "0x10", "Infinity", String(MAX_CHECK_INTERVAL_MS + 1), "99999999999999999999"]) {
        const result = runtime({ CHECK_INTERVAL_MS: value });
        assert.equal(result.ok, false, `CHECK_INTERVAL_MS=${value} should be rejected`);
        if (!result.ok) assert.ok(result.errors.CHECK_INTERVAL_MS?.length);
    }
});

test("boolean flags accept common spellings case-insensitively", () => {
    for (const value of ["true", "TRUE", "1", "yes", "On", " true "]) {
        assert.equal(dataOf(runtime({ TWITCH_MOCK_DROPS: value })).TWITCH_MOCK_DROPS, true, value);
    }
    for (const value of ["false", "False", "0", "no", "OFF"]) {
        assert.equal(dataOf(runtime({ KICK_MOCK_DROPS: value })).KICK_MOCK_DROPS, false, value);
    }
});

test("unrecognised boolean values fail instead of silently meaning false", () => {
    const result = runtime({ TWITCH_MOCK_DROPS: "ture" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.TWITCH_MOCK_DROPS?.length);
});

test("validation errors never echo configuration values", () => {
    const result = runtime({ DISCORD_TOKEN: "super-secret-token", CHECK_INTERVAL_MS: "not-a-number" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(JSON.stringify(result.errors), /super-secret-token|not-a-number/);
});

test("deploy configuration additionally requires client and guild IDs", () => {
    assert.equal(validateDeployEnv(baseEnv).ok, false);
    assert.equal(validateDeployEnv({ ...baseEnv, DISCORD_CLIENT_ID: "1", DISCORD_GUILD_ID: "2" }).ok, true);
});
