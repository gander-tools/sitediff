import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { PartialAppConfig } from "./config.ts";
import {
	DEFAULT_CONFIG,
	DEFAULT_DESCRIPTION_TEMPLATE,
	DEFAULT_WORKER_CONFIG,
	extractFilePreset,
	mergeConfig,
	partialAppConfigSchema,
	resolveFileOrDir,
} from "./config.ts";
import type { BaseConfig, CaptureResult, WorkerConfig } from "./pipeline.ts";

// no "env" source anymore — all env vars removed, source collapses 2-way.
export type ConfigSource = "default" | "config file";

// completion.descriptionTemplate lives on the appConfig only, not
// BaseConfig — display-only, computed standalone.
export interface CompletionInfo {
	value: string;
	source: ConfigSource;
}

function resolveCompletionInfo(
	fileConfig: PartialAppConfig | undefined,
): CompletionInfo {
	const value = fileConfig?.completion?.descriptionTemplate;
	return value !== undefined
		? { value, source: "config file" }
		: { value: DEFAULT_DESCRIPTION_TEMPLATE, source: "default" };
}

// wwwEquivalent lives on the appConfig top level, like completion — same
// display treatment: sole verification surface for a config-file-only,
// no-CLI-flag setting.
export interface WwwEquivalentInfo {
	value: boolean;
	source: ConfigSource;
}

const DEFAULT_WWW_EQUIVALENT = true;

function resolveWwwEquivalentInfo(
	fileConfig: PartialAppConfig | undefined,
): WwwEquivalentInfo {
	const value = fileConfig?.wwwEquivalent;
	return value !== undefined
		? { value, source: "config file" }
		: { value: DEFAULT_WWW_EQUIVALENT, source: "default" };
}

// RFC 6901 JSON Pointer segment escaping (~ -> ~0, / -> ~1) — skipping this
// for a segment containing either char (e.g. a user-named collection/preset)
// produces an ambiguous pointer.
function escapeSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

// RFC 6901 JSON Pointer into the raw appConfig file tree — zod's issue.path
// already matches the file's real shape 1:1, so this is a direct
// serialization, no field-specific stripping needed. Root (path.length===0)
// -> "" per spec. Reused by buildConfigTreeRows' per-row `valid` mapping.
function formatIssuePath(path: (string | number | symbol)[]): string {
	if (path.length === 0) return "";
	return `/${path.map((seg) => escapeSegment(String(seg))).join("/")}`;
}

// worker lives on appConfig top-level only — same non-BaseConfig
// display treatment as completion.descriptionTemplate.
export interface WorkerInfo {
	value: WorkerConfig;
	source: ConfigSource;
}

function resolveWorkerInfo(
	fileConfig: PartialAppConfig | undefined,
): WorkerInfo {
	const override = fileConfig?.worker;
	return override !== undefined
		? {
				value: { ...DEFAULT_WORKER_CONFIG, ...override },
				source: "config file",
			}
		: { value: DEFAULT_WORKER_CONFIG, source: "default" };
}

export function resolveConfigWithSources(
	fileConfig: PartialAppConfig | undefined,
): {
	config: BaseConfig;
	sources: Record<keyof BaseConfig, ConfigSource>;
	completion: CompletionInfo;
	worker: WorkerInfo;
	wwwEquivalent: WwwEquivalentInfo;
} {
	// strip collections/presets/completion/worker (appConfig-only, not
	// BaseConfig fields) so they never leak into the main preset table
	// (collections/worker rendered separately; completion is display-only
	// here, resolved standalone below)
	const filePreset = extractFilePreset(fileConfig) ?? {};
	const sources = {} as Record<keyof BaseConfig, ConfigSource>;
	for (const key of Object.keys(DEFAULT_CONFIG) as (keyof BaseConfig)[]) {
		sources[key] = fileConfig && key in filePreset ? "config file" : "default";
	}
	const config = mergeConfig(DEFAULT_CONFIG, filePreset) as BaseConfig;
	return {
		config,
		sources,
		completion: resolveCompletionInfo(fileConfig),
		worker: resolveWorkerInfo(fileConfig),
		wwwEquivalent: resolveWwwEquivalentInfo(fileConfig),
	};
}

