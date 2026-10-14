import assert from "node:assert/strict";
import { before, test } from "node:test";
import pkg from "../../package.json" with { type: "json" };
import { requireBin, runBinSync } from "./helpers.ts";

before(requireBin);

test("built dist/sitediff: --version prints only the version string, exit 0", () => {
	const result = runBinSync(["--version"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, `${pkg.version}\n`);
});

test("built dist/sitediff: no args -> first stderr line is 'sitediff <version>', help printed", () => {
	const result = runBinSync([]);
	const lines = result.stderr.split("\n");
	assert.equal(lines[0], `sitediff ${pkg.version}`);
	assert.match(result.stderr, /Usage: sitediff/);
});
