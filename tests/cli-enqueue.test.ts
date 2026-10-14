import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(
	args: string[],
	cwd: string,
	input?: string,
): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		encoding: "utf8",
		cwd,
		input,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

// list/stats/diff/worker ⊥ take a --config override — dbPath/outDir
// always resolve relative to cwd via DEFAULT_CONFIG, so every subprocess in
// this file runs w/ cwd pointed @ a fresh temp dir (naturally isolates each
// test's db/output without threading any env var). worker.autostart:false —
// most of these tests don't exercise worker behavior at all; the (unrelated)
// default autostart would otherwise spawn a real detached worker against a
// dbPath these tests delete right after asserting, racing the worker's own
// startup. The 1 test that does want a worker (`--worker` flag) forces
// ensureWorkerRunning directly regardless of this config, so it's unaffected.
function isolatedDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-enqueue-"));
	writeFileSync(
		join(dir, ".sitediff.json"),
		JSON.stringify({ worker: { autostart: false, timeout: 30000 } }),
	);
	return dir;
}

function queuedUrls(dir: string): string[] {
	const result = runCli(["list", "--status", "queued", "--json"], dir);
	assert.equal(result.status, 0);
	return (JSON.parse(result.stdout) as { url: string }[]).map((r) => r.url);
}

test("cli: enqueue <file> -> inserts 1 queued row per non-blank line, prints count, exit 0", () => {
	const dir = isolatedDir();
	try {
		const file = join(dir, "urls.txt");
		writeFileSync(
			file,
			"https://a.example.com/\n\nhttps://b.example.com/\n\nhttps://c.example.com/\n",
		);

		const result = runCli(["enqueue", file], dir);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), "enqueued 3 url(s)");

		const urls = queuedUrls(dir).sort();
		assert.deepEqual(urls, [
			"https://a.example.com/",
			"https://b.example.com/",
			"https://c.example.com/",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue (no file arg) reads stdin", () => {
	const dir = isolatedDir();
	try {
		const result = runCli(
			["enqueue"],
			dir,
			"https://a.example.com/\nhttps://b.example.com/\n",
		);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), "enqueued 2 url(s)");
		assert.equal(queuedUrls(dir).length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue <file> w/ CRLF line endings -> urls have no trailing \\r", () => {
	const dir = isolatedDir();
	try {
		const file = join(dir, "urls.txt");
		writeFileSync(file, "https://a.example.com/\r\nhttps://b.example.com/\r\n");

		const result = runCli(["enqueue", file], dir);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), "enqueued 2 url(s)");

		const urls = queuedUrls(dir);
		for (const url of urls)
			assert.ok(!url.includes("\r"), `url has \\r: ${url}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue <file> w/ empty file -> enqueued 0 url(s), exit 0, ⊥ error", () => {
	const dir = isolatedDir();
	try {
		const file = join(dir, "urls.txt");
		writeFileSync(file, "");

		const result = runCli(["enqueue", file], dir);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), "enqueued 0 url(s)");
		assert.equal(result.stderr, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue <file> --collection <unknown> -> fail-fast, exit 1, 0 rows inserted", () => {
	const dir = isolatedDir();
	try {
		const file = join(dir, "urls.txt");
		writeFileSync(
			file,
			"https://a.example.com/\nhttps://b.example.com/\nhttps://c.example.com/\n",
		);

		const result = runCli(
			["enqueue", file, "--collection", "does-not-exist"],
			dir,
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /--collection not found: does-not-exist/);
		assert.equal(queuedUrls(dir).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue <file> --worker -> auto-starts a worker (ensureWorkerRunning called once, not per-line)", async () => {
	const dir = isolatedDir();
	try {
		const file = join(dir, "urls.txt");
		writeFileSync(file, "https://a.example.com/\nhttps://b.example.com/\n");

		const preStatus = runCli(["worker", "status", "--json"], dir);
		assert.equal(JSON.parse(preStatus.stdout).pid, undefined);

		const result = runCli(["enqueue", file, "--worker"], dir);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), "enqueued 2 url(s)");

		const start = Date.now();
		let running = false;
		while (Date.now() - start < 10000) {
			const status = JSON.parse(
				runCli(["worker", "status", "--json"], dir).stdout,
			);
			if (status.pid !== undefined) {
				running = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(running, "worker never started after enqueue --worker");
	} finally {
		runCli(["worker", "stop"], dir);
		rmSync(dir, { recursive: true, force: true });
	}
});
