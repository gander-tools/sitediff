import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import type {
	BaseConfig,
	PartialBaseConfig,
	SettingsMeta,
	WorkerConfig,
} from "./pipeline.ts";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const viewportSchema = z
	.object({ width: z.number(), height: z.number() })
	.strict();
// raw partial — width/height independently omittable, not defaulted here.
// Defaulting to DEFAULT_VIEWPORT happens once, in mergeConfig, so a value set
// at one cascade level (e.g. appConfig top-level) can still fill a sub-field
// left unset at a later level (e.g. a preset) instead of every level jumping
// straight to DEFAULT_VIEWPORT on its own.
const partialViewportSchema = viewportSchema.partial();

// worker.timeout: -1 = no idle-limit, >=0 = ms of continuous idle
// before self-exit (0 = self-exit on first idle check).
const workerSchema = z
	.object({
		timeout: z.number().int().min(-1),
		autostart: z.boolean(),
	})
	.strict();
const partialWorkerSchema = workerSchema.partial();

const baseConfigSchema = z
	.object({
		outDir: z.string(),
		dbPath: z.string(),
		viewport: viewportSchema,
		navTimeoutMs: z.number(),
		sessionPath: z.string().optional(),
		maskSelectors: z.array(z.string()),
		hideSelectors: z.array(z.string()),
		dropSelectors: z.array(z.string()),
	})
	.strict() satisfies z.ZodType<BaseConfig>;

export const DEFAULT_CONFIG: BaseConfig = baseConfigSchema.parse({
	outDir: "./output",
	dbPath: "./sitediff.sqlite",
	viewport: DEFAULT_VIEWPORT,
	navTimeoutMs: 30000,
	maskSelectors: [],
	hideSelectors: [],
	dropSelectors: [],
});

// worker lives on appConfig top-level only (⊥ configSchema/presets) —
// this is its sole default, DEFAULT_CONFIG carries no worker key anymore.
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
	autostart: true,
	timeout: 30000,
};

// file-shape schemas. presetConfigSchema (= user-facing "configSchema")
// excludes outDir+dbPath — those live only @ the appConfig top level, never
// per-preset/collection. `headless` is never a schema field at all —
// CLI flag only, resolved standalone via resolveHeadless.
export const presetConfigSchema = baseConfigSchema.omit({
	outDir: true,
	dbPath: true,
});

// shared partial-nested-object shape: zod's `.partial()` is shallow, so any
// object-typed field (viewport) needs its own sub-field-partial override to
// let a preset/appConfig-level `config` set just 1 sub-field — reused by
// presetSchema's entries and (via partialAppConfigSchema) the top-level
// `config` key, so a 4th nested-object field only needs 1 new line here.
const partialPresetConfigSchema = presetConfigSchema.partial().extend({
	viewport: partialViewportSchema.optional(),
});

// named, partial reusable presets (configSchema-shaped) — collections
// reference one by name (the object key). Fields a preset omits fall to the
// next cascade level (appConfig-level `config` -> DEFAULT_CONFIG).
export const presetSchema = z.record(z.string(), partialPresetConfigSchema);

// collections{} value = bare presetName string — dropped the old
// {preset?,config?} object shape entirely, no more per-collection inline
// override; a collection can only reference an existing named preset.
const collectionsSchema = z.record(z.string(), z.string());

// completion.descriptionTemplate: top-level-only, same as dbPath — ⊥ on
// baseConfigSchema/presetConfigSchema, so collections[]/presets[] configs
// cannot set it (unrecognized_keys).
const completionSchema = z
	.object({ descriptionTemplate: z.string() })
	.partial();

// appConfig top-level = {outDir,dbPath,worker?,config,presets,
// collections,completion?} — `config` nests the "standard"/configSchema
// fields (viewport/navTimeoutMs/sessionPath/maskSelectors/hideSelectors/
// dropSelectors), ⊥ spread flat at appConfig top-level anymore.
export const appConfigSchema = z
	.object({
		outDir: z.string(),
		dbPath: z.string(),
		worker: workerSchema.optional(),
		wwwEquivalent: z.boolean().optional(),
		config: presetConfigSchema,
		presets: presetSchema,
		collections: collectionsSchema,
		completion: completionSchema.optional(),
	})
	.strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

