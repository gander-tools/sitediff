import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	DEFAULT_WORKER_CONFIG,
	extractCollectionPreset,
	extractFilePreset,
	mergeConfig,
	partialAppConfigSchema,
	resolveAppConfig,
	resolveCaptureConfig,
	resolvePresetByName,
} from "../src/config.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "sitediff-config-"));
}

// resolveAppConfig — the sole fetch+parse point. Discovery/error-path
// behavior needs a real file on disk to exercise. ⊥ env fallback anymore
// — --config opt or cwd-discovery only.

test("resolveAppConfig: --config path missing -> throws", async () => {
	const dir = tempDir();
	try {
		await assert.rejects(() => resolveAppConfig(join(dir, "nope.json")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: top-level wwwEquivalent accepted, resolved verbatim", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ wwwEquivalent: false }),
		);
		const appConfig = await resolveAppConfig(dir);
		assert.equal(appConfig?.wwwEquivalent, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: dir w/ .json -> resolves it", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ outDir: "from-json" }),
		);
		const appConfig = await resolveAppConfig(dir);
		assert.equal(appConfig?.outDir, "from-json");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: stale .sitediff.ts on disk -> falls thru to no-config-found", async () => {
	const dir = tempDir();
	const originalCwd = process.cwd();
	process.chdir(dir);
	try {
		writeFileSync(
			join(dir, ".sitediff.ts"),
			`export default { outDir: "from-ts" };\n`,
		);
		const appConfig = await resolveAppConfig(undefined);
		assert.equal(appConfig, undefined);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: invalid content -> throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ config: { navTimeoutMs: "not-a-number" } }),
		);
		await assert.rejects(() => resolveAppConfig(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: empty dir, no --config -> undefined, no error", async () => {
	const dir = tempDir();
	const originalCwd = process.cwd();
	process.chdir(dir);
	try {
		const appConfig = await resolveAppConfig(undefined);
		assert.equal(appConfig, undefined);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: unsupported extension -> throws", async () => {
	const dir = tempDir();
	try {
		const yamlPath = join(dir, "config.yaml");
		writeFileSync(yamlPath, "outDir: nope\n");
		await assert.rejects(() => resolveAppConfig(yamlPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: partial viewport (width only) under config parses OK, height left unset (defaulting deferred to mergeConfig)", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ config: { viewport: { width: 1200 } } }),
		);
		const appConfig = await resolveAppConfig(dir);
		assert.deepEqual(appConfig?.config?.viewport, { width: 1200 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: unrecognized key inside config.viewport throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ config: { viewport: { width: 1200, bogus: 1 } } }),
		);
		await assert.rejects(() => resolveAppConfig(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: top-level unrecognized key still throws (890b364 regression guard)", async () => {
	const dir = tempDir();
	try {
		writeFileSync(join(dir, ".sitediff.json"), JSON.stringify({ nope: true }));
		await assert.rejects(() => resolveAppConfig(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// headless left the schema entirely — a pre-2026-07-25 config
// file carrying the field now hard-fails, intentionally
test("resolveAppConfig: legacy top-level 'headless' key throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ headless: true }),
		);
		await assert.rejects(
			() => resolveAppConfig(dir),
			/Unrecognized key.*headless/s,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// collections{} value = bare presetName string — a non-string value
// (e.g. the old {preset,config} object shape) fails schema validation now.
test("resolveAppConfig: legacy collections.<name> object shape throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				collections: { mobile: { preset: "mobile-preset" } },
			}),
		);
		await assert.rejects(() => resolveAppConfig(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: legacy 'headless' key inside presets.<name> throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				presets: { "mobile-preset": { headless: true } },
			}),
		);
		await assert.rejects(
			() => resolveAppConfig(dir),
			/Unrecognized key.*headless/s,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAppConfig: preset config w/ only 1 field parses OK, no zod throw", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				presets: { "solo-field": { navTimeoutMs: 5000 } },
			}),
		);
		const appConfig = await resolveAppConfig(dir);
		const preset = resolvePresetByName(appConfig?.presets, "solo-field");
		assert.deepEqual(preset, { navTimeoutMs: 5000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// extractFilePreset — pure derivation, literal AppConfig objects, no file I/O.
// outDir/dbPath come from the top level, the rest from the nested `config`
// key — collections/presets/completion/worker never leak into it.

test("extractFilePreset: pulls outDir from top level + fields from nested config", () => {
	const preset = extractFilePreset({
		outDir: "x",
		config: { navTimeoutMs: 5000 },
		collections: { a: "some-preset" },
	});
	assert.equal(preset?.outDir, "x");
	assert.equal(preset?.navTimeoutMs, 5000);
	assert.equal((preset as Record<string, unknown>).collections, undefined);
});

test("extractFilePreset: strips presets/completion/worker from returned preset (leak regression)", () => {
	const preset = extractFilePreset({
		outDir: "x",
		presets: { p1: { outDir: "y" } },
		completion: { descriptionTemplate: "%host%" },
		worker: { autostart: false },
	});
	assert.equal((preset as Record<string, unknown>).presets, undefined);
	assert.equal((preset as Record<string, unknown>).completion, undefined);
	assert.equal((preset as Record<string, unknown>).worker, undefined);
	assert.equal(preset?.outDir, "x");
});

test("extractFilePreset: undefined appConfig -> undefined", () => {
	assert.equal(extractFilePreset(undefined), undefined);
});

// extractCollectionPreset — pure derivation, literal AppConfig objects.
// collections{} value = bare presetName string.

test("extractCollectionPreset: matching collection returns its preset", () => {
	const preset = extractCollectionPreset(
		{
			presets: {
				"mobile-preset": { viewport: { width: 375, height: 667 } },
			},
			collections: { mobile: "mobile-preset" },
		},
		"mobile",
	);
	assert.deepEqual(preset.viewport, { width: 375, height: 667 });
});

test("extractCollectionPreset: dangling preset name-ref throws", () => {
	assert.throws(() =>
		extractCollectionPreset({ collections: { mobile: "ghost" } }, "mobile"),
	);
});

test("extractCollectionPreset: unknown collection name throws", () => {
	assert.throws(() =>
		extractCollectionPreset({ collections: { a: "x" } }, "b"),
	);
});

test("extractCollectionPreset: no appConfig at all -> throws", () => {
	assert.throws(() => extractCollectionPreset(undefined, "any"));
});

// resolvePresetByName — already pure, literal presets records

test("resolvePresetByName: matching preset returns its config", () => {
	const preset = resolvePresetByName(
		{ "mobile-preset": { viewport: { width: 375, height: 667 } } },
		"mobile-preset",
	);
	assert.deepEqual(preset.viewport, { width: 375, height: 667 });
});

test("resolvePresetByName: dangling preset name throws", () => {
	assert.throws(() => resolvePresetByName({}, "ghost"));
});

// merge precedence — combines the pure derivations, some fed by a real file
// to prove discovery + extraction compose correctly end-to-end. ⊥ env layer
// anymore — DEFAULT_CONFIG is the cascade's base directly.

test("merge precedence: CLI overrides > config file > DEFAULT_CONFIG", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				dbPath: "from-file.sqlite",
				config: { navTimeoutMs: 1234 },
			}),
		);
		const overrides = { navTimeoutMs: 999 };

		const appConfig = await resolveAppConfig(dir);
		const fileConfig = extractFilePreset(appConfig);
		const merged = mergeConfig(DEFAULT_CONFIG, fileConfig, overrides);

		assert.equal(merged.dbPath, "from-file.sqlite"); // config file beats default
		assert.equal(merged.outDir, DEFAULT_CONFIG.outDir); // file didn't set it -> default
		assert.equal(merged.navTimeoutMs, 999); // CLI override beats config file
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// resolveCaptureConfig — hides fetch+extraction+merge+meta-building+worker
// resolution behind 1 call. ⊥ envConfig/env params anymore.

test("resolveCaptureConfig: CLI overrides > collection preset > config file, meta records collection, worker resolved from DEFAULT_WORKER_CONFIG", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				config: { navTimeoutMs: 1111 },
				presets: {
					"mobile-preset": {
						sessionPath: "mobile-session",
						navTimeoutMs: 2222,
					},
				},
				collections: { mobile: "mobile-preset" },
			}),
		);
		const { config, meta, worker } = await resolveCaptureConfig(dir, {
			collectionName: "mobile",
			overrides: { navTimeoutMs: 999 },
		});

		assert.equal(config.navTimeoutMs, 999); // CLI override wins
		assert.equal(config.sessionPath, "mobile-session"); // collection wins over file default
		assert.deepEqual(meta.collection, {
			name: "mobile",
			config: { sessionPath: "mobile-session", navTimeoutMs: 2222 },
		});
		assert.equal(meta.preset, undefined);
		assert.deepEqual(worker, DEFAULT_WORKER_CONFIG);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveCaptureConfig: no collection/preset given -> meta is {}", async () => {
	const { config, meta } = await resolveCaptureConfig(undefined);
	assert.deepEqual(meta, {});
	assert.equal(config.outDir, "./output");
});

test("resolveCaptureConfig: worker resolved from appConfig top-level, overriding DEFAULT_WORKER_CONFIG per-field", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ worker: { timeout: 5000 } }),
		);
		const { worker } = await resolveCaptureConfig(dir);
		assert.deepEqual(worker, { autostart: true, timeout: 5000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("merge precedence w/ collection: CLI > collection preset > appConfig-level preset > DEFAULT_CONFIG", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				config: { navTimeoutMs: 1111 },
				presets: {
					"mobile-preset": {
						sessionPath: "mobile-session",
						navTimeoutMs: 2222,
					},
				},
				collections: { mobile: "mobile-preset" },
			}),
		);
		const overrides = { navTimeoutMs: 999 };

		const appConfig = await resolveAppConfig(dir);
		const fileConfig = extractFilePreset(appConfig);
		const collectionOverride = extractCollectionPreset(appConfig, "mobile");
		const merged = mergeConfig(
			DEFAULT_CONFIG,
			fileConfig,
			collectionOverride,
			overrides,
		);

		assert.equal(merged.navTimeoutMs, 999); // CLI override wins
		assert.equal(merged.sessionPath, "mobile-session"); // collection wins over appConfig-level/default
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("merge precedence: --preset wins over --collection preset", () => {
	const appConfig = {
		presets: {
			"collection-preset": { outDir: "collection-out" },
			"top-preset": { outDir: "top-out" },
		},
		collections: { mobile: "collection-preset" },
	};
	const collectionOverride = extractCollectionPreset(appConfig, "mobile");
	const presetOverride = resolvePresetByName(appConfig.presets, "top-preset");
	const merged = mergeConfig(
		DEFAULT_CONFIG,
		collectionOverride,
		presetOverride,
	);
	assert.equal(merged.outDir, "top-out"); // --preset beats --collection preset
});

test("mergeConfig: viewport merges sub-field-wise, cumulative across 3+ args", () => {
	const merged = mergeConfig(
		{ viewport: { width: 1920, height: 1080 } },
		{ viewport: { height: 600 } }, // omits width -> keeps prior arg's width
		{ viewport: { width: 800 } }, // omits height -> keeps prior arg's height
	);
	assert.deepEqual(merged.viewport, { width: 800, height: 600 });
});

test("mergeConfig: array fields stay atomic, whole array replaced not merged", () => {
	const merged = mergeConfig(
		{ hideSelectors: ["a", "b"] },
		{ hideSelectors: ["c"] },
	);
	assert.deepEqual(merged.hideSelectors, ["c"]);
});

test("mergeConfig: scalar fields are last-wins, undefined args skipped", () => {
	const merged = mergeConfig({ outDir: "a" }, undefined, { outDir: "b" });
	assert.equal(merged.outDir, "b");
});

test("worker.timeout schema: rejects values < -1", () => {
	const result = partialAppConfigSchema.safeParse({
		worker: { timeout: -2, autostart: true },
	});
	assert.equal(result.success, false);
});

test("worker.timeout schema: accepts -1 (no idle-limit sentinel) and 0", () => {
	assert.equal(
		partialAppConfigSchema.safeParse({ worker: { timeout: -1 } }).success,
		true,
	);
	assert.equal(
		partialAppConfigSchema.safeParse({ worker: { timeout: 0 } }).success,
		true,
	);
});

test("full cascade: preset sets viewport.width only, appConfig-level config sets viewport.height only -> both honored", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				config: { viewport: { height: 600 } },
				presets: { narrow: { viewport: { width: 800 } } },
			}),
		);
		const appConfig = await resolveAppConfig(dir);
		const fileConfig = extractFilePreset(appConfig);
		const presetOverride = resolvePresetByName(appConfig?.presets, "narrow");
		const merged = mergeConfig(DEFAULT_CONFIG, fileConfig, presetOverride);
		assert.deepEqual(merged.viewport, { width: 800, height: 600 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
