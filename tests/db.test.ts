import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
	countSnapshotsByStatus,
	getNextQueuedSnapshot,
	getSnapshotByOutputDir,
	getSnapshotByShortId,
	hashUrl,
	insertSnapshot,
	normalizeUrl,
	openDb,
	recordRedirectChain,
	resolveFinalUrl,
	updateSnapshotStatus,
	withDb,
} from "../src/db.ts";

function withTempDb<T>(fn: (dbPath: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-db-"));
	try {
		return fn(join(dir, "test.sqlite"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("insertSnapshot writes a pending row before pipeline work", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-1",
			status: "pending",
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-1");
		assert.equal(row?.status, "pending");
		assert.equal(row?.url, "https://example.com");
		db.close();
	});
});

test("openDb sets a busy_timeout > 0 — concurrent access waits instead of throwing SQLITE_BUSY immediately", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const row = db.prepare("PRAGMA busy_timeout").get() as
			| { timeout: number }
			| undefined;
		assert.ok(
			row && row.timeout > 0,
			`expected busy_timeout > 0, got ${row?.timeout}`,
		);
		db.close();
	});
});

test("updateSnapshotStatus transitions pending -> completed", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-2",
			status: "pending",
		});

		updateSnapshotStatus(db, "/tmp/shot-2", "completed");

		const row = getSnapshotByOutputDir(db, "/tmp/shot-2");
		assert.equal(row?.status, "completed");
		db.close();
	});
});

test("insertSnapshot accepts queued status; updateSnapshotStatus transitions queued -> pending -> completed", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-queued",
			status: "queued",
		});

		let row = getSnapshotByOutputDir(db, "/tmp/shot-queued");
		assert.equal(row?.status, "queued");

		updateSnapshotStatus(db, "/tmp/shot-queued", "pending");
		row = getSnapshotByOutputDir(db, "/tmp/shot-queued");
		assert.equal(row?.status, "pending");

		updateSnapshotStatus(db, "/tmp/shot-queued", "completed");
		row = getSnapshotByOutputDir(db, "/tmp/shot-queued");
		assert.equal(row?.status, "completed");
		db.close();
	});
});

test("insertSnapshot persists job_payload; readable back verbatim", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const payload = JSON.stringify({
			config: { navTimeoutMs: 5000 },
			meta: {},
		});
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-payload",
			status: "queued",
			jobPayload: payload,
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-payload");
		assert.equal(row?.job_payload, payload);
		db.close();
	});
});

test("insertSnapshot w/o jobPayload -> job_payload is NULL", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-nopayload",
			status: "pending",
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-nopayload");
		assert.equal(row?.job_payload, null);
		db.close();
	});
});

test("getNextQueuedSnapshot returns oldest queued row (FIFO by id), ignores non-queued", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com/a",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-q1",
			status: "completed",
		});
		insertSnapshot(db, {
			url: "https://example.com/b",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-q2",
			status: "queued",
		});
		insertSnapshot(db, {
			url: "https://example.com/c",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-q3",
			status: "queued",
		});

		const next = getNextQueuedSnapshot(db);
		assert.equal(next?.output_dir, "/tmp/shot-q2");
		db.close();
	});
});

test("getNextQueuedSnapshot returns undefined when no queued rows", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		assert.equal(getNextQueuedSnapshot(db), undefined);
		db.close();
	});
});

test("countSnapshotsByStatus tallies rows per status, zero-fills absent statuses", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com/a",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-c1",
			status: "queued",
		});
		insertSnapshot(db, {
			url: "https://example.com/b",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-c2",
			status: "queued",
		});
		insertSnapshot(db, {
			url: "https://example.com/c",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-c3",
			status: "completed",
		});

		const counts = countSnapshotsByStatus(db);
		assert.deepEqual(counts, { queued: 2, pending: 0, completed: 1, error: 0 });
		db.close();
	});
});

test("insertSnapshot writes provided collection value", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-23T00:00:00.000Z",
			outputDir: "/tmp/shot-collection",
			status: "pending",
			collection: "my-collection",
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-collection");
		assert.equal(row?.collection, "my-collection");
		db.close();
	});
});

