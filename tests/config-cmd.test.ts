import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, DEFAULT_WORKER_CONFIG } from "../src/config.ts";
import {
	buildConfigTreeRows,
	buildTableRows,
	initConfigFile,
	resolveConfigCmdRaw,
	resolveConfigWithSources,
} from "../src/config-cmd.ts";

function toExtras(completion?: { value: string; source: string }) {
	if (!completion) return [];
	return [
		{
			field: "/completion/descriptionTemplate",
			value: completion.value,
			source: completion.source,
		},
	];
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "sitediff-config-cmd-"));
}

// --- resolveConfigWithSources ---
// no env param anymore — source collapses to default|config file.

test("resolveConfigWithSources: no file config -> table = defaults only", () => {
	const { config, sources } = resolveConfigWithSources(undefined);
	assert.deepEqual(config, DEFAULT_CONFIG);
	for (const source of Object.values(sources)) {
		assert.equal(source, "default");
	}
});

test("resolveConfigWithSources: config file field marked source=config file, rest default", () => {
	const { config, sources } = resolveConfigWithSources({ outDir: "from-file" });
	assert.equal(config.outDir, "from-file");
	assert.equal(sources.outDir, "config file");
	assert.equal(sources.dbPath, "default");
});

test("resolveConfigWithSources: strips presets/collections/worker from effective config (leak regression)", () => {
	const { config } = resolveConfigWithSources({
		presets: { p1: { outDir: "x" } },
		collections: { c1: "p1" },
		worker: { autostart: false },
	});
	assert.equal((config as Record<string, unknown>).presets, undefined);
	assert.equal((config as Record<string, unknown>).collections, undefined);
	assert.equal((config as Record<string, unknown>).worker, undefined);
});

test("resolveConfigWithSources: partial viewport (height only) under config merges w/ DEFAULT_CONFIG viewport, not clobbered", () => {
	const { config } = resolveConfigWithSources({
		config: { viewport: { height: 600 } },
	});
	assert.deepEqual(config.viewport, {
		width: DEFAULT_CONFIG.viewport.width,
		height: 600,
	});
});

test("resolveConfigWithSources: return value has no headless key", () => {
	const result = resolveConfigWithSources(undefined);
	assert.ok(!("headless" in result));
});

test("resolveConfigWithSources: completion row source=config file when set, default otherwise", () => {
	const { completion } = resolveConfigWithSources({
		completion: { descriptionTemplate: "%path%" },
	});
	assert.deepEqual(completion, { value: "%path%", source: "config file" });

	const { completion: defaultCompletion } = resolveConfigWithSources(undefined);
	assert.deepEqual(defaultCompletion, { value: "%host%", source: "default" });
});

test("resolveConfigWithSources: worker row source=config file when set, default otherwise", () => {
	const { worker } = resolveConfigWithSources({
		worker: { timeout: 5000 },
	});
	assert.deepEqual(worker, {
		value: { autostart: true, timeout: 5000 },
		source: "config file",
	});

	const { worker: defaultWorker } = resolveConfigWithSources(undefined);
	assert.deepEqual(defaultWorker, {
		value: DEFAULT_WORKER_CONFIG,
		source: "default",
	});
});

test("resolveConfigWithSources: wwwEquivalent row source=config file when set, default (true) otherwise", () => {
	const { wwwEquivalent } = resolveConfigWithSources({
		wwwEquivalent: false,
	});
	assert.deepEqual(wwwEquivalent, { value: false, source: "config file" });

	const { wwwEquivalent: defaultWwwEquivalent } =
		resolveConfigWithSources(undefined);
	assert.deepEqual(defaultWwwEquivalent, { value: true, source: "default" });
});

// --- buildTableRows ---

test("buildTableRows: source is plain text, no ANSI escape codes", () => {
	const { config, sources, completion } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, toExtras(completion));
	assert.ok(rows.length > 0);
	for (const row of rows) {
		// biome-ignore lint: control-char regex intentional for ANSI detection
		assert.doesNotMatch(row.source, /\x1b\[/);
	}
});

test("buildTableRows: completion field never leaks as a bare 'completion' row", () => {
	const { config, sources, completion } = resolveConfigWithSources({
		outDir: "./output",
		completion: { descriptionTemplate: "%host%%path%" },
	});
	assert.equal((config as Record<string, unknown>).completion, undefined);
	const rows = buildTableRows(config, sources, toExtras(completion));
	assert.ok(!rows.some((r) => r.field === "/completion"));
	for (const row of rows) {
		assert.ok(
			["default", "config file"].includes(row.source),
			`row ${row.field} has unresolvable source: ${row.source}`,
		);
	}
});