export interface ConfigTableRow {
	field: string;
	value: string;
	source: string;
}

// scalars (string/number/boolean) render unquoted — only object/array
// values (viewport, selector arrays) still go through JSON.stringify.
function formatFieldValue(value: unknown): string {
	return typeof value === "object" && value !== null
		? JSON.stringify(value)
		: String(value);
}

// flattens 1 field's raw value into 0+ display rows: nested objects
// (viewport/worker) → 1 row/sub-key (`pointer/subkey`), arrays (selector
// lists) → 1 row/element (`pointer/i`, empty → 1 row `pointer = "-"`),
// anything else → unchanged single row. `pointer` is the field's own RFC
// 6901 JSON Pointer (already escaped/prefixed by the caller) —
// sub-keys/indices appended here get escaped too. Shared by buildTableRows
// (main fields) and buildConfigTreeRows (presets.*/collections.*) so the
// flatten applies uniformly.
function flattenField(
	pointer: string,
	value: unknown,
): Array<{ field: string; value: string }> {
	if (Array.isArray(value)) {
		return value.length > 0
			? value.map((v, i) => ({
					field: `${pointer}/${i}`,
					value: formatFieldValue(v),
				}))
			: [{ field: pointer, value: "-" }];
	}
	if (value !== null && typeof value === "object") {
		return Object.entries(value).map(([subkey, v]) => ({
			field: `${pointer}/${escapeSegment(subkey)}`,
			value: formatFieldValue(v),
		}));
	}
	return [{ field: pointer, value: formatFieldValue(value) }];
}

// non-BaseConfig display rows (completion.descriptionTemplate, any future
// field that lives outside BaseConfig) — appended alongside the flattened
// BaseConfig fields.
export interface ExtraRow {
	field: string;
	value: string;
	source: ConfigSource;
}

// outDir/dbPath live @ appConfig top-level; every other BaseConfig field
// nests under the file's `config` key — the pointer prefix has to
// reflect that real on-disk split, unlike the old bare-name display.
const APP_TOP_LEVEL_FIELDS = new Set(["outDir", "dbPath"]);

function fieldPointer(field: string): string {
	return APP_TOP_LEVEL_FIELDS.has(field)
		? `/${field}`
		: `/config/${escapeSegment(field)}`;
}

// main-field portion of the config tree — BaseConfig fields + extras
// (completion.descriptionTemplate), 3-column (field/value/source).
// buildConfigTreeRows wraps this with the per-row `valid` column and
// appends presets.*/collections.* rows.
export function buildTableRows(
	config: BaseConfig,
	sources: Record<keyof BaseConfig, ConfigSource>,
	extras: ExtraRow[],
): ConfigTableRow[] {
	return [
		...(Object.keys(config) as (keyof BaseConfig)[]).flatMap((field) =>
			flattenField(fieldPointer(field), config[field]).map((row) => ({
				...row,
				source: sources[field],
			})),
		),
		...extras,
	];
}

// table default for `capture` stdout — error flattened to a string, never
// a nested object in the table cell.
export function buildCaptureResultRows(
	result: CaptureResult,
): Array<{ field: string; value: string }> {
	const rows = [
		{ field: "id", value: result.id },
		{ field: "status", value: result.status },
		{ field: "outputDir", value: result.outputDir },
	];
	if (result.error !== undefined) {
		rows.push({
			field: "error",
			value:
				result.error instanceof Error
					? result.error.message
					: String(result.error),
		});
	}
	return rows;
}

