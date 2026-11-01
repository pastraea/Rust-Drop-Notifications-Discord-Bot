import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, isValidTenorViewUrl, normalizeTenorViewUrl } from "./tenor.js";

test("normalizeTenorViewUrl trims whitespace and repairs a doubled protocol", () => {
    assert.equal(normalizeTenorViewUrl("  https://tenor.com/view/a-1  "), "https://tenor.com/view/a-1");
    assert.equal(normalizeTenorViewUrl("https://https://tenor.com/view/a-1"), "https://tenor.com/view/a-1");
    assert.equal(normalizeTenorViewUrl("HTTPS://HTTPS://tenor.com/view/a-1"), "https://tenor.com/view/a-1");
});

test("isValidTenorViewUrl accepts only https tenor.com/view URLs", () => {
    assert.ok(isValidTenorViewUrl("https://tenor.com/view/rust-meme-12345"));
    assert.ok(isValidTenorViewUrl("https://TENOR.com/view/Rust-Meme-12345"));
    for (const bad of [
        "http://tenor.com/view/x",
        "https://tenor.com/",
        "https://tenor.com/view/",
        "https://example.com/view/x",
        "https://evil.tenor.com.example/view/x",
        "ftp://tenor.com/view/x",
        ""
    ]) {
        assert.equal(isValidTenorViewUrl(bad), false, bad);
    }
});

test("decodeHtmlEntities decodes ampersands and leaves other text alone", () => {
    assert.equal(decodeHtmlEntities("a&amp;b&amp;c"), "a&b&c");
    assert.equal(decodeHtmlEntities("plain text"), "plain text");
});
