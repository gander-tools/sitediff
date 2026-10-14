import assert from "node:assert/strict";
import { before, test } from "node:test";
import { requireBin, runBinSync } from "./helpers.ts";

before(requireBin);

// loose assertion only — exit 0 + non-empty stdout, ⊥ exact generated
// script syntax (lib pre-1.0, internals may shift between patches).
for (const shell of ["bash", "fish"] as const) {
	test(`built dist/sitediff: completion ${shell} -> exit 0, non-empty stdout`, () => {
		const result = runBinSync(["completion", shell]);
		assert.equal(result.status, 0);
		assert.ok(result.stdout.length > 0);
	});
}

// Bare `completion` is now an ordinary missing-arg case -> usage/help on
// stdout, no stderr msg, exit 1 (like every other command). Invalid shell
// value stays a true usage error (lib's own .choices() validation,
// unaffected).
test("built dist/sitediff: bare completion -> usage/help, exit 1, no stderr msg", () => {
	const result = runBinSync(["completion"]);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /Usage: sitediff completion/);
});

test("built dist/sitediff: completion xyz -> exit 1, unchanged", () => {
	const result = runBinSync(["completion", "xyz"]);
	assert.equal(result.status, 1);
});
