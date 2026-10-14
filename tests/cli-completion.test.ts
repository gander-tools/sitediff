import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertSnapshot, openDb } from "../src/db.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// completion ⊥ takes a --config/env override — dbPath + config
// file lookup both resolve relative to cwd, so every fixture spawns w/ cwd
// pointed @ the temp dir instead of threading env vars.
function complete(args: string[], cwd: string) {
	return spawnSync(process.execPath, [cliPath, "complete", "--", ...args], {
		encoding: "utf8",
		cwd,
	});
}

function descriptionFor(stdout: string, shortId: string): string {
	const line = stdout.split("\n").find((l) => l.startsWith(`${shortId}\t`));
	assert.ok(line, `no completion line for ${shortId} in:\n${stdout}`);
	return line.slice(shortId.length + 1);
}

// stats/diff positional shortId args suggest real short_id values.
test("cli: complete -- stats <TAB> suggests existing short_id", () => {
	const dir = mktempDb();
	try {
		const db = openDb(dir.dbPath);
		const shortId = insertSnapshot(db, {
			url: "https://example.com/",
			timestamp: "2026-07-31T00:00:00.000Z",
			outputDir: dir.dbPath,
			status: "completed",
		});
		db.close();

		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.match(result.stdout, new RegExp(`^${shortId}\\t`, "m"));
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

test("cli: complete -- diff <TAB> suggests existing short_id for both positions", () => {
	const dir = mktempDb();
	try {
		const db = openDb(dir.dbPath);
		const shortId = insertSnapshot(db, {
			url: "https://example.com/",
			timestamp: "2026-07-31T00:00:00.000Z",
			outputDir: dir.dbPath,
			status: "completed",
		});
		db.close();

		for (const args of [
			["diff", ""],
			["diff", shortId, ""],
		]) {
			const result = complete(args, dir.dir);
			assert.equal(result.status, 0);
			assert.match(result.stdout, new RegExp(`^${shortId}\\t`, "m"));
		}
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

// missing/unreadable db -> empty completions, never a thrown error to
// the shell (exit 0, no stderr).
test("cli: complete -- stats <TAB> with missing db -> empty completions, exit 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-completion-"));
	try {
		const result = complete(["stats", ""], dir);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, "");
		assert.doesNotMatch(result.stdout, /\t/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function mktempDb(): { dir: string; dbPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-completion-"));
	return { dir, dbPath: join(dir, "sitediff.sqlite") };
}

function seedSnapshot(dbPath: string, url: string): string {
	const db = openDb(dbPath);
	const shortId = insertSnapshot(db, {
		url,
		timestamp: "2026-07-31T00:00:00.000Z",
		outputDir: dbPath,
		status: "completed",
	});
	db.close();
	return shortId;
}

// default template is "%host%" — no config file needed.
test("cli: no config -> completion description defaults to host", () => {
	const dir = mktempDb();
	try {
		const shortId = seedSnapshot(dir.dbPath, "https://example.com/a");
		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.equal(descriptionFor(result.stdout, shortId), "example.com");
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

// completion.descriptionTemplate from config file is honored,
// substituting known placeholders from the same row as the shortId.
test("cli: custom completion.descriptionTemplate is applied", () => {
	const dir = mktempDb();
	try {
		const shortId = seedSnapshot(dir.dbPath, "https://example.com/a/b");
		writeFileSync(
			join(dir.dir, ".sitediff.json"),
			JSON.stringify({ completion: { descriptionTemplate: "%host%%path%" } }),
		);

		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.equal(descriptionFor(result.stdout, shortId), "example.com/a/b");
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

// a non-string descriptionTemplate value (wrong JSON type) falls back
// to the default, same as a missing/unreadable config.
test("cli: non-string completion.descriptionTemplate -> falls back to default", () => {
	const dir = mktempDb();
	try {
		const shortId = seedSnapshot(dir.dbPath, "https://example.com/a");
		writeFileSync(
			join(dir.dir, ".sitediff.json"),
			JSON.stringify({ completion: { descriptionTemplate: 42 } }),
		);

		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.equal(descriptionFor(result.stdout, shortId), "example.com");
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

// unknown placeholder token stays literal; NULL underlying value (no
// collection set) -> "".
test("cli: unknown placeholder passthrough, NULL field -> empty", () => {
	const dir = mktempDb();
	try {
		const shortId = seedSnapshot(dir.dbPath, "https://example.com/a");
		writeFileSync(
			join(dir.dir, ".sitediff.json"),
			JSON.stringify({
				completion: { descriptionTemplate: "%nope% [%collection%]" },
			}),
		);

		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.equal(descriptionFor(result.stdout, shortId), "%nope% []");
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});

// a path segment containing literal `%host%`-shaped text must not be
// re-substituted once it lands in the output (single-pass substitution).
test("cli: literal placeholder-shaped text in url path is not re-substituted", () => {
	const dir = mktempDb();
	try {
		const shortId = seedSnapshot(
			dir.dbPath,
			"https://example.com/%host%-promo",
		);
		writeFileSync(
			join(dir.dir, ".sitediff.json"),
			JSON.stringify({ completion: { descriptionTemplate: "%path% %host%" } }),
		);

		const result = complete(["stats", ""], dir.dir);
		assert.equal(result.status, 0);
		assert.equal(
			descriptionFor(result.stdout, shortId),
			"/%host%-promo example.com",
		);
	} finally {
		rmSync(dir.dir, { recursive: true, force: true });
	}
});