test("openDb adds collection column to pre-existing db missing it", () => {
	withTempDb((dbPath) => {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        output_dir TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
      )
    `);
		legacy.close();

		const db = openDb(dbPath); // must not throw despite the missing column
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-23T00:00:00.000Z",
			outputDir: "/tmp/shot-legacy",
			status: "pending",
			collection: "c1",
		});
		const row = getSnapshotByOutputDir(db, "/tmp/shot-legacy");
		assert.equal(row?.collection, "c1");
		db.close();
	});
});

test("openDb adds redirect_urls table without throwing on legacy db", () => {
	withTempDb((dbPath) => {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        output_dir TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
      )
    `);
		legacy.close();

		const db = openDb(dbPath); // must not throw despite missing redirect_urls table
		db.prepare("INSERT INTO redirect_urls (url_hash, url) VALUES (?, ?)").run(
			"h1",
			"https://example.com",
		);
		const row = db
			.prepare("SELECT * FROM redirect_urls WHERE url_hash = ?")
			.get("h1") as { url: string } | undefined;
		assert.equal(row?.url, "https://example.com");
		db.close();
	});
});

test("insertSnapshot returns an 8-char base62 short_id matching the stored row", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-26T00:00:00.000Z",
			outputDir: "/tmp/shot-shortid",
			status: "pending",
		});

		assert.match(shortId, /^[0-9A-Za-z]{8}$/);
		const row = getSnapshotByOutputDir(db, "/tmp/shot-shortid");
		assert.equal(row?.short_id, shortId);
		db.close();
	});
});

test("openDb adds short_id column + unique index to pre-existing db missing it", () => {
	withTempDb((dbPath) => {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        output_dir TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
      )
    `);
		legacy.close();

		const db = openDb(dbPath); // must not throw despite the missing column
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-23T00:00:00.000Z",
			outputDir: "/tmp/shot-legacy-shortid",
			status: "pending",
		});
		const row = getSnapshotByOutputDir(db, "/tmp/shot-legacy-shortid");
		assert.equal(row?.short_id, shortId);
		db.close();
	});
});

test("insertSnapshot retries on short_id collision, succeeds on 2nd attempt", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const originalPrepare = db.prepare.bind(db);
		let insertCalls = 0;
		db.prepare = ((sql: string) => {
			const stmt = originalPrepare(sql);
			if (sql.startsWith("INSERT INTO snapshots")) {
				const originalRun = stmt.run.bind(stmt);
				stmt.run = ((...args: unknown[]) => {
					insertCalls++;
					if (insertCalls === 1) {
						throw new Error("UNIQUE constraint failed: snapshots.short_id");
					}
					return originalRun(...(args as []));
				}) as typeof stmt.run;
			}
			return stmt;
		}) as typeof db.prepare;

		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-26T00:00:00.000Z",
			outputDir: "/tmp/shot-retry",
			status: "pending",
		});

		assert.equal(insertCalls, 2);
		const row = getSnapshotByOutputDir(db, "/tmp/shot-retry");
		assert.equal(row?.short_id, shortId);
		db.close();
	});
});

test("insertSnapshot rethrows immediately on a non-short_id UNIQUE conflict (does not retry)", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const originalPrepare = db.prepare.bind(db);
		let insertCalls = 0;
		db.prepare = ((sql: string) => {
			const stmt = originalPrepare(sql);
			if (sql.startsWith("INSERT INTO snapshots")) {
				stmt.run = (() => {
					insertCalls++;
					throw new Error("UNIQUE constraint failed: snapshots.output_dir");
				}) as typeof stmt.run;
			}
			return stmt;
		}) as typeof db.prepare;

		assert.throws(
			() =>
				insertSnapshot(db, {
					url: "https://example.com",
					timestamp: "2026-07-26T00:00:00.000Z",
					outputDir: "/tmp/shot-dup",
					status: "pending",
				}),
			/UNIQUE constraint failed: snapshots\.output_dir/,
		);
		assert.equal(insertCalls, 1);
		db.close();
	});
});

test("normalizeUrl: lowercases host", () => {
	assert.equal(
		normalizeUrl("https://EXAMPLE.com/path"),
		"https://example.com/path",
	);
});

test("normalizeUrl: strips default port", () => {
	assert.equal(
		normalizeUrl("https://example.com:443/path"),
		"https://example.com/path",
	);
	assert.equal(
		normalizeUrl("http://example.com:80/path"),
		"http://example.com/path",
	);
	assert.equal(
		normalizeUrl("http://example.com:8080/path"),
		"http://example.com:8080/path",
	);
});

test("normalizeUrl: strips fragment", () => {
	assert.equal(
		normalizeUrl("https://example.com/path#section"),
		"https://example.com/path",
	);
});

test("normalizeUrl: sorts query params", () => {
	assert.equal(
		normalizeUrl("https://example.com/path?b=2&a=1"),
		normalizeUrl("https://example.com/path?a=1&b=2"),
	);
});

test("normalizeUrl: normalizes trailing slash, root path untouched", () => {
	assert.equal(
		normalizeUrl("https://example.com/path/"),
		"https://example.com/path",
	);
	assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
});

test("hashUrl: equivalent URLs hash identically", () => {
	assert.equal(
		hashUrl("https://EXAMPLE.com:443/path/?b=2&a=1"),
		hashUrl("https://example.com/path?a=1&b=2#frag"),
	);
});

test("recordRedirectChain: chain A->B->C path-compresses final_url_id for every node", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		recordRedirectChain(db, [
			{ url: "https://a.example.com/", status: 301 },
			{ url: "https://b.example.com/", status: 302 },
			{ url: "https://c.example.com/", status: 200 },
		]);
		const finalHash = hashUrl("https://c.example.com/");
		for (const url of [
			"https://a.example.com/",
			"https://b.example.com/",
			"https://c.example.com/",
		]) {
			const row = db
				.prepare("SELECT final_url_id FROM redirect_urls WHERE url_hash = ?")
				.get(hashUrl(url)) as { final_url_id: string } | undefined;
			assert.equal(row?.final_url_id, finalHash);
		}
		db.close();
	});
});

test("recordRedirectChain: empty chain is a no-op", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		recordRedirectChain(db, []);
		const count = db
			.prepare("SELECT COUNT(*) as c FROM redirect_urls")
			.get() as {
			c: number;
		};
		assert.equal(count.c, 0);
		db.close();
	});
});

test("recordRedirectChain: cycle leaves final_url_id unresolved (null), does not throw", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		assert.doesNotThrow(() => {
			recordRedirectChain(db, [
				{ url: "https://a.example.com/", status: 302 },
				{ url: "https://b.example.com/", status: 302 },
				{ url: "https://a.example.com/", status: 302 },
			]);
		});
		const row = db
			.prepare("SELECT final_url_id FROM redirect_urls WHERE url_hash = ?")
			.get(hashUrl("https://a.example.com/")) as
			| { final_url_id: string | null }
			| undefined;
		assert.equal(row?.final_url_id, null);
		db.close();
	});
});

test("recordRedirectChain: chain longer than 20 hops is treated as unresolved", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const chain = Array.from({ length: 21 }, (_, i) => ({
			url: `https://example.com/hop-${i}`,
			status: 302,
		}));
		recordRedirectChain(db, chain);
		const row = db
			.prepare("SELECT final_url_id FROM redirect_urls WHERE url_hash = ?")
			.get(hashUrl(chain[0].url)) as
			| { final_url_id: string | null }
			| undefined;
		assert.equal(row?.final_url_id, null);
		db.close();
	});
});

