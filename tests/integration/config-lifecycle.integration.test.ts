import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

test("built dist/sitediff: config lifecycle (init -> presets/collections in file -> capture --collection)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-"));
	try {
		await runBin(["config", "init"], dir);
		const configPath = join(dir, ".sitediff.json");
		assert.ok(existsSync(configPath));

		const appConfig = JSON.parse(readFileSync(configPath, "utf8"));
		appConfig.presets = { mobile: {} };
		appConfig.collections = { mysite: "mobile" };
		writeFileSync(configPath, JSON.stringify(appConfig));

		assert.ok(appConfig.presets.mobile);
		assert.equal(appConfig.collections.mysite, "mobile");

		const stdout = await runBin(
			["capture", `${local.baseUrl}/`, "--collection", "mysite", "--json"],
			dir,
		);
		const result = JSON.parse(stdout);
		assert.equal(result.status, "completed");

		const settings = JSON.parse(
			readFileSync(join(dir, result.outputDir, "settings.json"), "utf8"),
		);
		assert.equal(settings.collection.name, "mysite");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