test("buildTableRows: headless row absent — display removed entirely", () => {
	const { config, sources, completion } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, toExtras(completion));
	assert.ok(!rows.some((r) => r.field === "headless"));
});

test("buildTableRows: includes /completion/descriptionTemplate row", () => {
	const { config, sources, completion } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, toExtras(completion));
	const row = rows.find((r) => r.field === "/completion/descriptionTemplate");
	assert.equal(row?.value, "%host%");
	assert.equal(row?.source, "default");
});

test("buildTableRows: viewport flattens to JSON Pointer rows, not JSON.stringify", () => {
	const { config, sources } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, []);
	assert.ok(!rows.some((r) => r.field === "/config/viewport"));
	const width = rows.find((r) => r.field === "/config/viewport/width");
	const height = rows.find((r) => r.field === "/config/viewport/height");
	assert.equal(width?.value, String(DEFAULT_CONFIG.viewport.width));
	assert.equal(height?.value, String(DEFAULT_CONFIG.viewport.height));
	assert.equal(width?.source, sources.viewport);
	assert.equal(height?.source, sources.viewport);
});

test("buildTableRows: outDir/dbPath render @ pointer root, not under /config", () => {
	const { config, sources } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, []);
	assert.equal(rows.find((r) => r.field === "/outDir")?.value, config.outDir);
	assert.equal(rows.find((r) => r.field === "/dbPath")?.value, config.dbPath);
	assert.ok(!rows.some((r) => r.field === "/config/outDir"));
	assert.ok(!rows.some((r) => r.field === "/config/dbPath"));
});

test("buildTableRows: worker is NOT among the flattened BaseConfig rows (moved app-level only)", () => {
	const { config, sources } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, []);
	assert.ok(!rows.some((r) => r.field.startsWith("/worker")));
});

test("buildTableRows: empty array field -> single row w/ value '-' @ its own pointer", () => {
	const { config, sources } = resolveConfigWithSources(undefined);
	const rows = buildTableRows(config, sources, []);
	const row = rows.find((r) => r.field === "/config/maskSelectors");
	assert.equal(row?.value, "-");
	assert.ok(!rows.some((r) => r.field === "/config/maskSelectors/0"));
});

test("buildTableRows: non-empty array field -> 1 row/element, index as path segment not bracket", () => {
	const { config, sources } = resolveConfigWithSources({
		config: { maskSelectors: ["css=.a", "css=.b"] },
	});
	const rows = buildTableRows(config, sources, []);
	assert.ok(!rows.some((r) => r.field === "/config/maskSelectors"));
	assert.equal(
		rows.find((r) => r.field === "/config/maskSelectors/0")?.value,
		"css=.a",
	);
	assert.equal(
		rows.find((r) => r.field === "/config/maskSelectors/1")?.value,
		"css=.b",
	);
});

// --- resolveConfigCmdRaw ---

