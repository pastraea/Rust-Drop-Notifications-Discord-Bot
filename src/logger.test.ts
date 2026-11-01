import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, createRedactor, type LogLevel } from "./logger.js";

const FIXED = new Date("2026-11-01T12:00:00.000Z");

function capture(options: Parameters<typeof createLogger>[0] = {}) {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const log = createLogger({ now: () => FIXED, sink: (level, line) => lines.push({ level, line }), ...options });
    return { log, lines };
}

test("lines carry a timestamp, padded level, and the message", () => {
    const { log, lines } = capture();

    log.info("started");
    log.warn("careful");

    assert.deepEqual(lines, [
        { level: "info", line: "2026-11-01T12:00:00.000Z INFO  started" },
        { level: "warn", line: "2026-11-01T12:00:00.000Z WARN  careful" }
    ]);
});

test("lines below the configured level are dropped, and the level can change at runtime", () => {
    const { log, lines } = capture({ level: "warn" });

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    assert.deepEqual(lines.map((l) => l.level), ["warn", "error"]);

    log.setLevel("debug");
    log.debug("now visible");
    assert.equal(lines.at(-1)?.level, "debug");
    assert.equal(log.getLevel(), "debug");

    log.setLevel("silent");
    log.error("never");
    assert.equal(lines.length, 3);
});

test("child loggers add nested scopes and share the parent's level", () => {
    const { log, lines } = capture();
    const scheduler = log.child("scheduler");
    const nested = scheduler.child("cycle");

    scheduler.info("tick");
    nested.info("run");
    log.setLevel("error");
    scheduler.info("hidden");

    assert.equal(lines.length, 2);
    assert.match(lines[0].line, /INFO {2}\[scheduler\] tick$/);
    assert.match(lines[1].line, /INFO {2}\[scheduler:cycle\] run$/);
});

test("details are appended: strings as-is, objects as JSON, errors with stack and cause chain", () => {
    const { log, lines } = capture();
    const cause = new Error("disk full");
    const failure = new Error("backup failed", { cause });

    log.error("migration problem", "extra", { id: 1 }, failure, undefined, 42);

    const line = lines[0].line;
    assert.match(line, /migration problem extra \{"id":1\} /);
    assert.match(line, /Error: backup failed/);
    assert.match(line, /Caused by: Error: disk full/);
    assert.match(line, / undefined 42$/);
});

test("unserializable details never throw", () => {
    const { log, lines } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    assert.doesNotThrow(() => log.info("odd", circular, 10n, Symbol("s")));
    assert.match(lines[0].line, /\[unserializable value\]/);
});

test("a failing sink cannot crash the caller", () => {
    const log = createLogger({
        sink: () => {
            throw new Error("sink exploded");
        }
    });

    assert.doesNotThrow(() => log.error("still fine"));
});

test("registered secrets are masked everywhere, including inside errors and JSON", () => {
    const { log, lines } = capture();
    log.addSecret("my-very-secret-value");

    log.warn("token my-very-secret-value used", { header: "x my-very-secret-value x" }, new Error("failed with my-very-secret-value"));

    assert.equal(lines[0].line.includes("my-very-secret-value"), false);
    assert.equal((lines[0].line.match(/\[redacted\]/g) ?? []).length >= 3, true);
});

test("secrets shorter than six characters are ignored so ordinary words are not masked", () => {
    const redactor = createRedactor();
    redactor.add("abc");
    redactor.add(undefined);
    redactor.add("");

    assert.equal(redactor.redact("abc is fine"), "abc is fine");
});

test("overlapping secrets are masked completely, longest first", () => {
    const redactor = createRedactor();
    redactor.add("secret-abc");
    redactor.add("secret-abc-extended");

    assert.equal(redactor.redact("value secret-abc-extended end"), "value [redacted] end");
});

test("common credential shapes are masked even when they were never registered", () => {
    const redactor = createRedactor();
    const discordToken = `${"A".repeat(24)}.${"b".repeat(6)}.${"C".repeat(30)}`;

    const cases: Array<[string, RegExp]> = [
        [`login with ${discordToken}`, /login with \[redacted\]$/],
        ["Authorization: Bearer abcdef1234567890", /Bearer \[redacted\]/],
        ["https://id.twitch.tv/oauth2/token?client_id=abc&client_secret=hunter2hunter2&grant_type=x", /client_secret=\[redacted\]&grant_type=x/],
        ['{"access_token":"abc123def456","expires_in":3600}', /"access_token":"\[redacted\]","expires_in":3600/],
        ["password=letmein1 rest", /password=\[redacted\] rest/]
    ];
    for (const [input, expected] of cases) {
        const output = redactor.redact(input);
        assert.match(output, expected, input);
    }
});

test("ordinary text, hostnames and numbers are left alone", () => {
    const redactor = createRedactor();
    const samples = [
        "Logged in as RustBot#1234",
        "GET https://api.twitch.tv/helix/games?name=Rust 200",
        "very-long-subdomain-name-here.example.com failed",
        "Drop cycle (scheduled) completed in 120ms."
    ];

    for (const sample of samples) assert.equal(redactor.redact(sample), sample);
});
