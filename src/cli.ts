#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tab from "@bomb.sh/tab/commander";
import { Command, CommanderError } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { capture } from "./capture.ts";
import {
	DEFAULT_CONFIG,
	DEFAULT_WORKER_CONFIG,
	getDescriptionTemplate,
	resolveAppConfig,
	resolveCaptureConfig,
} from "./config.ts";
import type { ConfigSource, ConfigTreeRow } from "./config-cmd.ts";
import {
	buildCaptureResultRows,
	buildConfigTreeRows,
	initConfigFile,
	resolveConfigCmdRaw,
} from "./config-cmd.ts";
import {
	type CompletionSummary,
	getRecentSnapshotSummaries,
	getSnapshotByShortId,
	listSnapshots,
	type SnapshotStatus,
	withDb,
} from "./db.ts";
import { computeDiff } from "./diff.ts";
import { enqueueHasNoInput, enqueueUrls } from "./enqueue.ts";
import { startMcpServer } from "./mcp.ts";
import { generateReport } from "./report.ts";
import { generateStats } from "./stats.ts";
import {
	ensureWorkerRunning,
	startWorkerForeground,
	stopWorker,
	workerStatusReport,
} from "./worker-cmd.ts";

// real named columns (⊥ console.table's numeric (index) artifact).
function printFieldValueTable(
	rows: Array<{ field: string; value: string }>,
): void {
	const table = new Table({
		columns: [
			{ name: "field", alignment: "left" },
			{ name: "value", alignment: "left" },
		],
	});
	for (const row of rows) table.addRow(row);
	table.printTable();
}

// picocolors' own isColorSupported treats `CI=true` as color-capable even
// when stdout is a piped/captured non-TTY (breaks scripts diffing raw CLI
// output). `--color`/`--no-color` force it; otherwise real TTY + the usual
// NO_COLOR/FORCE_COLOR env overrides decide.
function resolveUseColor(colorOpt?: boolean): boolean {
	if (colorOpt !== undefined) return colorOpt;
	return (
		!process.env.NO_COLOR &&
		(!!process.env.FORCE_COLOR ||
			(!!process.stdout.isTTY && process.env.TERM !== "dumb"))
	);
}

// capture result's `status` row colored green(completed)/red(error) —
// row-level color opt (row≡cell there, only field/value columns exist).
function printCaptureResultTable(
	rows: Array<{ field: string; value: string }>,
	useColor: boolean,
): void {
	const table = new Table({
		columns: [
			{ name: "field", alignment: "left" },
			{ name: "value", alignment: "left" },
		],
	});
	for (const row of rows) {
		const color =
			useColor && row.field === "status"
				? row.value === "completed"
					? "green"
					: "red"
				: undefined;
		table.addRow(row, color ? { color } : undefined);
	}
	table.printTable();
}

// bare `config`'s `source`/`valid` columns colored per origin/validity
// — direct ANSI-wrap of the cell string, not console-table-printer's
// row-level `color` opt, which would also color `field`/`value` in the
// same row.
const SOURCE_COLOR: Record<ConfigSource, (s: string) => string> = {
	default: pc.gray,
	"config file": pc.cyan,
};

// bare `config`'s whole-tree table: field/value/source/valid
// columns — same shape as `--json`'s rows, rendered as a real table.
function printConfigTreeTable(rows: ConfigTreeRow[], useColor: boolean): void {
	const table = new Table({
		columns: [
			{ name: "field", alignment: "left" },
			{ name: "value", alignment: "left" },
			{ name: "source", alignment: "left" },
			{ name: "valid", alignment: "left" },
		],
	});
	for (const row of rows) {
		const source = useColor ? SOURCE_COLOR[row.source](row.source) : row.source;
		const validText = String(row.valid);
		const valid = useColor
			? row.valid
				? pc.green(validText)
				: pc.red(validText)
			: validText;
		table.addRow({ ...row, source, valid });
	}
	table.printTable();
}

