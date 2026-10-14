import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("release-it config publishes to npm and releases to GitHub with the packed tarball asset", () => {
	const config = JSON.parse(
		readFileSync(new URL("../.release-it.json", import.meta.url), "utf8"),
	);
	assert.equal(config.npm.publish, true);
	assert.equal(config.github.release, true);
	assert.ok(config.github.assets.includes("*.tgz"));
	assert.match(config.hooks["after:bump"], /npm pack/);
	assert.deepEqual(config.npm.publishArgs, []);
});

test("release-it regenerates CHANGELOG.md via git-cliff after bump and feeds it into the GitHub release notes", () => {
	const config = JSON.parse(
		readFileSync(new URL("../.release-it.json", import.meta.url), "utf8"),
	);
	assert.match(
		config.hooks["after:bump"],
		/npx git-cliff --tag v\$\{version} -o CHANGELOG\.md/,
	);
	assert.match(
		config.github.releaseNotes,
		/npx git-cliff --unreleased --tag \$\{version} --strip header -o -/,
	);
});

test("release workflow publishes to the public npm registry with the auth token secret for npm publish", () => {
	const yaml = readFileSync(
		new URL("../.github/workflows/release.yml", import.meta.url),
		"utf8",
	);
	assert.match(yaml, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
	assert.match(yaml, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*}}/);
});

test("publish job requests id-token write and the package enables npm provenance", () => {
	const yaml = readFileSync(
		new URL("../.github/workflows/release.yml", import.meta.url),
		"utf8",
	);
	const publishJob = yaml.slice(yaml.indexOf("\n  publish:"));
	assert.match(publishJob, /id-token:\s*write/);
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(pkg.publishConfig.provenance, true);
	assert.match(publishJob, /if:\s*github\.ref == 'refs\/heads\/main'/);
});

test("release workflow only points npm at the registry right before publish, not during npm ci", () => {
	const yaml = readFileSync(
		new URL("../.github/workflows/release.yml", import.meta.url),
		"utf8",
	);
	const ciIndex = yaml.indexOf("run: npm ci");
	const registryIndex = yaml.indexOf("registry-url:");
	assert.ok(ciIndex > 0 && registryIndex > 0);
	assert.ok(
		registryIndex > ciIndex,
		"registry-url must be configured after npm ci to avoid 401ing the install",
	);
});

test("release workflow is manually triggered only, with a patch-default bump dropdown", () => {
	const yaml = readFileSync(
		new URL("../.github/workflows/release.yml", import.meta.url),
		"utf8",
	);
	const on = yaml.slice(yaml.indexOf("\non:"), yaml.indexOf("\njobs:"));
	assert.match(on, /workflow_dispatch:/);
	assert.doesNotMatch(on, /\n\s*push:/);
	assert.doesNotMatch(on, /\n\s*schedule:/);
	assert.match(on, /default:\s*patch/);
	assert.match(yaml, /test -f dist\/sitediff/);
	assert.match(yaml, /node dist\/sitediff --version/);
});
