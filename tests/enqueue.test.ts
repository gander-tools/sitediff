import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enqueueHasNoInput, enqueueUrls } from "../src/enqueue.ts";
import type { BaseConfig, WorkerConfig } from "../src/pipeline.ts";

test("enqueueHasNoInput: no file + TTY stdin (interactive, nobody piped anything) -> true", () => {
	assert.equal(enqueueHasNoInput(undefined, true), true);
});

test("enqueueHasNoInput: no file + non-TTY stdin (piped, even if empty) -> false", () => {
	assert.equal(enqueueHasNoInput(undefined, false), false);
	assert.equal(enqueueHasNoInput(undefined, undefined), false);
});

test("enqueueHasNoInput: file given -> always false, regardless of stdin", () => {
	assert.equal(enqueueHasNoInput("urls.txt", true), false);
	assert.equal(enqueueHasNoInput("urls.txt", false), false);
});

function tempConfig(): { config: BaseConfig; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-enqueue-"));
	return {
		dir,
		config: {
			outDir: join(dir, "output"),
			dbPath: join(dir, "sitediff.sqlite"),
			viewport: { width: 1920, height: 1080 },
			navTimeoutMs: 5000,
			maskSelectors: [],
			hideSelectors: [],
			dropSelectors: [],
		},
	};
}

// pinned off by default so these insert-only tests don't incur a real
// worker-spawn side effect; autostart behavior itself is covered separately
// below.
const NO_AUTOSTART: WorkerConfig = { autostart: false, timeout: 30000 };

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 10000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("enqueueUrls: inserts 1 queued row per url, distinct short_id/output_dir each, never runs pipeline", () => {
	const { config, dir } = tempConfig();
	try {
		const urls = [
			"https://a.example.com/",
			"https://b.example.com/",
			"https://c.example.com/",
		];
		const rows = enqueueUrls(urls, config, NO_AUTOSTART);

		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.map((r) => r.url),
			urls,
		);
		for (const row of rows) assert.equal(row.status, "queued");

		const shortIds = new Set(rows.map((r) => r.short_id));
		assert.equal(shortIds.size, 3);
		const outputDirs = new Set(rows.map((r) => r.output_dir));
		assert.equal(outputDirs.size, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("enqueueUrls: persists resolved config+meta on every row (mirrors insertQueuedSnapshot's contract)", () => {
	const { config, dir } = tempConfig();
	try {
		const meta = { collection: { name: "my-collection", config: {} } };
		const rows = enqueueUrls(
			["https://a.example.com/"],
			config,
			NO_AUTOSTART,
			meta,
		);

		const payload = JSON.parse(rows[0].job_payload ?? "{}");
		assert.deepEqual(payload.config, config);
		assert.deepEqual(payload.meta, meta);
		assert.equal(rows[0].collection, "my-collection");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("enqueueUrls: empty url list -> empty array, ⊥ error", () => {
	const { config, dir } = tempConfig();
	try {
		assert.deepEqual(enqueueUrls([], config, NO_AUTOSTART), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("enqueueUrls: worker.autostart===true triggers ensureWorkerRunning once per batch", async () => {
	const { config, dir } = tempConfig();
	const worker: WorkerConfig = { autostart: true, timeout: 30000 };
	const originalArgv1 = process.argv[1];
	try {
		// same technique as worker-cmd.test.ts's crash test — point the spawn
		// target at a nonexistent entry so the attempt is observable (crash
		// logged to the worker err log) without a real worker actually running.
		process.argv[1] = join(dir, "does-not-exist.ts");
		enqueueUrls(
			["https://a.example.com/", "https://b.example.com/"],
			config,
			worker,
		);

		const errLogPath = `${config.dbPath}.worker.err.log`;
		await waitFor(
			() =>
				existsSync(errLogPath) && readFileSync(errLogPath, "utf8").length > 0,
		);
		assert.match(readFileSync(errLogPath, "utf8"), /does-not-exist/);
	} finally {
		process.argv[1] = originalArgv1;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("enqueueUrls: worker.autostart===false -> ensureWorkerRunning never called, no err log written", async () => {
	const { config, dir } = tempConfig();
	const originalArgv1 = process.argv[1];
	try {
		process.argv[1] = join(dir, "does-not-exist.ts");
		enqueueUrls(["https://a.example.com/"], config, NO_AUTOSTART);

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(`${config.dbPath}.worker.err.log`), false);
	} finally {
		process.argv[1] = originalArgv1;
		rmSync(dir, { recursive: true, force: true });
	}
});
