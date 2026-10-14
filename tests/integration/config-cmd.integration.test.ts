import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { requireBin, runBinSync } from "./helpers.ts";

before(requireBin);

test("built dist/sitediff: bare config --json -> valid:true rows (exit 0) on a fresh config, valid:false row (exit 1) once corrupted", () => {
	const dir = mkdtempSync(
		join(tmpdir(), "sitediff-integration-config-validate-"),
	);
	try {
		const init = runBinSync(["config", "init"], dir);
		assert.equal(init.status, 0);

		const valid = runBinSync(["config", "--json"], dir);
		assert.equal(valid.status, 0);
		const validRows = JSON.parse(valid.stdout);
		assert.ok(validRows.every((r: { valid: boolean }) => r.valid === true));

		const configPath = join(dir, ".sitediff.json");
		const appConfig = JSON.parse(readFileSync(configPath, "utf8"));
		appConfig.collections = { mobile: "ghost" };
		writeFileSync(configPath, JSON.stringify(appConfig));

		const invalid = runBinSync(["config", "--json"], dir);
		assert.equal(invalid.status, 1);
		const invalidRows = JSON.parse(invalid.stdout);
		const badRow = invalidRows.find(
			(r: { field: string }) => r.field === "/collections/mobile",
		);
		assert.equal(badRow.valid, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: bare config table (no config file yet)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-config-show-"));
	try {
		const bare = runBinSync(["config"], dir);
		assert.equal(bare.status, 0);
		assert.match(bare.stdout, /outDir/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("built dist/sitediff: config init --force overwrites an existing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-config-init-"));
	try {
		assert.equal(runBinSync(["config", "init"], dir).status, 0);
		const configPath = join(dir, ".sitediff.json");
		writeFileSync(configPath, JSON.stringify({ outDir: "stale" }));

		const noForce = runBinSync(["config", "init"], dir);
		assert.notEqual(noForce.status, 0);

		const withForce = runBinSync(["config", "init", "--force"], dir);
		assert.equal(withForce.status, 0);
		const written = JSON.parse(readFileSync(configPath, "utf8"));
		assert.notEqual(written.outDir, "stale");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// subcommand --help renders a "Global Options" section listing
// options inherited from its parent Command chain (e.g. --config on every
// `config` subcommand) — previously invisible despite working.
test("built dist/sitediff: config init --help shows inherited --config option", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-integration-config-show-"));
	try {
		const result = runBinSync(["config", "init", "--help"], dir);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Global Options:/);
		assert.match(result.stdout, /--config <path>/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