// columns for `list`'s table output.
function printListTable(
	rows: Array<{
		short_id: string | null;
		host: string;
		path: string;
		collection: string | null;
		width: number | null;
		height: number | null;
		timestamp: string;
		status: string;
	}>,
): void {
	const table = new Table({
		columns: [
			{ name: "short_id", alignment: "left" },
			{ name: "host", alignment: "left" },
			{ name: "path", alignment: "left" },
			{ name: "collection", alignment: "left" },
			{ name: "width", alignment: "left" },
			{ name: "height", alignment: "left" },
			{ name: "timestamp", alignment: "left" },
			{ name: "status", alignment: "left" },
		],
	});
	for (const row of rows) {
		table.addRow({
			short_id: row.short_id ?? "",
			host: row.host,
			path: row.path,
			collection: row.collection ?? "",
			width: row.width ?? "",
			height: row.height ?? "",
			timestamp: row.timestamp,
			status: row.status,
		});
	}
	table.printTable();
}

// CommanderError itself carries no reference to the command that threw
// it — the only way to recover it is `this` inside a plain (non-arrow)
// exitOverride callback, since commander invokes `this._exitCallback(err)`
// per-command (verified node_modules/commander/lib/command.js:535).
interface CommanderErrorWithCommand extends CommanderError {
	failingCommand?: Command;
}

// Skip commander's default stderr write for missing-required-arg errors
// (help-only, per the parseAsync catch below) — must stay a plain function,
// not an arrow, so `this` binds to the actual failing (sub)command instance
// at call time, same binding requirement as exitOverride's callback above
// (`node_modules/commander/lib/command.js:1419`).
// `missingArgument`/`_exit` aren't part of commander's public TS surface.
interface CommandInternals extends Command {
	missingArgument(name: string): void;
	_exit(exitCode: number, code: string, message: string): never;
}
(Command.prototype as unknown as CommandInternals).missingArgument = function (
	this: Command,
	name: string,
) {
	const message = `error: missing required argument '${name}'`;
	(this as unknown as CommandInternals)._exit(
		1,
		"commander.missingArgument",
		message,
	);
};

const program = new Command();

const APP_DESCRIPTION =
	"Captures a URL's full page behavior (redirects, HAR, DOM, screenshot, console) via Playwright, and stores it for later querying/diffing.";

program
	.name("sitediff")
	.version(pkg.version)
	.addHelpText("before", `sitediff ${pkg.version}\n\n${APP_DESCRIPTION}\n`)
	.addHelpCommand(false)
	// top-level command listing shows description only, ⊥ arg syntax —
	// subcommand's own `--help` (commandUsage) is unaffected by this.
	.configureHelp({
		subcommandTerm: (cmd) => cmd.name(),
		showGlobalOptions: true,
	})
	.exitOverride(function (this: Command, err: CommanderError): never {
		(err as CommanderErrorWithCommand).failingCommand = this;
		throw err;
	})
	.option("--color", "force ANSI color output")
	.option("--no-color", "disable ANSI color output");

interface GlobalOpts {
	color?: boolean;
}

program
	.command("capture <url>")
	.description("Run 1 Playwright capture pass for a URL, or enqueue it")
	.option("--headed", "run browser headed")
	.option("--config <path>", "config file or directory path")
	.option("--collection <name>", "named collection preset from config file")
	.option("--preset <name>", "named preset from config file")
	.option("--json", "output raw JSON instead of a table")
	.option("--enqueue", "insert into the queue instead of running immediately")
	.option("--worker", "ensure a worker is running (auto-start if not)")
	.action(async function (
		this: Command,
		url: string,
		options: {
			headed?: boolean;
			config?: string;
			collection?: string;
			preset?: string;
			json?: boolean;
			enqueue?: boolean;
			worker?: boolean;
		},
	) {
		const { color } = this.optsWithGlobals<GlobalOpts>();
		const result = await capture(url, {
			headless: options.headed,
			configPath: options.config,
			collectionName: options.collection,
			presetName: options.preset,
			enqueue: options.enqueue,
			worker: options.worker,
		});

		if (options.json) {
			console.log(
				JSON.stringify(result, (_key, value) =>
					value instanceof Error ? { message: value.message } : value,
				),
			);
		} else {
			printCaptureResultTable(
				buildCaptureResultRows(result),
				resolveUseColor(color),
			);
		}

		process.exit(result.status === "error" ? 1 : 0);
	});