test("recordRedirectChain: re-recording same start url overwrites, does not duplicate", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		recordRedirectChain(db, [
			{ url: "https://a.example.com/", status: 301 },
			{ url: "https://b.example.com/", status: 200 },
		]);
		recordRedirectChain(db, [
			{ url: "https://a.example.com/", status: 301 },
			{ url: "https://d.example.com/", status: 200 },
		]);
		const count = db
			.prepare("SELECT COUNT(*) as c FROM redirect_urls WHERE url_hash = ?")
			.get(hashUrl("https://a.example.com/")) as { c: number };
		assert.equal(count.c, 1);
		const row = db
			.prepare("SELECT final_url_id FROM redirect_urls WHERE url_hash = ?")
			.get(hashUrl("https://a.example.com/")) as { final_url_id: string };
		assert.equal(row.final_url_id, hashUrl("https://d.example.com/"));
		db.close();
	});
});

test("resolveFinalUrl: resolves start, middle, and terminal url of a chain to the terminal url", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		recordRedirectChain(db, [
			{ url: "https://a.example.com/", status: 301 },
			{ url: "https://b.example.com/", status: 302 },
			{ url: "https://c.example.com/", status: 200 },
		]);
		assert.equal(
			resolveFinalUrl(db, "https://a.example.com/"),
			"https://c.example.com/",
		);
		assert.equal(
			resolveFinalUrl(db, "https://b.example.com/"),
			"https://c.example.com/",
		);
		assert.equal(
			resolveFinalUrl(db, "https://c.example.com/"),
			"https://c.example.com/",
		);
		db.close();
	});
});

test("resolveFinalUrl: unknown url returns undefined, not an error", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		assert.equal(
			resolveFinalUrl(db, "https://never-seen.example.com/"),
			undefined,
		);
		db.close();
	});
});