// bare `config`'s own resolver — positional arg or cwd-discovery ONLY (mirrors
// capture.ts's resolveFileOrDir-based discovery). Returns raw JSON.parse'd
// content, NOT schema-validated — bare
// `config`'s per-row `valid` column needs to render every field even when
// the file fails schema validation, which a throwing loader (like
// config.ts's loadConfigFile) can't support. Malformed JSON *syntax* still
// throws; only *schema* validity is deferred to buildConfigTreeRows.
export async function resolveConfigCmdRaw(
	path: string | undefined,
): Promise<unknown> {
	const target = resolveFileOrDir(path ?? process.cwd());
	if (path && !target) throw new Error(`config path not found: ${path}`);
	if (!target) return undefined;
	const ext = extname(target);
	if (ext !== ".json") {
		throw new Error(`unsupported config file extension: ${ext}`);
	}
	return JSON.parse(await readFile(target, "utf8"));
}

export interface ConfigTreeRow {
	field: string;
	value: string;
	source: ConfigSource;
	valid: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// bare `config`/`config --json`'s sole row-builder: 1 flat table for the
// WHOLE config-file tree (main BaseConfig fields + worker.* + presets.<name>.*
// + collections.<name>). `raw` = resolveConfigCmdRaw's output (unknown |
// undefined) — undefined means no config file was found (not an error:
// default-only rows, all valid).
//
// `valid` per row: 1 whole-file `partialAppConfigSchema.safeParse` —
// success → every row starts valid:true; failure → `issue.path` (an
// `unrecognized_keys` issue's offending key(s) are appended to its `path`,
// since zod reports those at the PARENT path with a separate `keys[]`
// array, not per-key) marks the matching row(s) false. A zod issue whose
// path never corresponds to a rendered row (e.g. a top-level unrecognized
// key that isn't a real field) has nothing to visibly flag — the returned
// `valid` summary therefore also gates on `parsed.success` directly, not
// purely on `rows.every(...)`, so a broken file can never summarize as
// valid just because none of its issues happened to land on a visible row.
//
// Additionally (independent of zod): every `collections.<name>` value is
// checked against the presets object's keys — a dangling ref is a valid
// string as far as zod is concerned, so this is the only place that catches
// it.
export function buildConfigTreeRows(raw: unknown): {
	rows: ConfigTreeRow[];
	valid: boolean;
} {
	// no config file found isn't a schema-validity question at all —
	// treat it as an empty, trivially-valid config rather than routing
	// `undefined` into safeParse (which fails: the schema expects an object).
	const parsed: ReturnType<typeof partialAppConfigSchema.safeParse> =
		raw === undefined
			? { success: true, data: {} as PartialAppConfig }
			: partialAppConfigSchema.safeParse(raw);
	// row `field`s are now real RFC 6901 pointers into the file tree,
	// same shape zod's own issue.path already uses — direct serialization,
	// no path rewriting needed to map an issue onto its visible row.
	const invalidPaths = new Set<string>();
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			if (issue.code === "unrecognized_keys") {
				for (const key of issue.keys) {
					invalidPaths.add(formatIssuePath([...issue.path, key]));
				}
			} else {
				invalidPaths.add(formatIssuePath(issue.path));
			}
		}
	}
	const loose: Record<string, unknown> = isPlainObject(raw) ? raw : {};
	const appConfig = (parsed.success ? parsed.data : loose) as PartialAppConfig;

	const { config, sources, completion, worker, wwwEquivalent } =
		resolveConfigWithSources(appConfig);
	const mainRows: ConfigTreeRow[] = buildTableRows(config, sources, [
		{
			field: "/completion/descriptionTemplate",
			value: completion.value,
			source: completion.source,
		},
		{
			field: "/wwwEquivalent",
			value: String(wwwEquivalent.value),
			source: wwwEquivalent.source,
		},
	]).map((row) => ({
		...row,
		source: row.source as ConfigSource,
		valid: !invalidPaths.has(row.field),
	}));

	const workerRows: ConfigTreeRow[] = flattenField("/worker", worker.value).map(
		(row) => ({
			...row,
			source: worker.source,
			valid: !invalidPaths.has(row.field),
		}),
	);

	const presetsSource = parsed.success
		? (appConfig.presets ?? {})
		: isPlainObject(loose.presets)
			? loose.presets
			: {};
	const presetNames = new Set(Object.keys(presetsSource));
	const presetRows: ConfigTreeRow[] = Object.entries(presetsSource).flatMap(
		([name, presetConfig]) =>
			(isPlainObject(presetConfig) ? Object.keys(presetConfig) : []).flatMap(
				(key) => {
					const pointer = `/presets/${escapeSegment(name)}/${escapeSegment(key)}`;
					return flattenField(
						pointer,
						(presetConfig as Record<string, unknown>)[key],
					).map((row) => ({
						field: row.field,
						value: row.value,
						source: "config file" as ConfigSource,
						valid: !invalidPaths.has(row.field),
					}));
				},
			),
	);

	// empty {} sections still get a summary row — a config file that spells
	// out `"presets": {}` shouldn't vanish from the output just because it has
	// no entries to break down.
	if (presetRows.length === 0 && "presets" in loose) {
		presetRows.push({
			field: "/presets",
			value: "-",
			source: "config file",
			valid: !invalidPaths.has("/presets"),
		});
	}

	const collectionsSource = parsed.success
		? (appConfig.collections ?? {})
		: isPlainObject(loose.collections)
			? loose.collections
			: {};
	// collections{} value = bare presetName string — 1 row/collection,
	// not the old preset/config sub-row split (bare string carries no sub-fields).
	const collectionRows: ConfigTreeRow[] = Object.entries(collectionsSource).map(
		([name, presetNameRaw]) => {
			const field = `/collections/${escapeSegment(name)}`;
			const presetName = String(presetNameRaw);
			return {
				field,
				value: presetName,
				source: "config file" as ConfigSource,
				valid: !invalidPaths.has(field) && presetNames.has(presetName),
			};
		},
	);
	if (collectionRows.length === 0 && "collections" in loose) {
		collectionRows.push({
			field: "/collections",
			value: "-",
			source: "config file",
			valid: !invalidPaths.has("/collections"),
		});
	}

	const rows = [...mainRows, ...workerRows, ...presetRows, ...collectionRows];
	const valid = parsed.success && rows.every((row) => row.valid);
	return { rows, valid };
}

