import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = () =>
	readFileSync(
		new URL("../.github/workflows/code.yml", import.meta.url),
		"utf8",
	);

test("code.yml installs chromium before running tests (guards against this ordering silently regressing)", () => {
	const yaml = workflow();
	const installIdx = yaml.indexOf("playwright install");
	const npmTestIdx = yaml.indexOf("npm test");

	assert.ok(installIdx !== -1, "expected a playwright install step");
	assert.ok(installIdx < npmTestIdx, "install step must run before npm test");
});

test("code.yml runs build then test:integration after npm test", () => {
	const yaml = workflow();
	const npmTestIdx = yaml.indexOf("npm test");
	const buildIdx = yaml.indexOf("npm run build");
	const integrationIdx = yaml.indexOf("npm run test:integration");

	assert.ok(buildIdx !== -1, "expected a build step");
	assert.ok(integrationIdx !== -1, "expected a test:integration step");
	assert.ok(npmTestIdx < buildIdx, "build step must run after npm test");
	assert.ok(
		buildIdx < integrationIdx,
		"test:integration step must run after the build step",
	);
});
