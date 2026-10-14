import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], cwd: string) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: "utf8",
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

test("cli: bare config --json prints a parseable rows array, not a table", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-config-json-"));
	try {
		const init = runCli(["config", "init"], dir);
		assert.equal(init.status, 0);

		const result = runCli(["config", "--json"], dir);
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		assert.ok(Array.isArray(rows));
		assert.ok(rows.some((row: { field: string }) => row.field === "/outDir"));
		assert.ok(rows.every((row: { valid: boolean }) => row.valid === true));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config --json w/ no config file on disk -> default rows, exit 0, no 'config file' source", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-config-json-"));
	try {
		const result = runCli(["config", "--json"], dir);
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		assert.ok(Array.isArray(rows));
		assert.ok(rows.some((row: { field: string }) => row.field === "/outDir"));
		assert.ok(rows.every((row: { valid: boolean }) => row.valid === true));
		assert.ok(
			!rows.some((row: { source: string }) => row.source === "config file"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config --json -> valid:false rows + exit 1 on a corrupted config (dangling collections.<name>.preset ref), errors NOT printed to stderr", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-config-json-"));
	try {
		const init = runCli(["config", "init"], dir);
		assert.equal(init.status, 0);

		const configPath = join(dir, ".sitediff.json");
		const appConfig = JSON.parse(readFileSync(configPath, "utf8"));
		appConfig.collections = { mobile: "ghost" };
		writeFileSync(configPath, JSON.stringify(appConfig));

		const result = runCli(["config", "--json"], dir);
		assert.equal(result.status, 1);
		const rows = JSON.parse(result.stdout);
		const presetRow = rows.find(
			(row: { field: string }) => row.field === "/collections/mobile",
		);
		assert.equal(presetRow.valid, false);
		assert.equal(result.stderr, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: config init on an existing file errors without --force, overwrites with --force", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-config-json-"));
	try {
		const first = runCli(["config", "init"], dir);
		assert.equal(first.status, 0);

		const configPath = join(dir, ".sitediff.json");
		writeFileSync(configPath, JSON.stringify({ outDir: "./stale" }));

		const noForce = runCli(["config", "init"], dir);
		assert.notEqual(noForce.status, 0);
		assert.equal(
			JSON.parse(readFileSync(configPath, "utf8")).outDir,
			"./stale",
		);

		const withForce = runCli(["config", "init", "--force"], dir);
		assert.equal(withForce.status, 0);
		assert.equal(
			JSON.parse(readFileSync(configPath, "utf8")).outDir,
			"./output",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