// shared by loadConfigFile & config-cmd.ts's writeCreatorConfig — on-disk
// files are never required to carry every field (defaults/env fill the rest
// @ runtime, mergeConfig), so writes validate against this same partial shape
// reads use, ⊥ the full non-partial appConfigSchema.
export const partialAppConfigSchema = z
	.object({
		outDir: z.string().optional(),
		dbPath: z.string().optional(),
		worker: partialWorkerSchema.optional(),
		wwwEquivalent: z.boolean().optional(),
		config: partialPresetConfigSchema.optional(),
		presets: presetSchema.optional(),
		collections: collectionsSchema.optional(),
		completion: completionSchema.optional(),
	})
	.strict();

export type PartialAppConfig = z.infer<typeof partialAppConfigSchema>;

// shared by resolveAppConfig & the `config` cmd's own resolver — resolves a
// user-given path to an absolute config file, whether it names the file
// directly or a directory containing a conventionally-named one.
export function resolveFileOrDir(candidate: string): string | undefined {
	const abs = resolve(candidate);
	if (!existsSync(abs)) return undefined;
	if (!statSync(abs).isDirectory()) return abs;
	const p = join(abs, ".sitediff.json");
	return existsSync(p) ? p : undefined;
}

// completion-only, sync-only read (⊥ loadConfigFile's async chain
// — the tab lib calls the completion handler sync, never awaits it).
// Deliberately narrow — extracts only completion.descriptionTemplate, ⊥ full
// appConfigSchema validation. Any failure (missing file, parse error, missing
// field, wrong type) → fallback "%host%", ⊥ throw.
export const DEFAULT_DESCRIPTION_TEMPLATE = "%host%";

export function getDescriptionTemplate(cwd: string): string {
	try {
		const target = resolveFileOrDir(cwd);
		if (!target) return DEFAULT_DESCRIPTION_TEMPLATE;
		const raw = JSON.parse(readFileSync(target, "utf8"));
		const template = raw?.completion?.descriptionTemplate;
		return typeof template === "string"
			? template
			: DEFAULT_DESCRIPTION_TEMPLATE;
	} catch {
		return DEFAULT_DESCRIPTION_TEMPLATE;
	}
}

export async function loadConfigFile(
	absPath: string,
): Promise<PartialAppConfig> {
	const ext = extname(absPath);
	if (ext !== ".json") {
		throw new Error(`unsupported config file extension: ${ext}`);
	}
	const raw = JSON.parse(await readFile(absPath, "utf8"));
	return partialAppConfigSchema.parse(raw);
}

// shared configPath -> cwd-discovery resolution, yielding the full appConfig
// (dbPath + preset fields + collections{}) — the sole I/O+parse point; every
// other resolver derives from its result instead of re-fetching. ⊥ env
// fallback anymore — --config opt or cwd-discovery only.
export async function resolveAppConfig(
	configPath: string | undefined,
): Promise<PartialAppConfig | undefined> {
	if (configPath) {
		const target = resolveFileOrDir(configPath);
		if (!target) throw new Error(`--config path not found: ${configPath}`);
		return loadConfigFile(target);
	}
	const cwdTarget = resolveFileOrDir(process.cwd());
	return cwdTarget ? loadConfigFile(cwdTarget) : undefined;
}

// pure derivation — appConfig top-level's own default override, for the
// cascade's file layer: outDir/dbPath come from the top level, the rest from
// the nested `config` key — collections/presets/completion/worker
// never part of this (appConfig-only fields, ⊥ part of BaseConfig).
export function extractFilePreset(
	appConfig: PartialAppConfig | undefined,
): PartialBaseConfig | undefined {
	if (!appConfig) return undefined;
	return {
		...(appConfig.outDir !== undefined ? { outDir: appConfig.outDir } : {}),
		...(appConfig.dbPath !== undefined ? { dbPath: appConfig.dbPath } : {}),
		...appConfig.config,
	};
}

