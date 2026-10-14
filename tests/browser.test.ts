import assert from "node:assert/strict";
import { test } from "node:test";
import { parseViewport, resolveHeadless } from "../src/browser.ts";

test("parseViewport: custom value parses to width/height", () => {
	assert.deepEqual(parseViewport("1024x768"), { width: 1024, height: 768 });
});

test("parseViewport: malformed value falls back to 1920x1080 default", () => {
	assert.deepEqual(parseViewport("abc"), { width: 1920, height: 1080 });
});

test("parseViewport: undefined falls back to 1920x1080 default", () => {
	assert.deepEqual(parseViewport(undefined), { width: 1920, height: 1080 });
});

// ⊥ env fallback anymore — --headed is the sole override.
test("resolveHeadless: cliHeaded=true -> false", () => {
	assert.equal(resolveHeadless(true), false);
});

test("resolveHeadless: cliHeaded unset -> true default", () => {
	assert.equal(resolveHeadless(undefined), true);
});

test("resolveHeadless: cliHeaded=false -> true default", () => {
	assert.equal(resolveHeadless(false), true);
});