test("resolveConfigCmdRaw: no config file -> undefined", async () => {
	const dir = tempDir();
	const originalCwd = process.cwd();
	process.chdir(dir);
	try {
		assert.equal(await resolveConfigCmdRaw(undefined), undefined);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveConfigCmdRaw: dir w/ .sitediff.json -> raw parsed content", async () => {
	const dir = tempDir();
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ outDir: "from-file" }),
		);
		const raw = (await resolveConfigCmdRaw(dir)) as Record<string, unknown>;
		assert.equal(raw.outDir, "from-file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveConfigCmdRaw: malformed JSON syntax -> throws", async () => {
	const dir = tempDir();
	try {
		writeFileSync(join(dir, ".sitediff.json"), "{not json");
		await assert.rejects(() => resolveConfigCmdRaw(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveConfigCmdRaw: unsupported extension -> throws", async () => {
	const dir = tempDir();
	try {
		const yamlPath = join(dir, "config.yaml");
		writeFileSync(yamlPath, "outDir: nope\n");
		await assert.rejects(() => resolveConfigCmdRaw(yamlPath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- initConfigFile ---

test("initConfigFile: creates .json in cwd, nested config/worker shape, no headless, empty collections+presets objects", async () => {
	const dir = tempDir();
	const originalCwd = process.cwd();
	process.chdir(dir);
	try {
		const { path } = await initConfigFile(undefined);
		assert.equal(path, join(dir, ".sitediff.json"));
		assert.ok(existsSync(path));
		const content = readFileSync(path, "utf8");
		assert.doesNotMatch(content, /"headless"/);
		const parsed = JSON.parse(content);
		assert.equal(parsed.outDir, DEFAULT_CONFIG.outDir);
		assert.equal(parsed.dbPath, DEFAULT_CONFIG.dbPath);
		assert.deepEqual(parsed.worker, DEFAULT_WORKER_CONFIG);
		assert.deepEqual(parsed.config.viewport, DEFAULT_CONFIG.viewport);
		assert.equal(parsed.config.outDir, undefined);
		assert.equal(parsed.config.dbPath, undefined);
		assert.deepEqual(parsed.collections, {});
		assert.deepEqual(parsed.presets, {});
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: <path>.json creates .json (ext-driven)", async () => {
	const dir = tempDir();
	try {
		const target = join(dir, "custom.json");
		const { path } = await initConfigFile(target);
		assert.equal(path, target);
		const content = readFileSync(path, "utf8");
		assert.match(content, new RegExp(JSON.stringify(DEFAULT_CONFIG.outDir)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: <path>.yaml unsupported extension -> throws", async () => {
	const dir = tempDir();
	try {
		await assert.rejects(() => initConfigFile(join(dir, "foo.yaml")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: target already exists, no force -> throws", async () => {
	const dir = tempDir();
	try {
		const target = join(dir, "existing.json");
		writeFileSync(target, "{}");
		await assert.rejects(() => initConfigFile(target));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: target already exists, force:true -> overwrites", async () => {
	const dir = tempDir();
	try {
		const target = join(dir, "existing.json");
		writeFileSync(target, JSON.stringify({ outDir: "stale" }));
		const { path } = await initConfigFile(target, true);
		assert.equal(path, target);
		const written = JSON.parse(readFileSync(target, "utf8"));
		assert.equal(written.outDir, DEFAULT_CONFIG.outDir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: outside cwd conventional name -> warning suggesting --config", async () => {
	const dir = tempDir();
	try {
		const target = join(dir, "sub.json");
		const { warning } = await initConfigFile(target);
		assert.match(warning ?? "", /--config/);
		assert.match(
			warning ?? "",
			new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("initConfigFile: default cwd location -> no warning", async () => {
	const dir = tempDir();
	const originalCwd = process.cwd();
	process.chdir(dir);
	try {
		const { warning } = await initConfigFile(undefined);
		assert.equal(warning, undefined);
	} finally {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- buildConfigTreeRows --- no env param anymore.

test("buildConfigTreeRows: undefined raw (no file) -> default rows only, all valid, no 'config file' source", () => {
	const { rows, valid } = buildConfigTreeRows(undefined);
	assert.equal(valid, true);
	assert.ok(rows.length > 0);
	assert.ok(rows.every((r) => r.valid === true));
	assert.ok(!rows.some((r) => r.source === "config file"));
});

test("buildConfigTreeRows: valid file -> every row valid:true, overall valid:true", () => {
	const { rows, valid } = buildConfigTreeRows({
		outDir: "./x",
		presets: { p1: { sessionPath: "y" } },
		collections: {},
	});
	assert.equal(valid, true);
	assert.ok(rows.every((r) => r.valid === true));
});

test("buildConfigTreeRows: bad field type -> only that row invalid, rest stay valid, overall invalid", () => {
	const { rows, valid } = buildConfigTreeRows({
		config: { navTimeoutMs: "abc" },
	});
	assert.equal(valid, false);
	const bad = rows.find((r) => r.field === "/config/navTimeoutMs");
	assert.equal(bad?.valid, false);
	const other = rows.find((r) => r.field === "/outDir");
	assert.equal(other?.valid, true);
});

test("buildConfigTreeRows: unrecognized top-level key -> overall invalid even though no visible row maps to it", () => {
	const { valid } = buildConfigTreeRows({ headless: true });
	assert.equal(valid, false);
});

test("buildConfigTreeRows: presets.<name>.<field> rows rendered as JSON Pointer, source=config file", () => {
	const { rows } = buildConfigTreeRows({
		presets: { mobile: { viewport: { width: 375 } } },
	});
	const row = rows.find((r) => r.field === "/presets/mobile/viewport/width");
	assert.equal(row?.value, "375");
	assert.equal(row?.source, "config file");
	assert.equal(row?.valid, true);
});

test("buildConfigTreeRows: preset/collection names w/ '~' or '/' RFC-6901-escaped", () => {
	const { rows } = buildConfigTreeRows({
		presets: { "a/b~c": {} },
		collections: { "x/y": "a/b~c" },
	});
	const row = rows.find((r) => r.field === "/collections/x~1y");
	assert.equal(row?.value, "a/b~c");
	assert.equal(row?.valid, true);
});

test("buildConfigTreeRows: worker.* rows rendered, source=config file when set", () => {
	const { rows } = buildConfigTreeRows({ worker: { timeout: 5000 } });
	const timeout = rows.find((r) => r.field === "/worker/timeout");
	const autostart = rows.find((r) => r.field === "/worker/autostart");
	assert.equal(timeout?.value, "5000");
	assert.equal(timeout?.source, "config file");
	assert.equal(autostart?.value, String(DEFAULT_WORKER_CONFIG.autostart));
	assert.equal(autostart?.source, "config file");
});

test("buildConfigTreeRows: /wwwEquivalent row rendered, source=config file when set, default otherwise", () => {
	const { rows } = buildConfigTreeRows({ wwwEquivalent: false });
	const row = rows.find((r) => r.field === "/wwwEquivalent");
	assert.equal(row?.value, "false");
	assert.equal(row?.source, "config file");

	const { rows: defaultRows } = buildConfigTreeRows(undefined);
	const defaultRow = defaultRows.find((r) => r.field === "/wwwEquivalent");
	assert.equal(defaultRow?.value, "true");
	assert.equal(defaultRow?.source, "default");
});

test("buildConfigTreeRows: worker.* rows default when file doesn't set worker", () => {
	const { rows } = buildConfigTreeRows(undefined);
	const timeout = rows.find((r) => r.field === "/worker/timeout");
	assert.equal(timeout?.value, String(DEFAULT_WORKER_CONFIG.timeout));
	assert.equal(timeout?.source, "default");
});

// collections{} value = bare presetName string — 1 row/collection.

test("buildConfigTreeRows: collections.<name> row rendered as presetName, source=config file", () => {
	const { rows } = buildConfigTreeRows({
		presets: { mobile: {} },
		collections: { checkout: "mobile" },
	});
	const row = rows.find((r) => r.field === "/collections/checkout");
	assert.equal(row?.value, "mobile");
	assert.equal(row?.source, "config file");
	assert.equal(row?.valid, true);
});

test("buildConfigTreeRows: dangling collections.<name> preset ref -> that row invalid, overall invalid", () => {
	const { rows, valid } = buildConfigTreeRows({
		collections: { mobile: "ghost" },
	});
	assert.equal(valid, false);
	const row = rows.find((r) => r.field === "/collections/mobile");
	assert.equal(row?.valid, false);
});

test("buildConfigTreeRows: legacy collections.<name> object shape -> unrecognized, overall invalid", () => {
	const { valid } = buildConfigTreeRows({
		collections: { mobile: { preset: "x" } },
	});
	assert.equal(valid, false);
});

test("buildConfigTreeRows: empty presets:{} still gets a summary row", () => {
	const { rows } = buildConfigTreeRows({ presets: {} });
	const row = rows.find((r) => r.field === "/presets");
	assert.equal(row?.valid, true);
});

test("buildConfigTreeRows: empty collections:{} still gets a summary row", () => {
	const { rows } = buildConfigTreeRows({ collections: {} });
	const row = rows.find((r) => r.field === "/collections");
	assert.equal(row?.valid, true);
});

test("buildConfigTreeRows: dbPath structurally absent from presets rows", () => {
	const { valid } = buildConfigTreeRows({
		presets: { mobile: { dbPath: "./nope.sqlite" } as unknown as object },
	});
	// dbPath isn't a legal preset field -> unrecognized_keys -> overall invalid
	assert.equal(valid, false);
});

test("buildConfigTreeRows: completion.descriptionTemplate stays a normal row", () => {
	const { rows } = buildConfigTreeRows({
		completion: { descriptionTemplate: "%path%" },
	});
	const row = rows.find((r) => r.field === "/completion/descriptionTemplate");
	assert.equal(row?.value, "%path%");
	assert.equal(row?.source, "config file");
	assert.equal(row?.valid, true);
});
