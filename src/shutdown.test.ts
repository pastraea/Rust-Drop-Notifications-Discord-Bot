import assert from "node:assert/strict";
import test from "node:test";
import { createShutdown } from "./shutdown.js";

function harness(steps: Parameters<typeof createShutdown>[0]["steps"], timeoutMs = 1000) {
    const exits: number[] = [];
    const errors: string[] = [];
    const shutdown = createShutdown({
        steps,
        timeoutMs,
        exit: (code) => exits.push(code),
        log: () => undefined,
        logError: (message) => errors.push(message)
    });
    return { shutdown, exits, errors };
}

test("steps run in order and exit with 0", async () => {
    const order: string[] = [];
    const { shutdown, exits } = harness([
        { name: "a", run: () => void order.push("a") },
        { name: "b", run: async () => void order.push("b") }
    ]);
    await shutdown("SIGTERM");
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(exits, [0]);
});

test("a failing step is reported, later steps still run, and exit code is non-zero", async () => {
    const order: string[] = [];
    const { shutdown, exits, errors } = harness([
        { name: "scheduler", run: () => { throw new Error("boom"); } },
        { name: "database", run: () => void order.push("database") }
    ]);
    await shutdown("SIGINT");
    assert.deepEqual(order, ["database"]);
    assert.deepEqual(exits, [1]);
    assert.match(errors[0], /scheduler/);
});

test("an explicit failure exit code is preserved", async () => {
    const { shutdown, exits } = harness([{ name: "a", run: () => undefined }]);
    await shutdown("unhandledRejection", 1);
    assert.deepEqual(exits, [1]);
});

test("repeated shutdown requests run the steps only once", async () => {
    let runs = 0;
    const { shutdown, exits } = harness([{ name: "a", run: () => void runs++ }]);
    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);
    assert.equal(runs, 1);
    assert.equal(exits.length, 1);
});

test("a hung step is abandoned after the timeout and the process is forced to exit", async () => {
    const { shutdown, exits, errors } = harness([{ name: "stuck", run: () => new Promise<void>(() => undefined) }], 30);
    void shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(exits, [1]);
    assert.match(errors[0], /did not finish/);
});
