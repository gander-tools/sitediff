import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { capture } from "../src/capture.ts";
import { getSnapshotByOutputDir, openDb } from "../src/db.ts";

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

test("capture(): full precedence chain file default < collection preset < named preset < overrides", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-capture-"));
	const dbPath = join(dir, "sitediff.sqlite");
	writeFileSync(
		join(dir, ".sitediff.json"),
		JSON.stringify({
			dbPath,
			config: { navTimeoutMs: 1111 },
			presets: {
				"mobile-preset": { sessionPath: "mobile-session" },
				"top-preset": { sessionPath: "top-session" },
			},
			collections: { mobile: "mobile-preset" },
		}),
	);

	try {
		const result = await capture(`${baseUrl}/`, {
			overrides: { navTimeoutMs: 999 },
			configPath: dir,
			collectionName: "mobile",
			presetName: "top-preset",
		});

		assert.equal(result.status, "completed");

		const settings = JSON.parse(
			readFileSync(join(result.outputDir, "settings.json"), "utf8"),
		);

		// overrides win over everything
		assert.equal(settings.config.navTimeoutMs, 999);
		// named preset wins over collection preset
		assert.equal(settings.config.sessionPath, "top-session");
		// meta reflects both collection + preset resolution
		assert.equal(settings.collection.name, "mobile");
		assert.equal(settings.preset.name, "top-preset");

		// sync capture() never passes through the queued/job_payload
		// path (the runCapture split left its own behavior unchanged) — row
		// lands directly as completed, job_payload stays NULL.
		const db = openDb(dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "completed");
		assert.equal(row?.job_payload, null);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("capture({enqueue:true}): inserts queued row, returns immediately, never runs the pipeline", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-capture-enqueue-"));
	const dbPath = join(dir, "sitediff.sqlite");
	const outDir = join(dir, "output");
	// worker.autostart:false in the config file — this test runs in-process
	// (not via cli.ts), so ensureWorkerRunning's real spawn (using
	// process.argv[1] as entry) would try to re-run THIS test file as a
	// detached worker process were autostart left at its true default.
	writeFileSync(
		join(dir, ".sitediff.json"),
		JSON.stringify({ dbPath, outDir, worker: { autostart: false } }),
	);

	try {
		const result = await capture(`${baseUrl}/`, {
			enqueue: true,
			configPath: dir,
			overrides: { navTimeoutMs: 4242 },
		});

		assert.equal(result.status, "queued");

		const db = openDb(dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "queued");
		const payload = JSON.parse(row?.job_payload ?? "{}");
		assert.equal(payload.config.navTimeoutMs, 4242); // resolved config persisted
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
