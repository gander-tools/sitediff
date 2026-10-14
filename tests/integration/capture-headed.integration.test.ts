import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, type TestContext, test } from "node:test";
import { requireBin, runBin } from "./helpers.ts";

before(requireBin);

// Headed mode is excluded from CI integration scope — Chromium headed
// needs a real X server, and tests.yml has no Xvfb step. Skip instead of
// failing when there's nothing to attach to.
test("built dist/sitediff: capture https://example.com --headed -> exit 0, all 5 files exist, status=completed", async (t: TestContext) => {
	if (!process.env.DISPLAY) {
		t.skip("no DISPLAY available — headed Chromium needs a real X server");
		return;
	}

	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-headed-"));
	try {
		const stdout = await runBin(
			["capture", "https://example.com", "--headed", "--json"],
			dir,
		);
		const result = JSON.parse(stdout);
		assert.equal(result.status, "completed");

		const outputDir = join(dir, result.outputDir);
		for (const file of [
			"capture.har",
			"dom.html",
			"screenshot.png",
			"console.json",
			"redirects.json",
		]) {
			assert.ok(existsSync(join(outputDir, file)), `expected ${file} to exist`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
