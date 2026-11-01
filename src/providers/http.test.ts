import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetries } from "./http.js";

const noSleep = async () => undefined;

function sequence(...steps: Array<Response | Error>): { impl: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (async () => {
        const step = steps[Math.min(calls, steps.length - 1)];
        calls++;
        if (step instanceof Error) throw step;
        return step.clone();
    }) as typeof fetch;
    return { impl, calls: () => calls };
}

test("a successful response is returned without retrying", async () => {
    const { impl, calls } = sequence(new Response("ok", { status: 200 }));
    const response = await fetchWithRetries("https://example.test", {}, { fetchImpl: impl, sleep: noSleep });
    assert.equal(response.status, 200);
    assert.equal(calls(), 1);
});

test("client errors (4xx) are returned immediately and never retried", async () => {
    const { impl, calls } = sequence(new Response("missing", { status: 404 }));
    const response = await fetchWithRetries("https://example.test", {}, { fetchImpl: impl, sleep: noSleep });
    assert.equal(response.status, 404);
    assert.equal(calls(), 1);
});

test("a 5xx response is retried and a later success is returned", async () => {
    const { impl, calls } = sequence(new Response("down", { status: 503 }), new Response("ok", { status: 200 }));
    const response = await fetchWithRetries("https://example.test", {}, { fetchImpl: impl, sleep: noSleep });
    assert.equal(response.status, 200);
    assert.equal(calls(), 2);
});

test("a network error is retried and a later success is returned", async () => {
    const { impl, calls } = sequence(new TypeError("fetch failed"), new Response("ok", { status: 200 }));
    const response = await fetchWithRetries("https://example.test", {}, { fetchImpl: impl, sleep: noSleep });
    assert.equal(response.status, 200);
    assert.equal(calls(), 2);
});

test("after the last attempt the final failure is thrown", async () => {
    const down = sequence(new Response("down", { status: 500 }));
    await assert.rejects(
        fetchWithRetries("https://example.test", {}, { fetchImpl: down.impl, sleep: noSleep, maxAttempts: 3 }),
        /status 500/
    );
    assert.equal(down.calls(), 3);

    const offline = sequence(new TypeError("fetch failed"));
    await assert.rejects(fetchWithRetries("https://example.test", {}, { fetchImpl: offline.impl, sleep: noSleep }), /fetch failed/);
    assert.equal(offline.calls(), 2);
});

test("it waits a jittered 250-500 ms between attempts but not after the last", async () => {
    const delays: number[] = [];
    const down = sequence(new Response("down", { status: 502 }));
    await assert.rejects(
        fetchWithRetries("https://example.test", {}, { fetchImpl: down.impl, maxAttempts: 3, sleep: async (ms) => void delays.push(ms) })
    );
    assert.equal(delays.length, 2);
    for (const delay of delays) assert.ok(delay >= 250 && delay < 500, `delay ${delay} out of range`);
});

test("without an injected fetch it uses the global fetch resolved at call time", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("mocked", { status: 200 }));
    const response = await fetchWithRetries("https://example.test", {});
    assert.equal(await response.text(), "mocked");
});
