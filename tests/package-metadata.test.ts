import assert from "node:assert/strict";
import { test } from "node:test";
import pkg from "../package.json" with { type: "json" };

test("package.json has homepage, bugs url, author object (no email), explicit files", () => {
	assert.equal(pkg.homepage, "https://github.com/gander-tools/sitediff");
	assert.equal(pkg.bugs.url, "https://github.com/gander-tools/sitediff/issues");
	assert.equal(pkg.author.name, "Adam Gąsowski");
	assert.equal(pkg.author.url, "https://github.com/gander");
	assert.equal((pkg.author as Record<string, unknown>).email, undefined);
	assert.equal((pkg.bugs as Record<string, unknown>).email, undefined);
	for (const entry of ["dist", "package.json", "LICENSE", "README.md"]) {
		assert.ok(pkg.files.includes(entry), `files missing ${entry}`);
	}
});