test("resolveFinalUrl: unresolved (cycle) chain returns undefined", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		recordRedirectChain(db, [
			{ url: "https://a.example.com/", status: 302 },
			{ url: "https://b.example.com/", status: 302 },
			{ url: "https://a.example.com/", status: 302 },
		]);
		assert.equal(resolveFinalUrl(db, "https://a.example.com/"), undefined);
		db.close();
	});
});

test("recordRedirectChain: failure mid-write rolls back, leaves 0 partial rows", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const originalPrepare = db.prepare.bind(db);
		let insertCalls = 0;
		db.prepare = ((sql: string) => {
			const stmt = originalPrepare(sql);
			if (sql.startsWith("INSERT INTO redirect_urls")) {
				const originalRun = stmt.run.bind(stmt);
				stmt.run = ((...args: unknown[]) => {
					insertCalls++;
					if (insertCalls === 2) throw new Error("simulated failure");
					return originalRun(...(args as []));
				}) as typeof stmt.run;
			}
			return stmt;
		}) as typeof db.prepare;

		assert.throws(() => {
			recordRedirectChain(db, [
				{ url: "https://a.example.com/", status: 301 },
				{ url: "https://b.example.com/", status: 301 },
				{ url: "https://c.example.com/", status: 200 },
			]);
		}, /simulated failure/);

		const count = originalPrepare(
			"SELECT COUNT(*) as c FROM redirect_urls",
		).get() as { c: number };
		assert.equal(count.c, 0);
		db.close();
	});
});

test("insertSnapshot writes provided width/height", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: "/tmp/shot-dims",
			status: "pending",
			width: 1920,
			height: 1080,
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-dims");
		assert.equal(row?.width, 1920);
		assert.equal(row?.height, 1080);
		db.close();
	});
});

test("insertSnapshot omitting width/height stores NULL (pre-migration-row shape)", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: "/tmp/shot-no-dims",
			status: "pending",
		});

		const row = getSnapshotByOutputDir(db, "/tmp/shot-no-dims");
		assert.equal(row?.width, null);
		assert.equal(row?.height, null);
		db.close();
	});
});

test("openDb adds width/height columns to pre-existing db missing them", () => {
	withTempDb((dbPath) => {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        output_dir TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL
      )
    `);
		legacy.close();

		const db = openDb(dbPath); // must not throw despite the missing columns
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: "/tmp/shot-legacy-dims",
			status: "pending",
			width: 800,
			height: 600,
		});
		const row = getSnapshotByOutputDir(db, "/tmp/shot-legacy-dims");
		assert.equal(row?.width, 800);
		assert.equal(row?.height, 600);
		db.close();
	});
});

test("getSnapshotByShortId: resolves known short_id, undefined for unknown", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		const shortId = insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-27T00:00:00.000Z",
			outputDir: "/tmp/shot-by-shortid",
			status: "completed",
		});

		const row = getSnapshotByShortId(db, shortId);
		assert.equal(row?.output_dir, "/tmp/shot-by-shortid");
		assert.equal(getSnapshotByShortId(db, "nonexistent"), undefined);
		db.close();
	});
});

test("updateSnapshotStatus transitions pending -> error", () => {
	withTempDb((dbPath) => {
		const db = openDb(dbPath);
		insertSnapshot(db, {
			url: "https://example.com",
			timestamp: "2026-07-22T00:00:00.000Z",
			outputDir: "/tmp/shot-3",
			status: "pending",
		});

		updateSnapshotStatus(db, "/tmp/shot-3", "error");

		const row = getSnapshotByOutputDir(db, "/tmp/shot-3");
		assert.equal(row?.status, "error");
		db.close();
	});
});

test("withDb closes the db when fn returns normally", () => {
	withTempDb((dbPath) => {
		let opened: DatabaseSync | undefined;
		const result = withDb(dbPath, (db) => {
			opened = db;
			return 42;
		});
		assert.equal(result, 42);
		assert.throws(() => opened?.prepare("SELECT 1"), /not open/);
	});
});

test("withDb still closes the db when fn throws (regression for a leaked connection when close() sat outside try/finally)", () => {
	withTempDb((dbPath) => {
		let opened: DatabaseSync | undefined;
		assert.throws(() => {
			withDb(dbPath, (db) => {
				opened = db;
				throw new Error("boom");
			});
		}, /boom/);
		assert.throws(() => opened?.prepare("SELECT 1"), /not open/);
	});
});