// resolve a collection's `preset` name-ref against `presets{}`. Sync +
// exported so cli.ts's config-show per-collection preview (already holding
// a parsed appConfig) can reuse it without re-resolving the file.
export function resolvePresetByName(
	presets: z.infer<typeof presetSchema> | undefined,
	presetName: string | undefined,
): PartialBaseConfig {
	if (!presetName) return {};
	const preset = presets?.[presetName];
	if (preset === undefined) throw new Error(`preset not found: ${presetName}`);
	return preset;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// shared by every site that combines 2+ BaseConfig-partials (capture.ts's
// cascade, config-cmd.ts's resolveConfigWithSources, cli.ts's per-collection
// preview) — sole place cross-level merging is implemented, so call sites
// cannot drift. ANY object-typed field (viewport, future additions) merges
// sub-field-wise, cumulative across args (a sub-field unset in a later arg
// keeps the earlier arg's value instead of the whole object being clobbered)
// — ⊥ field-name special-casing; every other field is later-wins, incl.
// arrays (no element-level merge).
export function mergeConfig(
	...parts: Array<PartialBaseConfig | undefined>
): PartialBaseConfig {
	const merged: PartialBaseConfig = {};
	for (const part of parts) {
		if (!part) continue;
		for (const [key, value] of Object.entries(part)) {
			const existing = (merged as Record<string, unknown>)[key];
			(merged as Record<string, unknown>)[key] =
				isPlainObject(value) && isPlainObject(existing)
					? { ...existing, ...value }
					: value;
		}
	}
	return merged;
}

// pure derivation — named collection's preset from an already-fetched
// appConfig. collections{} value = bare presetName string (⊥ the old
// {preset?,config?} object) — direct name-ref resolution, no inline-config
// merge exists anymore.
export function extractCollectionPreset(
	appConfig: PartialAppConfig | undefined,
	name: string,
): PartialBaseConfig {
	const presetName = appConfig?.collections?.[name];
	if (presetName === undefined)
		throw new Error(`--collection not found: ${name}`);
	return resolvePresetByName(appConfig?.presets, presetName);
}

// hides fetch + collection/preset extraction + cascade merge + meta-building
// behind 1 call (mirrors config-cmd.ts's buildConfigShowView) — capture.ts
// no longer needs to know resolveAppConfig/extractFilePreset/
// extractCollectionPreset/resolvePresetByName/mergeConfig individually or
// their correct call order (resolveAppConfig still runs exactly once, here).
// ⊥ env param anymore — cascade base is DEFAULT_CONFIG directly.
export async function resolveCaptureConfig(
	configPath: string | undefined,
	opts: {
		collectionName?: string;
		presetName?: string;
		overrides?: PartialBaseConfig;
	} = {},
): Promise<{ config: BaseConfig; meta: SettingsMeta; worker: WorkerConfig }> {
	const { collectionName, presetName, overrides } = opts;
	const appConfig = await resolveAppConfig(configPath);
	const fileConfig = extractFilePreset(appConfig);
	const collectionOverride = collectionName
		? extractCollectionPreset(appConfig, collectionName)
		: undefined;
	const presetOverride = presetName
		? resolvePresetByName(appConfig?.presets, presetName)
		: undefined;
	const config = mergeConfig(
		DEFAULT_CONFIG,
		fileConfig,
		collectionOverride,
		presetOverride,
		overrides,
	) as BaseConfig;
	const worker: WorkerConfig = {
		...DEFAULT_WORKER_CONFIG,
		...appConfig?.worker,
	};

	const meta: SettingsMeta = {};
	if (collectionName) {
		meta.collection = {
			name: collectionName,
			config: collectionOverride ?? {},
		};
	}
	if (presetName) {
		meta.preset = { name: presetName, config: presetOverride ?? {} };
	}
	return { config, meta, worker };
}