program
	.command("enqueue [file]")
	.description(
		"Bulk-insert queued snapshot rows for URLs, from a file or stdin (1 per line)",
	)
	.option("--config <path>", "config file or directory path")
	.option("--collection <name>", "named collection preset from config file")
	.option("--preset <name>", "named preset from config file")
	.option("--worker", "ensure a worker is running (auto-start if not)")
	.action(async function (
		this: Command,
		file: string | undefined,
		options: {
			config?: string;
			collection?: string;
			preset?: string;
			worker?: boolean;
		},
	) {
		// no file arg + a TTY stdin (nobody piped anything) → clear
		// error + help, ⊥ the raw EAGAIN `readFileSync(0)` used to throw.
		if (enqueueHasNoInput(file, process.stdin.isTTY)) {
			console.log(this.helpInformation());
			process.exit(1);
		}

		// /\r?\n/ (⊥ bare \n) — a CRLF-authored file would otherwise leave
		// a trailing \r on every url. Blank lines skipped, rest kept verbatim.
		const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
		const urls = raw.split(/\r?\n/).filter((line) => line.length > 0);

		const { config, meta, worker } = await resolveCaptureConfig(
			options.config,
			{ collectionName: options.collection, presetName: options.preset },
		);

		const rows = enqueueUrls(urls, config, worker, meta);

		if (options.worker) {
			ensureWorkerRunning(config.dbPath);
		}

		console.log(`enqueued ${rows.length} url(s)`);
	});

interface ConfigGlobalOpts {
	config?: string;
}

const configCmd = program
	.command("config")
	.description("Manage the resolved config file")
	.option("--config <path>", "config file or directory path")
	.option("--json", "output raw JSON instead of a table")
	.addHelpCommand(false)
	// bare `config`: 1 flat field/value/source/valid table of the whole
	// config-file tree, replaces the old `show`+`validate` split.
	.action(async function (this: Command, options: { json?: boolean }) {
		const { config: configFilePath, color } = this.optsWithGlobals<
			ConfigGlobalOpts & GlobalOpts
		>();
		const raw = await resolveConfigCmdRaw(configFilePath);
		const { rows, valid } = buildConfigTreeRows(raw);
		if (options.json) {
			console.log(JSON.stringify(rows));
			process.exit(valid ? 0 : 1);
		}
		printConfigTreeTable(rows, resolveUseColor(color));
	});

configCmd
	.command("init")
	.description("Write a new config file")
	.option("--force", "overwrite the file if it already exists")
	.action(async function (this: Command, options: { force?: boolean }) {
		const { config: configFilePath } = this.optsWithGlobals<ConfigGlobalOpts>();
		const { path, warning } = await initConfigFile(
			configFilePath,
			options.force,
		);
		console.log(`created ${path}`);
		if (warning) console.log(warning);
	});

