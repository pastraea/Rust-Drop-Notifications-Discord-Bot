import assert from "node:assert/strict";
import test from "node:test";
import { getTimedAlertDueTypes } from "./reminderService.js";

test("24h alert is due in 6am Sydney window when drop is under 24h away", () => {
    const now = new Date("2026-03-11T06:02:00+11:00");
    const dropStart = new Date("2026-03-12T05:30:00+11:00");

    const due = getTimedAlertDueTypes(dropStart, now, 5 * 60 * 1000);
    assert.ok(due.includes("alert_24h_6am"));
});

test("12h alert is due in 6pm Sydney window when drop is under 12h away", () => {
    const now = new Date("2026-03-11T18:03:00+11:00");
    const dropStart = new Date("2026-03-12T05:00:00+11:00");

    const due = getTimedAlertDueTypes(dropStart, now, 5 * 60 * 1000);
    assert.ok(due.includes("alert_12h_6pm"));
});

test("1h alert is due only inside the interval lookback window", () => {
    const now = new Date("2026-03-11T10:00:00+11:00");
    const insideWindow = new Date("2026-03-11T10:56:00+11:00");
    const outsideWindow = new Date("2026-03-11T11:30:00+11:00");

    const dueInside = getTimedAlertDueTypes(insideWindow, now, 5 * 60 * 1000);
    const dueOutside = getTimedAlertDueTypes(outsideWindow, now, 5 * 60 * 1000);

    assert.ok(dueInside.includes("alert_1h"));
    assert.ok(!dueOutside.includes("alert_1h"));
});

test("no due alerts when drop has already started", () => {
    const now = new Date("2026-03-11T10:00:00+11:00");
    const startedDrop = new Date("2026-03-11T09:50:00+11:00");

    const due = getTimedAlertDueTypes(startedDrop, now, 5 * 60 * 1000);
    assert.equal(due.length, 0);
});
