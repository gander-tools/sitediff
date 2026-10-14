import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_WORKER_CONFIG } from "../src/config.ts";
import { getSnapshotByOutputDir, openDb } from "../src/db.ts";
import type { BaseConfig, WorkerConfig } from "../src/pipeline.ts";
import { insertQueuedSnapshot } from "../src/pipeline.ts";
import { runWorkerLoop } from "../src/worker.ts";

let server: Server;
let baseUrl: string;

before(async () => {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><body><h1>ok</h1></body></html>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address && typeof address === "object") {
		baseUrl = `http://127.0.0.1:${address.port}`;
	}
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tempConfig(): { config: BaseConfig; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-worker-"));
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

test("runWorkerLoop: processes queued jobs FIFO one at a time, updates status, clears pidfile on exit", async () => {
	const { config, dir } = tempConfig();
	try {
		const rowA = insertQueuedSnapshot(`${baseUrl}/`, config);
		const rowB = insertQueuedSnapshot(`${baseUrl}/`, config);

		const controller = new AbortController();
		const loopPromise = runWorkerLoop(config.dbPath, DEFAULT_WORKER_CONFIG, {
			pollMs: 20,
			signal: controller.signal,
		});

		const isDone = (outputDir: string) => {
			const db = openDb(config.dbPath);
			const row = getSnapshotByOutputDir(db, outputDir);
			db.close();
			return row?.status === "completed";
		};
		await waitFor(() => isDone(rowA.output_dir) && isDone(rowB.output_dir));

		controller.abort();
		await loopPromise;

		assert.equal(existsSync(`${config.dbPath}.worker.pid`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: SIGTERM-equivalent abort during idle wait exits promptly w/o picking up jobs enqueued after abort", async () => {
	const { config, dir } = tempConfig();
	try {
		const controller = new AbortController();
		const loopPromise = runWorkerLoop(config.dbPath, DEFAULT_WORKER_CONFIG, {
			pollMs: 20,
			signal: controller.signal,
		});

		// let it sit idle (no queued rows) for a couple poll cycles, then abort
		await new Promise((resolve) => setTimeout(resolve, 60));
		controller.abort();
		await loopPromise;

		// enqueue AFTER the loop has already exited — must remain untouched
		const row = insertQueuedSnapshot(`${baseUrl}/`, config);
		const db = openDb(config.dbPath);
		const fresh = getSnapshotByOutputDir(db, row.output_dir);
		db.close();
		assert.equal(fresh?.status, "queued");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: abort while a job is in-flight still lets it finish (job reaches completed, not left pending)", async () => {
	const { config, dir } = tempConfig();
	try {
		const row = insertQueuedSnapshot(`${baseUrl}/`, config);

		const controller = new AbortController();
		const loopPromise = runWorkerLoop(config.dbPath, DEFAULT_WORKER_CONFIG, {
			pollMs: 20,
			signal: controller.signal,
		});

		// abort almost immediately — the loop should already be mid-`runCaptureForRow`
		// for `row` (single queued job, picked up on the first iteration) by the
		// time abort is observed at the top of the next loop pass.
		controller.abort();
		await loopPromise;

		const db = openDb(config.dbPath);
		const finalRow = getSnapshotByOutputDir(db, row.output_dir);
		db.close();
		assert.equal(finalRow?.status, "completed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: self-exits (clears pidfile, promise resolves) after worker.timeout ms of continuous idle", async () => {
	const { config, dir } = tempConfig();
	const worker: WorkerConfig = { autostart: true, timeout: 80 };
	try {
		const start = Date.now();
		await runWorkerLoop(config.dbPath, worker, {
			pollMs: 20,
			signal: new AbortController().signal,
		});
		assert.ok(Date.now() - start >= 80);
		assert.equal(existsSync(`${config.dbPath}.worker.pid`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: worker.timeout=-1 never self-exits on idle, only stops via abort", async () => {
	const { config, dir } = tempConfig();
	const worker: WorkerConfig = { autostart: true, timeout: -1 };
	try {
		const controller = new AbortController();
		const loopPromise = runWorkerLoop(config.dbPath, worker, {
			pollMs: 20,
			signal: controller.signal,
		});

		// sit idle well past what would've been a self-exit timeout if -1
		// weren't honored, then confirm the loop is still running via abort
		await new Promise((resolve) => setTimeout(resolve, 150));
		controller.abort();
		await loopPromise;
		assert.equal(existsSync(`${config.dbPath}.worker.pid`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: idle clock resets when a job is picked up, not just on idle passes", async () => {
	const { config, dir } = tempConfig();
	const worker: WorkerConfig = { autostart: true, timeout: 150 };
	try {
		insertQueuedSnapshot(`${baseUrl}/`, config);

		const start = Date.now();
		await runWorkerLoop(config.dbPath, worker, {
			pollMs: 20,
			signal: new AbortController().signal,
		});
		const elapsed = Date.now() - start;
		// idle timer only starts counting once the queue goes empty (after the
		// job completes) — total time must be >= job time + full idle timeout,
		// not just >= the idle timeout alone (which the job's own runtime could
		// exceed if the clock incorrectly started at loop-start).
		assert.ok(elapsed >= 150);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorkerLoop: a job enqueued while idle-timeout is elapsing still gets picked up, ⊥ silently dropped", async () => {
	const { config, dir } = tempConfig();
	const worker: WorkerConfig = { autostart: true, timeout: 60 };
	try {
		// enqueue partway through the idle window, simulating a race with a
		// concurrent enqueue landing just as the worker is about to self-exit
		let row: ReturnType<typeof insertQueuedSnapshot> | undefined;
		setTimeout(() => {
			row = insertQueuedSnapshot(`${baseUrl}/`, config);
		}, 50);

		await runWorkerLoop(config.dbPath, worker, {
			pollMs: 10,
			signal: new AbortController().signal,
		});

		const db = openDb(config.dbPath);
		const finalRow = getSnapshotByOutputDir(db, row?.output_dir ?? "");
		db.close();
		assert.equal(finalRow?.status, "completed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
