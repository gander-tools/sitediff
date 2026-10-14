import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	type LocalServer,
	requireBin,
	runBin,
	startLocalServer,
	stopLocalServer,
} from "./helpers.ts";

let local: LocalServer;

before(async () => {
	requireBin();
	local = await startLocalServer();
});

after(async () => {
	await stopLocalServer(local.server);
});

// ⊥ viewport CLI flag/env — the only override left is a config
// file, cwd-discovered since `cwd` IS the capture's own --config-less lookup
// root.
async function capture(
	url: string,
	cwd: string,
	configOverrides?: Record<string, unknown>,
) {
	if (configOverrides) {
		writeFileSync(
			join(cwd, ".sitediff.json"),
			JSON.stringify({ config: configOverrides }),
		);
	}
	const stdout = await runBin(["capture", url, "--json"], cwd);
	return JSON.parse(stdout) as { id: string; status: string };
}

test("built dist/sitediff: diff <A> <B> --json -> both output files produced, sectioned report, no urlMismatch for same URL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-diff-"));
	try {
		const a = await capture(`${local.baseUrl}/`, dir);
		const b = await capture(`${local.baseUrl}/`, dir);
		assert.equal(a.status, "completed");
		assert.equal(b.status, "completed");

		const stdout = await runBin(["diff", a.id, b.id, "--json"], dir);
		// outDir resolves to DEFAULT_CONFIG.outDir ("./output") here — ⊥
		// .sitediff.json's outDir field set by this test's `capture` helper.
		assert.match(
			stdout,
			new RegExp(`wrote output/diff-${a.id}-${b.id}\\.json`),
		);
		assert.match(stdout, new RegExp(`wrote output/diff-${a.id}-${b.id}\\.png`));
		assert.ok(existsSync(join(dir, "output", `diff-${a.id}-${b.id}.json`)));
		assert.ok(existsSync(join(dir, "output", `diff-${a.id}-${b.id}.png`)));

		const jsonLine = stdout.split("\n").find((line) => line.startsWith("{"));
		const report = JSON.parse(jsonLine ?? "{}");
		assert.ok(report.dom);
		assert.ok(report.harResources);
		assert.ok(report.console);
		assert.ok(report.redirects);
		assert.ok(report.screenshot);
		assert.equal(report.urlMismatch, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: diff refuses the whole comparison when either side isn't completed", async () => {
	const dir = mkdtempSync(
		join(tmpdir(), "sitediff-integration-diff-incompat-"),
	);
	try {
		const completed = await capture(`${local.baseUrl}/`, dir);
		const queuedStdout = await runBin(
			["capture", `${local.baseUrl}/`, "--enqueue", "--json"],
			dir,
		);
		const queued = JSON.parse(queuedStdout) as { id: string; status: string };
		assert.equal(queued.status, "queued");

		await assert.rejects(
			runBin(["diff", completed.id, queued.id], dir),
			/snapshot incomplete/,
		);
		assert.ok(
			!existsSync(join(dir, `diff-${completed.id}-${queued.id}.json`)),
			"an incompatible pair must not write any diff output",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: diff drops only the screenshot section on a viewport-dims mismatch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-diff-dims-"));
	try {
		const a = await capture(`${local.baseUrl}/`, dir, {
			viewport: { width: 800, height: 600 },
		});
		const b = await capture(`${local.baseUrl}/`, dir, {
			viewport: { width: 400, height: 300 },
		});
		assert.equal(a.status, "completed");
		assert.equal(b.status, "completed");

		const stdout = await runBin(["diff", a.id, b.id, "--json"], dir);
		const jsonLine = stdout.split("\n").find((line) => line.startsWith("{"));
		const report = JSON.parse(jsonLine ?? "{}");
		assert.equal(report.screenshot, undefined);
		assert.ok(report.dom);
		assert.ok(report.harResources);
		assert.ok(report.console);
		assert.ok(report.redirects);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
