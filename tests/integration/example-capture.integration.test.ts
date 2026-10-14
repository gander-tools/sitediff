import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { requireBin, runBin } from "./helpers.ts";

before(requireBin);

test("built dist/sitediff: capture https://example.com -> exit 0, all 5 files exist, status=completed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-example-"));
	try {
		const stdout = await runBin(
			["capture", "https://example.com", "--json"],
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
