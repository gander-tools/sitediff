import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { capture } from "./capture.ts";
import {
	DEFAULT_CONFIG,
	resolveAppConfig,
	resolveCaptureConfig,
} from "./config.ts";
import {
	buildConfigTreeRows,
	initConfigFile,
	resolveConfigCmdRaw,
} from "./config-cmd.ts";
import { listSnapshots, withDb } from "./db.ts";
import { computeDiff } from "./diff.ts";
import { enqueueUrls } from "./enqueue.ts";
import { generateReport } from "./report.ts";
import { generateStats } from "./stats.ts";
import {
	ensureWorkerRunning,
	stopWorker,
	workerStatusReport,
} from "./worker-cmd.ts";

// every tool response is JSON content only, no table/plain-text shape.
function jsonResult(value: unknown): {
	content: [{ type: "text"; text: string }];
} {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(value, (_key, v) =>
					v instanceof Error ? { message: v.message } : v,
				),
			},
		],
	};
}

// an MCP client is not trusted with the whole filesystem: every path argument
// must stay inside the server's working directory (no read/overwrite of
// arbitrary files such as ~/.ssh or package.json). Symlinks are resolved on
// the nearest existing ancestor, so a link inside cwd cannot lead outside it.
function insideCwd(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	const root = realpathSync(process.cwd());
	let existing = resolve(path);
	const rest: string[] = [];
	while (!existsSync(existing)) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	const real = join(realpathSync(existing), ...rest);
	const rel = relative(root, real);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("path must be inside the working directory");
	}
	return path;
}

export function createMcpServer(): McpServer {
	const server = new McpServer({ name: "sitediff", version: pkg.version });

	server.registerTool(
		"capture",
		{
			description: "Run 1 Playwright capture pass for a URL, or enqueue it",
			inputSchema: {
				url: z.string(),
				headed: z.boolean().optional(),
				config: z.string().optional(),
				collection: z.string().optional(),
				preset: z.string().optional(),
				enqueue: z.boolean().optional(),
				worker: z.boolean().optional(),
			},
		},
		async (args) => {
			const result = await capture(args.url, {
				headless: args.headed,
				configPath: insideCwd(args.config),
				collectionName: args.collection,
				presetName: args.preset,
				enqueue: args.enqueue,
				worker: args.worker,
			});
			return jsonResult(result);
		},
	);

	server.registerTool(
		"enqueue",
		{
			description: "Bulk-insert queued snapshot rows for URLs (file xor urls)",
			inputSchema: {
				file: z.string().optional(),
				urls: z.array(z.string()).optional(),
				config: z.string().optional(),
				collection: z.string().optional(),
				preset: z.string().optional(),
				worker: z.boolean().optional(),
			},
		},
		async (args) => {
			// file xor urls, ⊥ stdin (MCP has no interactive stdin stream).
			if ((args.file === undefined) === (args.urls === undefined)) {
				throw new Error("enqueue: exactly 1 of file, urls required");
			}
			const urls = args.file
				? readFileSync(insideCwd(args.file) as string, "utf8")
						.split(/\r?\n/)
						.filter((line) => line.length > 0)
				: (args.urls as string[]);

			const { config, meta, worker } = await resolveCaptureConfig(
				insideCwd(args.config),
				{
					collectionName: args.collection,
					presetName: args.preset,
				},
			);
			const rows = enqueueUrls(urls, config, worker, meta);
			if (args.worker) ensureWorkerRunning(config.dbPath);
			return jsonResult(rows);
		},
	);

	server.registerTool(
		"list",
		{
			description: "List stored snapshots, filterable",
			inputSchema: {
				collection: z.string().optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				host: z.string().optional(),
				path: z.string().optional(),
				after: z.string().optional(),
				before: z.string().optional(),
				status: z.enum(["queued", "pending", "completed", "error"]).optional(),
			},
		},
		async (args) => {
			const { dbPath } = DEFAULT_CONFIG;
			return withDb(dbPath, (db) => jsonResult(listSnapshots(db, args)));
		},
	);

	server.registerTool(
		"stats",
		{
			description: "Generate + write stats.json for a stored snapshot",
			inputSchema: { shortId: z.string() },
		},
		(args) => {
			const { dbPath } = DEFAULT_CONFIG;
			return withDb(dbPath, (db) =>
				jsonResult(generateStats(db, args.shortId)),
			);
		},
	);

	server.registerTool(
		"diff",
		{
			description: "Compare 2 stored snapshots",
			inputSchema: { shortIdA: z.string(), shortIdB: z.string() },
		},
		async (args) => {
			// same resolve-before-withDb ordering as cli.ts's diff action.
			const appConfig = await resolveAppConfig(undefined);
			const outDir = appConfig?.outDir ?? DEFAULT_CONFIG.outDir;
			const dbPath = appConfig?.dbPath ?? DEFAULT_CONFIG.dbPath;
			const wwwEquivalent = appConfig?.wwwEquivalent ?? true;
			const report = withDb(dbPath, (db) =>
				computeDiff(db, args.shortIdA, args.shortIdB, outDir, wwwEquivalent),
			);
			// html generation is the diff tool's last step, same as cli.ts.
			const htmlPath = generateReport(outDir, args.shortIdA, args.shortIdB);
			return jsonResult({ ...report, htmlPath });
		},
	);

	server.registerTool(
		"config_init",
		{
			description: "Write a new config file",
			inputSchema: {
				config: z.string().optional(),
				force: z.boolean().optional(),
			},
		},
		async (args) =>
			jsonResult(await initConfigFile(insideCwd(args.config), args.force)),
	);

	server.registerTool(
		"config",
		{
			description:
				"Show the whole config-file tree (field/value/source/valid rows)",
			inputSchema: { config: z.string().optional() },
		},
		async (args) => {
			const raw = await resolveConfigCmdRaw(insideCwd(args.config));
			return jsonResult(buildConfigTreeRows(raw));
		},
	);

	server.registerTool(
		"worker_start",
		{
			description: "Ensure a worker is running (always spawns detached)",
			inputSchema: {},
		},
		// always detached — a foreground/blocking worker would hang this
		// tool call forever, so `startWorkerForeground` is never an option here.
		() => jsonResult(ensureWorkerRunning(DEFAULT_CONFIG.dbPath)),
	);

	server.registerTool(
		"worker_stop",
		{ description: "Stop the running worker (SIGTERM)", inputSchema: {} },
		() => jsonResult(stopWorker(DEFAULT_CONFIG.dbPath)),
	);

	server.registerTool(
		"worker_status",
		{ description: "Queue counts + worker PID/liveness", inputSchema: {} },
		() => jsonResult(workerStatusReport(DEFAULT_CONFIG.dbPath)),
	);

	return server;
}

export async function startMcpServer(): Promise<void> {
	const server = createMcpServer();
	await server.connect(new StdioServerTransport());
}
