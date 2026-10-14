import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { chromium } from "playwright";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getSnapshotByOutputDir, openDb, resolveFinalUrl } from "../src/db.ts";
import {
	type BaseConfig,
	insertQueuedSnapshot,
	runCapture,
	runCaptureForRow,
} from "../src/pipeline.ts";

let server: Server;
let baseUrl: string;

before(async () => {
	server = createServer((req, res) => {
		if (req.url === "/redirect") {
			res.writeHead(302, { Location: "/" });
			res.end();
			return;
		}
		if (req.url === "/ping") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("pong");
			return;
		}
		if (req.url === "/console-log") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				`<html><body><script>console.log("hello from page");</script></body></html>`,
			);
			return;
		}
		if (req.url === "/poll") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(`<html><body><h1>polling</h1><script>
        setInterval(() => { fetch("/ping"); }, 50);
      </script></body></html>`);
			return;
		}
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

function tempConfig(overrides: Partial<BaseConfig> = {}): {
	config: BaseConfig;
	dir: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-shot-"));
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
			...overrides,
		},
	};
}

function readShotFiles(outputDir: string) {
	return {
		har: existsSync(join(outputDir, "capture.har")),
		dom: existsSync(join(outputDir, "dom.html")),
		screenshot: existsSync(join(outputDir, "screenshot.png")),
		console: existsSync(join(outputDir, "console.json")),
		redirects: existsSync(join(outputDir, "redirects.json")),
		settings: existsSync(join(outputDir, "settings.json")),
	};
}