program
	.command("list")
	.description("List stored snapshots, filterable")
	.option("--collection <name>", "filter by collection name")
	.option("--width <n>", "filter by exact viewport width")
	.option("--height <n>", "filter by exact viewport height")
	.option("--host <glob>", "filter by host glob")
	.option("--path <glob>", "filter by path glob")
	.option("--after <date>", "filter to timestamp >= date (ISO, inclusive)")
	.option("--before <date>", "filter to timestamp <= date (ISO, inclusive)")
	.option("--status <status>", "filter by status: pending|completed|error")
	.option("--json", "output raw JSON instead of a table")
	.action(
		(options: {
			collection?: string;
			width?: string;
			height?: string;
			host?: string;
			path?: string;
			after?: string;
			before?: string;
			status?: string;
			json?: boolean;
		}) => {
			const { dbPath } = DEFAULT_CONFIG;
			const rows = withDb(dbPath, (db) =>
				listSnapshots(db, {
					collection: options.collection,
					width: options.width ? Number(options.width) : undefined,
					height: options.height ? Number(options.height) : undefined,
					host: options.host,
					path: options.path,
					after: options.after,
					before: options.before,
					status: options.status as SnapshotStatus | undefined,
				}),
			);

			if (options.json) {
				console.log(JSON.stringify(rows));
			} else {
				printListTable(rows);
			}
		},
	);

program
	.command("stats <shortId>")
	.description("Generate + write stats.json for a stored snapshot")
	.option("--json", "also print the full report to stdout")
	.action((shortId: string, options: { json?: boolean }) => {
		const { dbPath } = DEFAULT_CONFIG;
		withDb(dbPath, (db) => {
			const stats = generateStats(db, shortId);
			const row = getSnapshotByShortId(db, shortId);
			console.log(`wrote ${row?.output_dir}/stats.json`);
			if (options.json) console.log(JSON.stringify(stats));
		});
	});

program
	.command("diff <shortIdA> <shortIdB>")
	.description("Compare 2 stored snapshots")
	.option("--json", "also print the full report to stdout")
	.action(
		async (shortIdA: string, shortIdB: string, options: { json?: boolean }) => {
			// outDir/dbPath resolved BEFORE withDb opens the db —
			// withDb's sync finally-close (db.ts:26-28) would race a pending
			// async callback otherwise.
			const appConfig = await resolveAppConfig(undefined);
			const outDir = appConfig?.outDir ?? DEFAULT_CONFIG.outDir;
			const dbPath = appConfig?.dbPath ?? DEFAULT_CONFIG.dbPath;
			const wwwEquivalent = appConfig?.wwwEquivalent ?? true;
			const report = withDb(dbPath, (db) =>
				computeDiff(db, shortIdA, shortIdB, outDir, wwwEquivalent),
			);

			console.log(`wrote ${join(outDir, `diff-${shortIdA}-${shortIdB}.json`)}`);
			if (report.screenshot) {
				console.log(
					`wrote ${join(outDir, `diff-${shortIdA}-${shortIdB}.png`)}`,
				);
			}
			// html generation is the diff command's last step — a failure
			// here propagates (uncaught) same as any other step, ⊥ best-effort.
			console.log(`wrote ${generateReport(outDir, shortIdA, shortIdB)}`);
			if (options.json) {
				console.log(JSON.stringify(report));
			}
		},
	);

interface WorkerStartOpts {
	detached?: boolean;
}

async function handleWorkerStart(options: WorkerStartOpts): Promise<void> {
	if (options.detached) {
		const { started } = ensureWorkerRunning(DEFAULT_CONFIG.dbPath);
		console.log(
			started ? "worker started (detached)" : "worker already running",
		);
		return;
	}
	await startWorkerForeground(DEFAULT_CONFIG.dbPath, DEFAULT_WORKER_CONFIG);
}

const workerCmd = program
	.command("worker")
	.description("Manage the background capture worker")
	.addHelpCommand(false);

// bare `worker` (no subcommand) → Commander usage/help, exit 0 —
// `worker start` must be typed explicit to run foreground/detached.
workerCmd
	.command("start")
	.description(
		"Start the worker (foreground by default; -d/--detached to run in background)",
	)
	.option("-d, --detached", "run in the background")
	.action(async (options: WorkerStartOpts) => {
		await handleWorkerStart(options);
	});

