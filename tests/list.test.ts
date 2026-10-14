import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertSnapshot, listSnapshots, openDb } from "../src/db.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function withTempDb<T>(fn: (db: DatabaseSync) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-list-"));
	const db = openDb(join(dir, "test.sqlite"));
	try {
		return fn(db);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

let seq = 0;
function seed(
	db: DatabaseSync,
	overrides: Partial<{
		url: string;
		timestamp: string;
		status: "pending" | "completed" | "error";
		collection: string | null;
		width: number | null;
		height: number | null;
	}> = {},
) {
	seq++;
	return insertSnapshot(db, {
		url: overrides.url ?? "https://example.com/",
		timestamp: overrides.timestamp ?? "2026-07-27T00:00:00.000Z",
		outputDir: `/tmp/list-shot-${seq}`,
		status: overrides.status ?? "completed",
		collection: overrides.collection,
		width: overrides.width ?? 1920,
		height: overrides.height ?? 1080,
	});
}

test("listSnapshots: no filters returns all rows sorted timestamp desc", () => {
	withTempDb((db) => {
		seed(db, {
			url: "https://a.example.com/",
			timestamp: "2026-07-25T00:00:00.000Z",
		});
		seed(db, {
			url: "https://b.example.com/",
			timestamp: "2026-07-27T00:00:00.000Z",
		});
		seed(db, {
			url: "https://c.example.com/",
			timestamp: "2026-07-26T00:00:00.000Z",
		});

		const rows = listSnapshots(db);
		assert.deepEqual(
			rows.map((r) => r.host),
			["b.example.com", "c.example.com", "a.example.com"],
		);
	});
});

test("listSnapshots: --collection exact match", () => {
	withTempDb((db) => {
		seed(db, { collection: "my-coll" });
		seed(db, { collection: "other" });

		const rows = listSnapshots(db, { collection: "my-coll" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].collection, "my-coll");
	});
});

test("listSnapshots: --width/--height exact numeric match", () => {
	withTempDb((db) => {
		seed(db, { width: 1920, height: 1080 });
		seed(db, { width: 800, height: 600 });

		assert.equal(listSnapshots(db, { width: 800 }).length, 1);
		assert.equal(listSnapshots(db, { height: 600 }).length, 1);
		assert.equal(listSnapshots(db, { width: 800, height: 1080 }).length, 0);
	});
});

test("listSnapshots: --status exact match, omitted shows all statuses", () => {
	withTempDb((db) => {
		seed(db, { status: "completed" });
		seed(db, { status: "error" });
		seed(db, { status: "pending" });

		assert.equal(listSnapshots(db).length, 3);
		assert.equal(listSnapshots(db, { status: "error" }).length, 1);
	});
});

test("listSnapshots: --after/--before inclusive range on timestamp", () => {
	withTempDb((db) => {
		seed(db, { timestamp: "2026-07-25T00:00:00.000Z" });
		seed(db, { timestamp: "2026-07-26T00:00:00.000Z" });
		seed(db, { timestamp: "2026-07-27T00:00:00.000Z" });

		assert.equal(
			listSnapshots(db, { after: "2026-07-26T00:00:00.000Z" }).length,
			2,
		);
		assert.equal(
			listSnapshots(db, { before: "2026-07-26T00:00:00.000Z" }).length,
			2,
		);
		assert.equal(
			listSnapshots(db, {
				after: "2026-07-26T00:00:00.000Z",
				before: "2026-07-26T00:00:00.000Z",
			}).length,
			1,
		);
	});
});

test("listSnapshots: --host glob match", () => {
	withTempDb((db) => {
		seed(db, { url: "https://sub.example.com/" });
		seed(db, { url: "https://other.com/" });

		const rows = listSnapshots(db, { host: "*.example.com" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].host, "sub.example.com");
	});
});

test("listSnapshots: --path glob match", () => {
	withTempDb((db) => {
		seed(db, { url: "https://example.com/foo/bar" });
		seed(db, { url: "https://example.com/baz" });

		const rows = listSnapshots(db, { path: "/foo/*" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].path, "/foo/bar");
	});
});

test("listSnapshots: combined collection+path filter across 2 different hosts", () => {
	withTempDb((db) => {
		seed(db, {
			url: "https://a.example.com/report",
			collection: "audits",
		});
		seed(db, {
			url: "https://b.example.com/report",
			collection: "audits",
		});
		seed(db, {
			url: "https://a.example.com/other",
			collection: "audits",
		});
		seed(db, {
			url: "https://a.example.com/report",
			collection: "different",
		});

		const rows = listSnapshots(db, { collection: "audits", path: "/report" });
		assert.equal(rows.length, 2);
		assert.deepEqual(rows.map((r) => r.host).sort(), [
			"a.example.com",
			"b.example.com",
		]);
	});
});

test("listSnapshots: malformed stored url -> placeholder host/path, does not throw, excluded from glob filters", () => {
	withTempDb((db) => {
		seq++;
		insertSnapshot(db, {
			url: "not a url",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: `/tmp/list-shot-${seq}`,
			status: "completed",
			width: 1920,
			height: 1080,
		});
		seed(db, { url: "https://example.com/" });

		const all = listSnapshots(db);
		assert.equal(all.length, 2);
		const bad = all.find((r) => r.url === "not a url");
		assert.equal(bad?.host, "?");
		assert.equal(bad?.path, "?");

		const filtered = listSnapshots(db, { host: "*.com" });
		assert.ok(!filtered.some((r) => r.url === "not a url"));
		assert.ok(filtered.some((r) => r.url === "https://example.com/"));
	});
});

test("cli: list --json prints raw JSON matching listSnapshots output", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-list-cli-"));
	// list ⊥ takes a --config/env override — resolves dbPath relative
	// to cwd via DEFAULT_CONFIG, so the fixture db sits @ that literal path.
	const dbPath = join(dir, "sitediff.sqlite");
	try {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com/",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: "/tmp/cli-list-shot",
			status: "completed",
			width: 1920,
			height: 1080,
		});
		db.close();

		const result = spawnSync(process.execPath, [cliPath, "list", "--json"], {
			cwd: dir,
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].host, "example.com");
		assert.equal(rows[0].width, 1920);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
