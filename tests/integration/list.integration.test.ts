import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface ListRow {
	short_id: string | null;
	host: string;
	path: string;
	collection: string | null;
	width: number | null;
	height: number | null;
	timestamp: string;
	status: string;
}

async function list(cwd: string, args: string[] = []): Promise<ListRow[]> {
	const stdout = await runBin(["list", "--json", ...args], cwd);
	return JSON.parse(stdout) as ListRow[];
}

test("built dist/sitediff: list filters vs 2 seeded snapshots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-list-"));
	try {
		await runBin(["config", "init"], dir);
		const configPath = join(dir, ".sitediff.json");
		const appConfig = JSON.parse(readFileSync(configPath, "utf8"));
		appConfig.presets = {
			p1: { viewport: { width: 800, height: 600 } },
			p2: { viewport: { width: 400, height: 300 } },
		};
		appConfig.collections = {
			colA: "p1",
			colB: "p2",
		};
		// worker.autostart:false — row B below relies on --enqueue leaving a
		// `queued` row untouched; the real default (autostart:true) would race
		// a detached worker completing it before the assertions run.
		appConfig.worker = { autostart: false, timeout: 30000 };
		writeFileSync(configPath, JSON.stringify(appConfig));

		// row1: completed, host=127.0.0.1, /a, collection=colA, 800x600
		const stdoutA = await runBin(
			[
				"capture",
				`http://127.0.0.1:${local.port}/a`,
				"--collection",
				"colA",
				"--json",
			],
			dir,
		);
		const resultA = JSON.parse(stdoutA);
		assert.equal(resultA.status, "completed");

		// row2: queued (never runs the pipeline), host=localhost, /b,
		// collection=colB, 400x300 — cheap way to seed a 2nd row with a
		// distinct status/host/path/collection/dims without a 2nd real capture.
		const stdoutB = await runBin(
			[
				"capture",
				`http://localhost:${local.port}/b`,
				"--collection",
				"colB",
				"--enqueue",
				"--json",
			],
			dir,
		);
		const resultB = JSON.parse(stdoutB);
		assert.equal(resultB.status, "queued");

		const all = await list(dir);
		assert.equal(all.length, 2);
		const rowA = all.find((r) => r.short_id === resultA.id);
		const rowB = all.find((r) => r.short_id === resultB.id);
		assert.ok(rowA && rowB);

		assert.deepEqual(
			(await list(dir, ["--collection", "colA"])).map((r) => r.short_id),
			[rowA?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--width", "800"])).map((r) => r.short_id),
			[rowA?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--height", "300"])).map((r) => r.short_id),
			[rowB?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--host", "localhost"])).map((r) => r.short_id),
			[rowB?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--path", "/a"])).map((r) => r.short_id),
			[rowA?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--status", "completed"])).map((r) => r.short_id),
			[rowA?.short_id],
		);
		assert.deepEqual(
			(await list(dir, ["--status", "queued"])).map((r) => r.short_id),
			[rowB?.short_id],
		);
		assert.equal((await list(dir)).length, 2, "omitted --status shows all");

		assert.deepEqual(
			(await list(dir, ["--after", rowA?.timestamp ?? ""]))
				.map((r) => r.short_id)
				.sort(),
			[rowA?.short_id, rowB?.short_id].sort(),
			"--after is inclusive of the boundary row",
		);
		assert.deepEqual(
			(await list(dir, ["--before", rowA?.timestamp ?? ""])).map(
				(r) => r.short_id,
			),
			[rowA?.short_id],
			"--before is inclusive of the boundary row",
		);

		assert.deepEqual(
			(await list(dir, ["--collection", "colA", "--path", "/a"])).map(
				(r) => r.short_id,
			),
			[rowA?.short_id],
			"combined filters AND-combine",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