// default file body is the appConfig shape (no `headless` — never a
// BaseConfig field — empty `collections`/`presets` objects). outDir/dbPath
// stay top-level; the rest of DEFAULT_CONFIG nests under `config`.
function defaultsAppConfigBody(): Record<string, unknown> {
	const { outDir, dbPath, ...configFields } = DEFAULT_CONFIG;
	return {
		outDir,
		dbPath,
		worker: DEFAULT_WORKER_CONFIG,
		config: configFields,
		collections: {},
		presets: {},
	};
}

function jsonConfigFileContent(): string {
	return `${JSON.stringify(defaultsAppConfigBody(), null, 2)}\n`;
}

// `force`: default-file-exists guard becomes conditional — `config init`
// errors on an existing file unless the caller opts in to overwriting it.
export async function initConfigFile(
	targetPath: string | undefined,
	force = false,
): Promise<{ path: string; warning?: string }> {
	const givenExt = targetPath ? extname(targetPath) : undefined;
	if (givenExt && givenExt !== ".json") {
		throw new Error(`unsupported config file extension: ${givenExt}`);
	}
	const resolvedPath = targetPath
		? resolve(targetPath)
		: join(process.cwd(), ".sitediff.json");

	if (existsSync(resolvedPath) && !force) {
		throw new Error(`config file already exists: ${resolvedPath}`);
	}

	const content = jsonConfigFileContent();
	await writeFile(resolvedPath, content);

	const isDefaultPath = resolvedPath === join(process.cwd(), ".sitediff.json");
	const warning = isDefaultPath
		? undefined
		: `config file created outside the default location — pass --config ${resolvedPath} explicitly so 'capture' finds it`;

	return { path: resolvedPath, warning };
}
