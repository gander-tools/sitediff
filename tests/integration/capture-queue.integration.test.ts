import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	status: string;
	output_dir: string;
}

async function listRows(cwd: string): Promise<ListRow[]> {
	const stdout = await runBin(["list", "--json"], cwd);
	return JSON.parse(stdout) as ListRow[];
}

test("built dist/sitediff: capture <url> --enqueue -> queued row, pipeline not run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-enqueue-"));
	try {
		// worker.autostart:false — this test asserts a queued row is untouched
		// by the pipeline; the real default (autostart:true) would race a
		// detached worker against that assertion.
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ worker: { autostart: false, timeout: 30000 } }),
		);
		const stdout = await runBin(
			["capture", `${local.baseUrl}/`, "--enqueue", "--json"],
			dir,
		);
		const result = JSON.parse(stdout);
		assert.equal(result.status, "queued");

		const rows = await listRows(dir);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].short_id, result.id);
		assert.equal(rows[0].status, "queued");
		assert.ok(
			!existsSync(join(dir, rows[0].output_dir)),
			"queued row must not have run the capture pipeline",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: capture <url> --enqueue --worker -> auto-starts worker, job reaches completed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-worker-"));
	try {
		const stdout = await runBin(
			["capture", `${local.baseUrl}/`, "--enqueue", "--worker", "--json"],
			dir,
		);
		const result = JSON.parse(stdout);
		assert.equal(result.status, "queued");

		const deadline = Date.now() + 10_000;
		let row: ListRow | undefined;
		while (Date.now() < deadline) {
			try {
				const rows = await listRows(dir);
				row = rows.find((r) => r.short_id === result.id);
				if (row?.status === "completed") break;
			} catch {
				// `list` can race a concurrent worker write and see a transient
				// "database is locked" (node:sqlite has no busy-timeout by
				// default) — just retry on the next poll tick.
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		assert.equal(
			row?.status,
			"completed",
			"job should reach completed within 10s",
		);
		const outputDir = join(dir, row?.output_dir ?? "");
		for (const file of ["capture.har", "dom.html", "screenshot.png"]) {
			assert.ok(existsSync(join(outputDir, file)), `expected ${file} to exist`);
		}
	} finally {
		try {
			await runBin(["worker", "stop"], dir);
		} catch {
			// best-effort — must not leak a detached worker process on test failure
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
