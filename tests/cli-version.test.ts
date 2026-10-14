import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		encoding: "utf8",
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status ?? 1,
	};
}

test("cli: --version prints only the version string, exit 0", () => {
	const result = runCli(["--version"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, `${pkg.version}\n`);
});

test("cli: -V prints only the version string, exit 0", () => {
	const result = runCli(["-V"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, `${pkg.version}\n`);
});

test("cli: no args, first line is 'sitediff <version>' above usage, exit 0", () => {
	const result = runCli([]);
	assert.equal(result.status, 0);
	const lines = result.stderr.split("\n");
	assert.equal(lines[0], `sitediff ${pkg.version}`);
	assert.match(result.stderr, /Usage: sitediff/);
});

test("cli: subcommand help is not prefixed with the version line", () => {
	const result = runCli(["capture", "--help"]);
	assert.equal(result.status, 0);
	assert.doesNotMatch(result.stdout, /^sitediff \d/);
});
