import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertSnapshot, openDb } from "../src/db.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// minimal PNG: 8-byte signature + IHDR chunk (readPngDims only reads bytes 16-23)
function writeFixturePng(path: string, width: number, height: number): void {
	const buf = Buffer.alloc(33);
	buf.write("\x89PNG\r\n\x1a\n", 0, "binary");
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	writeFileSync(path, buf);
}

function har() {
	return JSON.stringify({
		log: {
			pages: [{ pageTimings: { onLoad: 42 } }],
			entries: [
				{
					_resourceType: "document",
					request: { url: "https://example.com/" },
					response: { content: { size: 10 }, headers: [] },
				},
			],
		},
	});
}

test("cli: stats <shortId> --json prints wrote-message AND full stats report", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-stats-json-"));
	const outputDir = join(dir, "shot");
	try {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "dom.html"), "<html></html>");
		writeFixturePng(join(outputDir, "screenshot.png"), 800, 600);
		writeFileSync(join(outputDir, "capture.har"), har());

		// list/stats/diff ⊥ take a --config/env override — they always
		// resolve dbPath relative to cwd via DEFAULT_CONFIG, so the fixture db
		// must sit @ that literal relative path w/ cwd pointed @ dir.
		const dbPath = join(dir, "sitediff.sqlite");
		const db = openDb(dbPath);
		const shortId = insertSnapshot(db, {
			url: "https://example.com/",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir,
			status: "completed",
		});
		db.close();

		const result = spawnSync(
			process.execPath,
			[cliPath, "stats", shortId, "--json"],
			{ encoding: "utf8", cwd: dir },
		);
		assert.equal(result.status, 0);

		const lines = result.stdout.trim().split("\n");
		assert.match(lines[0], /^wrote .*stats\.json$/);
		const stats = JSON.parse(lines[1]);
		assert.equal(stats.loadTimeMs, 42);
		assert.deepEqual(stats.screenshot, { width: 800, height: 600 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