workerCmd
	.command("stop")
	.description("Stop the running worker (SIGTERM)")
	.action(() => {
		const { stopped } = stopWorker(DEFAULT_CONFIG.dbPath);
		console.log(stopped ? "worker stopped" : "worker not running");
	});

workerCmd
	.command("status")
	.description("Queue counts + worker PID/liveness")
	.option("--json", "output raw JSON instead of a table")
	.action((options: { json?: boolean }) => {
		const report = workerStatusReport(DEFAULT_CONFIG.dbPath);
		if (options.json) {
			console.log(JSON.stringify(report));
			return;
		}
		const { counts, pid } = report;
		printFieldValueTable([
			{ field: "queued", value: String(counts.queued) },
			{ field: "pending", value: String(counts.pending) },
			{ field: "completed", value: String(counts.completed) },
			{ field: "error", value: String(counts.error) },
			{ field: "worker pid", value: pid !== undefined ? String(pid) : "-" },
			{ field: "running", value: pid !== undefined ? "yes" : "no" },
		]);
	});

program
	.command("mcp")
	.description("Start the MCP server (stdio) exposing these commands as tools")
	.action(async () => {
		await startMcpServer();
	});

// introspects program's command tree synchronously @ call time —
// must run after every other subcommand is registered above.
const completion = tab(program, { completionCommandName: "completion" });

// description placeholders = list cmd's own columns minus
// short_id. Single regex.replace pass — the replacer fn's return value is
// never re-scanned for further matches, so a host/path value that itself
// contains literal `%host%`-shaped text (plausible: new URL().pathname
// preserves it unencoded) can't get double-substituted. Unknown token stays
// literal; NULL underlying value -> "".
const DESCRIPTION_PLACEHOLDERS = new Set([
	"host",
	"path",
	"collection",
	"width",
	"height",
	"timestamp",
	"status",
]);
function formatCompletionDescription(
	template: string,
	row: CompletionSummary,
): string {
	return template.replace(/%(\w+)%/g, (match, key: string) => {
		if (!DESCRIPTION_PLACEHOLDERS.has(key)) return match;
		const value = row[key as keyof CompletionSummary];
		return value === null ? "" : String(value);
	});
}

// live short_id completion for stats/diff positional args —
// handler runs sync (lib calls it sync, never awaits it), so
// getRecentSnapshotSummaries's sync node:sqlite read-only query is the only
// shape that can work here.
const shortIdArgHandler = (
	complete: (value: string, description: string) => void,
) => {
	const { dbPath } = DEFAULT_CONFIG;
	const template = getDescriptionTemplate(process.cwd());
	for (const row of getRecentSnapshotSummaries(dbPath)) {
		complete(row.short_id, formatCompletionDescription(template, row));
	}
};
for (const [cmd, arg] of [
	["stats", "shortId"],
	["diff", "shortIdA"],
	["diff", "shortIdB"],
] as const) {
	const target = completion.commands.get(cmd)?.arguments.get(arg);
	if (target) target.handler = shortIdArgHandler;
}

program.parseAsync(process.argv).catch((err: unknown) => {
	if (err instanceof CommanderError) {
		// every other Commander parse error prints the failing command's
		// own full help too — exit code stays exactly Commander's own (the
		// exit-code rule still governs which errors are 0 vs 1, unaffected by
		// this). Codes
		// that already self-print full help/version content (explicit --help,
		// --version, or the bare-parent-no-subcommand fallback) are excluded —
		// printing again would just duplicate output.
		const ALREADY_PRINTED_CODES = new Set([
			"commander.help",
			"commander.helpDisplayed",
			"commander.version",
		]);
		if (!ALREADY_PRINTED_CODES.has(err.code)) {
			const failingCommand = (err as CommanderErrorWithCommand).failingCommand;
			const helpText = failingCommand?.helpInformation();
			if (helpText !== undefined) console.log(helpText);
		}
		process.exit(err.code === "commander.help" ? 0 : err.exitCode);
	}
	console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
