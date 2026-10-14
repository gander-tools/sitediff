import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { insertSnapshot, openDb } from "../src/db.ts";
import {
	ensureStats,
	generateStats,
	generateStatsForOutputDir,
} from "../src/stats.ts";

// minimal PNG: 8-byte signature + IHDR chunk (length,type,data,crc — crc
// value doesn't matter, readPngDims only reads bytes 16-23) with known dims.
function writeFixturePng(path: string, width: number, height: number): void {
	const buf = Buffer.alloc(33);
	buf.write("\x89PNG\r\n\x1a\n", 0, "binary"); // 8-byte signature
	buf.writeUInt32BE(13, 8); // IHDR chunk length
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	writeFileSync(path, buf);
}

function har(entries: unknown[], onLoad = 100) {
	return JSON.stringify({
		log: { pages: [{ pageTimings: { onLoad } }], entries },
	});
}

function makeFixtureOutputDir(): { dir: string; outputDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-stats-"));
	writeFileSync(join(dir, "dom.html"), "<html></html>");
	writeFixturePng(join(dir, "screenshot.png"), 1920, 1080);
	return { dir, outputDir: dir };
}

test("generateStatsForOutputDir: shape/content from a fixture HAR", () => {
	const { dir, outputDir } = makeFixtureOutputDir();
	try {
		writeFileSync(
			join(outputDir, "capture.har"),
			har(
				[
					{
						_resourceType: "document",
						request: { url: "https://example.com/index.html?x=1" },
						response: {
							content: { size: 37 },
							headers: [
								{ name: "Content-Type", value: "text/html" },
								{ name: "vary", value: "Accept" },
								{ name: "vary", value: "Origin" },
							],
						},
					},
				],
				40,
			),
		);

		const stats = generateStatsForOutputDir(outputDir);
		assert.equal(stats.loadTimeMs, 40);
		assert.equal(stats.totalBytes, 37);
		assert.equal(stats.domSizeBytes, "<html></html>".length);
		assert.deepEqual(stats.screenshot, { width: 1920, height: 1080 });
		assert.equal(stats.resources.length, 1);
		assert.equal(stats.resources[0].host, "example.com");
		assert.equal(stats.resources[0].path, "/index.html");
		assert.equal(stats.resources[0].type, "document");
		assert.equal(stats.resources[0].sizeBytes, 37);
		assert.deepEqual(stats.resources[0].headers.vary, ["Accept", "Origin"]);
		assert.deepEqual(stats.resources[0].headers["content-type"], ["text/html"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generateStatsForOutputDir: -1 sentinel excluded from totalBytes, loadTimeMs -> null", () => {
	const { dir, outputDir } = makeFixtureOutputDir();
	try {
		writeFileSync(
			join(outputDir, "capture.har"),
			har(
				[
					{
						_resourceType: "document",
						request: { url: "https://example.com/redirect" },
						response: { content: { size: -1 }, headers: [] },
					},
					{
						_resourceType: "script",
						request: { url: "https://example.com/app.js" },
						response: { content: { size: 50 }, headers: [] },
					},
				],
				-1,
			),
		);

		const stats = generateStatsForOutputDir(outputDir);
		assert.equal(stats.loadTimeMs, null);
		assert.equal(stats.totalBytes, 50);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generateStatsForOutputDir: writes stats.json to outputDir", () => {
	const { dir, outputDir } = makeFixtureOutputDir();
	try {
		writeFileSync(join(outputDir, "capture.har"), har([]));
		generateStatsForOutputDir(outputDir);
		const written = JSON.parse(
			readFileSync(join(outputDir, "stats.json"), "utf8"),
		);
		assert.equal(written.totalBytes, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generateStats: unknown shortId throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-stats-db-"));
	try {
		const db = openDb(join(dir, "test.sqlite"));
		assert.throws(() => generateStats(db, "nonexistent"), /unknown shortId/);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureStats: missing stats.json generates it (matches generateStats output)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-ensure-stats-"));
	try {
		const outputDir = join(dir, "shot-1");
		mkdirSync(outputDir);
		writeFileSync(join(outputDir, "dom.html"), "<a></a>");
		writeFixturePng(join(outputDir, "screenshot.png"), 100, 200);
		writeFileSync(join(outputDir, "capture.har"), har([]));

		const db = openDb(join(dir, "test.sqlite"));
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir,
			status: "completed",
		});

		const stats = ensureStats(db, shortId);
		assert.deepEqual(stats.screenshot, { width: 100, height: 200 });
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureStats: existing stats.json is reused as-is, not rewritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-ensure-stats-reuse-"));
	try {
		const outputDir = join(dir, "shot-1");
		mkdirSync(outputDir);
		writeFileSync(join(outputDir, "dom.html"), "<a></a>");
		writeFixturePng(join(outputDir, "screenshot.png"), 100, 200);
		writeFileSync(join(outputDir, "capture.har"), har([]));

		const db = openDb(join(dir, "test.sqlite"));
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir,
			status: "completed",
		});

		// pre-existing stats.json with content generateStats would never
		// produce (proves reuse, not regeneration) + captures its mtime
		const staleStats = {
			loadTimeMs: 999,
			totalBytes: 999,
			domSizeBytes: 999,
			screenshot: { width: 1, height: 1 },
			resources: [],
		};
		writeFileSync(join(outputDir, "stats.json"), JSON.stringify(staleStats));
		const mtimeBefore = statSync(join(outputDir, "stats.json")).mtimeMs;

		const first = ensureStats(db, shortId);
		const mtimeAfterFirst = statSync(join(outputDir, "stats.json")).mtimeMs;
		const second = ensureStats(db, shortId);
		const mtimeAfterSecond = statSync(join(outputDir, "stats.json")).mtimeMs;

		assert.deepEqual(first, staleStats);
		assert.deepEqual(second, staleStats);
		assert.equal(mtimeAfterFirst, mtimeBefore);
		assert.equal(mtimeAfterSecond, mtimeBefore);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generateStats: resolves shortId via db then generates fixture stats", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-stats-db2-"));
	try {
		const outputDir = join(dir, "shot-1");
		mkdirSync(outputDir);
		writeFileSync(join(outputDir, "dom.html"), "<a></a>");
		writeFixturePng(join(outputDir, "screenshot.png"), 100, 200);
		writeFileSync(join(outputDir, "capture.har"), har([]));

		const db = openDb(join(dir, "test.sqlite"));
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir,
			status: "completed",
		});

		const stats = generateStats(db, shortId);
		assert.deepEqual(stats.screenshot, { width: 100, height: 200 });
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