test("happy path: all 6 files exist, status completed, db row completed", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);

		assert.equal(result.status, "completed");
		assert.match(result.id, /^[0-9A-Za-z]{8}$/);
		const files = readShotFiles(result.outputDir);
		assert.deepEqual(files, {
			har: true,
			dom: true,
			screenshot: true,
			console: true,
			redirects: true,
			settings: true,
		});

		const domHtml = readFileSync(join(result.outputDir, "dom.html"), "utf8");
		assert.match(domHtml, /<h1>ok<\/h1>/);

		const har = JSON.parse(
			readFileSync(join(result.outputDir, "capture.har"), "utf8"),
		);
		const hasBody = har.log.entries.some(
			(entry: { response: { content: { text?: string } } }) =>
				(entry.response.content.text ?? "").length > 0,
		);
		assert.ok(
			hasBody,
			"expected ≥1 HAR entry with non-empty response.content.text",
		);

		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "completed");
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("console.json: page console.log produces a real entry (not just an empty file)", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/console-log`, config, true);

		assert.equal(result.status, "completed");
		const consoleEntries = JSON.parse(
			readFileSync(join(result.outputDir, "console.json"), "utf8"),
		);
		assert.ok(
			consoleEntries.some(
				(entry: { type: string; text: string }) =>
					entry.type === "log" && entry.text === "hello from page",
			),
			"expected a console.json entry matching the page's console.log call",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("redirect path: redirects.json records the hop chain", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/redirect`, config, true);

		assert.equal(result.status, "completed");
		const redirects = JSON.parse(
			readFileSync(join(result.outputDir, "redirects.json"), "utf8"),
		);
		assert.equal(redirects.length, 2);
		assert.match(redirects[0].url, /\/redirect$/);
		assert.equal(redirects[0].status, 302);
		assert.match(redirects[1].url, /\/$/);
		assert.equal(redirects[1].status, 200);

		const db = openDb(config.dbPath);
		assert.equal(resolveFinalUrl(db, redirects[0].url), redirects[1].url);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("nav-timeout path: networkidle bound by config.navTimeoutMs, still completed", async () => {
	const { config, dir } = tempConfig({ navTimeoutMs: 800 });
	try {
		const result = await runCapture(`${baseUrl}/poll`, config, true);

		assert.equal(result.status, "completed");
		const files = readShotFiles(result.outputDir);
		assert.ok(
			files.dom && files.screenshot && files.console && files.redirects,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("nav-exception path: connection refused still yields completed w/ captured state", async () => {
	const { config, dir } = tempConfig({ navTimeoutMs: 3000 });
	try {
		const result = await runCapture("http://127.0.0.1:56789/", config, true);

		assert.equal(result.status, "completed");
		const files = readShotFiles(result.outputDir);
		assert.ok(
			files.dom && files.screenshot && files.console && files.redirects,
		);

		const redirects = JSON.parse(
			readFileSync(join(result.outputDir, "redirects.json"), "utf8"),
		);
		assert.deepEqual(redirects, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pipeline-error path: unwritable output base dir -> status=error", async () => {
	const { config, dir } = tempConfig();
	// outDir's parent exists but is not writable -> mkdirSync inside runCapture throws
	const unwritableParent = join(dir, "locked");
	const fs = await import("node:fs");
	fs.mkdirSync(unwritableParent, { mode: 0o444 });
	config.outDir = join(unwritableParent, "nested");

	try {
		const result = await runCapture(`${baseUrl}/`, config, true);
		assert.equal(result.status, "error");

		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "error");
		db.close();
	} finally {
		fs.chmodSync(unwritableParent, 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("late-stage pipeline failure: dom.html retained, screenshot never written, status=error", async () => {
	const { config, dir } = tempConfig();
	const realLaunch = chromium.launch.bind(chromium);
	mock.method(
		chromium,
		"launch",
		async (...args: Parameters<typeof chromium.launch>) => {
			const browser = await realLaunch(...args);
			const realNewContext = browser.newContext.bind(browser);
			browser.newContext = (async (
				...ctxArgs: Parameters<typeof browser.newContext>
			) => {
				const context = await realNewContext(...ctxArgs);
				const realNewPage = context.newPage.bind(context);
				context.newPage = (async () => {
					const page = await realNewPage();
					page.screenshot = async () => {
						throw new Error("forced screenshot failure");
					};
					return page;
				}) as typeof context.newPage;
				return context;
			}) as typeof browser.newContext;
			return browser;
		},
	);

	try {
		const result = await runCapture(`${baseUrl}/`, config, true);

		assert.equal(result.status, "error");
		assert.ok(
			existsSync(join(result.outputDir, "dom.html")),
			"dom.html written before the forced failure must be retained",
		);
		assert.ok(
			!existsSync(join(result.outputDir, "screenshot.png")),
			"screenshot.png must not exist - the stage that failed never wrote it",
		);

		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "error");
		db.close();
	} finally {
		mock.reset();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hideSelectors sets display:none, dropSelectors removes from DOM entirely, before dom dump", async () => {
	const { config, dir } = tempConfig({
		hideSelectors: ["body"],
		dropSelectors: ["h1"],
	});
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);

		assert.equal(result.status, "completed");
		const domHtml = readFileSync(join(result.outputDir, "dom.html"), "utf8");
		assert.match(domHtml, /<body[^>]*style="[^"]*display:\s*none/);
		assert.doesNotMatch(domHtml, /<h1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("maskSelectors passed to page.screenshot without error", async () => {
	const { config, dir } = tempConfig({ maskSelectors: ["h1"] });
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);

		assert.equal(result.status, "completed");
		assert.ok(existsSync(join(result.outputDir, "screenshot.png")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selector w/ 0 DOM matches is a silent no-op", async () => {
	const { config, dir } = tempConfig({
		hideSelectors: [".does-not-exist"],
		dropSelectors: ["#missing"],
		maskSelectors: ["section.nope"],
	});
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);
		assert.equal(result.status, "completed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("BaseConfig.sessionPath defaults to undefined", () => {
	assert.equal(DEFAULT_CONFIG.sessionPath, undefined);
});

test("runCapture w/ collection name -> db row collection set", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "my-collection", config: {} },
		});
		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.collection, "my-collection");
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCapture w/o collection name -> db row collection is NULL", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);
		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.collection, null);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function readSettings(outputDir: string) {
	return JSON.parse(readFileSync(join(outputDir, "settings.json"), "utf8"));
}

test("settings.json: bare capture -> {config} only, no collection/preset keys", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/`, config, true);
		const settings = readSettings(result.outputDir);
		assert.deepEqual(Object.keys(settings), ["config"]);
		assert.deepEqual(settings.config, config);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings.json: w/ collection meta -> {collection:{name,config}, config}", async () => {
	const { config, dir } = tempConfig();
	try {
		const collectionConfig = { outDir: "collection-out" };
		const result = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "my-collection", config: collectionConfig },
		});
		const settings = readSettings(result.outputDir);
		assert.deepEqual(Object.keys(settings), ["collection", "config"]);
		assert.deepEqual(settings.collection, {
			name: "my-collection",
			config: collectionConfig,
		});
		assert.deepEqual(settings.config, config);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings.json: w/ preset meta -> {preset:{name,config}, config}", async () => {
	const { config, dir } = tempConfig();
	try {
		const presetConfig = { outDir: "preset-out" };
		const result = await runCapture(`${baseUrl}/`, config, true, {
			preset: { name: "my-preset", config: presetConfig },
		});
		const settings = readSettings(result.outputDir);
		assert.deepEqual(Object.keys(settings), ["preset", "config"]);
		assert.deepEqual(settings.preset, {
			name: "my-preset",
			config: presetConfig,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings.json: w/ both collection & preset meta -> {collection, preset, config}", async () => {
	const { config, dir } = tempConfig();
	try {
		const result = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "my-collection", config: {} },
			preset: { name: "my-preset", config: {} },
		});
		const settings = readSettings(result.outputDir);
		assert.deepEqual(Object.keys(settings), ["collection", "preset", "config"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings.json: contains 0 headless key in any variant", async () => {
	const { config, dir } = tempConfig();
	try {
		const bare = await runCapture(`${baseUrl}/`, config, true);
		assert.ok(!("headless" in readSettings(bare.outputDir).config));

		const withCollection = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "c", config: {} },
		});
		const collectionSettings = readSettings(withCollection.outputDir);
		assert.ok(!("headless" in collectionSettings.config));
		assert.ok(!("headless" in collectionSettings.collection.config));

		const withPreset = await runCapture(`${baseUrl}/`, config, true, {
			preset: { name: "p", config: {} },
		});
		const presetSettings = readSettings(withPreset.outputDir);
		assert.ok(!("headless" in presetSettings.config));
		assert.ok(!("headless" in presetSettings.preset.config));

		const withBoth = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "c", config: {} },
			preset: { name: "p", config: {} },
		});
		assert.ok(!("headless" in readSettings(withBoth.outputDir).config));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings.json write failure -> status=error", async () => {
	const { config, dir } = tempConfig();
	// unserializable meta forces JSON.stringify to throw inside the
	// settings.json write, same as any other real serialization failure -
	// node:fs exports aren't mock-configurable across the ESM/CJS boundary,
	// so this exercises the real failure path instead of mocking fs.
	const circular: Record<string, unknown> = {};
	circular.self = circular;

	try {
		const result = await runCapture(`${baseUrl}/`, config, true, {
			collection: { name: "my-collection", config: circular },
		});
		assert.equal(result.status, "error");

		const db = openDb(config.dbPath);
		const row = getSnapshotByOutputDir(db, result.outputDir);
		assert.equal(row?.status, "error");
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("insertQueuedSnapshot: inserts queued row, persists resolved config+meta, never runs pipeline", () => {
	const { config, dir } = tempConfig();
	try {
		const meta = { collection: { name: "my-collection", config: {} } };
		const row = insertQueuedSnapshot(`${baseUrl}/`, config, meta);

		assert.equal(row.status, "queued");
		assert.equal(row.url, `${baseUrl}/`);
		assert.equal(existsSync(row.output_dir), false); // pipeline never ran, dir never created

		const payload = JSON.parse(row.job_payload ?? "{}");
		assert.deepEqual(payload.config, config);
		assert.deepEqual(payload.meta, meta);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCaptureForRow: runs pipeline on the EXISTING row — queued -> pending -> completed, exactly 1 row, files match the row's own persisted config", async () => {
	const { config, dir } = tempConfig();
	try {
		const row = insertQueuedSnapshot(`${baseUrl}/`, config);
		const { config: jobConfig, meta } = JSON.parse(row.job_payload ?? "{}");

		const result = await runCaptureForRow(row, jobConfig, true, meta);

		assert.equal(result.status, "completed");
		assert.equal(result.outputDir, row.output_dir); // same row/dir, no duplicate
		const files = readShotFiles(result.outputDir);
		assert.deepEqual(files, {
			har: true,
			dom: true,
			screenshot: true,
			console: true,
			redirects: true,
			settings: true,
		});

		const db = openDb(config.dbPath);
		const finalRow = getSnapshotByOutputDir(db, row.output_dir);
		assert.equal(finalRow?.status, "completed");
		assert.equal(finalRow?.id, row.id); // exactly the same row, no insert happened
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
