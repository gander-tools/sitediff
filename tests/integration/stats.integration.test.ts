import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	type LocalServer,
	requireBin,
	runBin,
	startLocalServer,
	stopLocalServer,
} from "./helpers.ts";

let local: LocalServer;

before(async () => {
	requireBin();
	local = await startLocalServer();
});

after(async () => {
	await stopLocalServer(local.server);
});

test("built dist/sitediff: stats <shortId> writes stats.json with all fields", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-stats-"));
	try {
		const stdout = await runBin(
			["capture", `${local.baseUrl}/`, "--json"],
			dir,
		);
		const result = JSON.parse(stdout);
		assert.equal(result.status, "completed");

		const statsOut = await runBin(["stats", result.id], dir);
		assert.match(statsOut, /wrote .*stats\.json/);

		const outputDir = join(dir, result.outputDir);
		const stats = JSON.parse(
			readFileSync(join(outputDir, "stats.json"), "utf8"),
		);

		assert.equal(typeof stats.loadTimeMs, "number");
		assert.equal(typeof stats.totalBytes, "number");
		assert.equal(typeof stats.domSizeBytes, "number");
		assert.ok(stats.domSizeBytes > 0);
		assert.equal(typeof stats.screenshot.width, "number");
		assert.equal(typeof stats.screenshot.height, "number");
		assert.ok(Array.isArray(stats.resources));
		assert.ok(stats.resources.length > 0);
		const resource = stats.resources[0];
		assert.equal(typeof resource.host, "string");
		assert.equal(typeof resource.path, "string");
		assert.equal(typeof resource.type, "string");
		assert.equal(typeof resource.sizeBytes, "number");
		assert.equal(typeof resource.headers, "object");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: stats <unknownShortId> fails fast", async () => {
	const dir = mkdtempSync(
		join(tmpdir(), "sitediff-integration-stats-unknown-"),
	);
	try {
		await assert.rejects(runBin(["stats", "nonexistent"], dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
