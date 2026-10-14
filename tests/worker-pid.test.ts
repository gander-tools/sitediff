import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearWorkerPid,
	readWorkerPid,
	writeWorkerPid,
} from "../src/worker-pid.ts";

function withTempDbPath<T>(fn: (dbPath: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-worker-pid-"));
	try {
		return fn(join(dir, "sitediff.sqlite"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("writeWorkerPid/readWorkerPid round-trip for a live pid (process.pid)", () => {
	withTempDbPath((dbPath) => {
		writeWorkerPid(dbPath, process.pid);
		assert.equal(readWorkerPid(dbPath), process.pid);
	});
});

test("readWorkerPid: no pidfile -> undefined", () => {
	withTempDbPath((dbPath) => {
		assert.equal(readWorkerPid(dbPath), undefined);
	});
});

test("readWorkerPid: dead pid -> undefined, stale pidfile deleted (cleanup)", () => {
	withTempDbPath((dbPath) => {
		// a pid extremely unlikely to be alive on any real system
		writeWorkerPid(dbPath, 999999);
		assert.equal(readWorkerPid(dbPath), undefined);
		assert.equal(existsSync(`${dbPath}.worker.pid`), false);
	});
});

test("clearWorkerPid removes the pidfile; no-op if absent", () => {
	withTempDbPath((dbPath) => {
		writeWorkerPid(dbPath, process.pid);
		clearWorkerPid(dbPath);
		assert.equal(existsSync(`${dbPath}.worker.pid`), false);
		assert.doesNotThrow(() => clearWorkerPid(dbPath));
	});
});

test("pidfile path is keyed off dbPath, not outDir — 2 configs sharing dbPath but different outDir collide onto the same pidfile", () => {
	withTempDbPath((dbPath) => {
		writeWorkerPid(dbPath, process.pid);
		// simulate a 2nd config w/ a different outDir but the same dbPath —
		// readWorkerPid only ever takes dbPath, so it must see the same worker.
		assert.equal(readWorkerPid(dbPath), process.pid);
	});
});

test("readWorkerPid: unparseable pidfile content -> undefined, deleted", () => {
	withTempDbPath((dbPath) => {
		writeFileSync(`${dbPath}.worker.pid`, "not-a-pid");
		assert.equal(readWorkerPid(dbPath), undefined);
		assert.equal(existsSync(`${dbPath}.worker.pid`), false);
	});
});
