import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { insertSnapshot, openDb } from "../src/db.ts";
import { createMcpServer } from "../src/mcp.ts";

// minimal completed-snapshot fixture — mirrors diff.test.ts's makeSnapshot,
// trimmed to the 1 shape needed here (default url/dims, no HAR entries).
function makeMinimalSnapshot(
	db: DatabaseSync,
	dir: string,
	name: string,
): { shortId: string; outputDir: string } {
	const outputDir = join(dir, name);
	mkdirSync(outputDir);
	writeFileSync(join(outputDir, "dom.html"), "<html></html>");
	const png = new PNG({ width: 100, height: 100 });
	png.data.fill(255);
	writeFileSync(join(outputDir, "screenshot.png"), PNG.sync.write(png));
	writeFileSync(
		join(outputDir, "capture.har"),
		JSON.stringify({
			log: {
				pages: [{ pageTimings: { onLoad: 100 } }],
				entries: [
					{
						_resourceType: "document",
						request: { url: "https://example.com/" },
						response: { content: { size: 10 }, headers: [] },
					},
				],
			},
		}),
	);
	writeFileSync(join(outputDir, "console.json"), "[]");
	writeFileSync(join(outputDir, "redirects.json"), "[]");
	const shortId = insertSnapshot(db, {
		url: "https://example.com/",
		timestamp: "2026-07-27T00:00:00.000Z",
		outputDir,
		status: "completed",
	});
	return { shortId, outputDir };
}

// real Client<->Server pair over an in-memory transport — exercises the same
// request/response path a real MCP client would, no stdio process needed.
async function connectedClient(): Promise<{
	client: Client;
	close: () => Promise<void>;
}> {
	const server = createMcpServer();
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0" });
	await Promise.all([
		client.connect(clientTransport),
		server.connect(serverTransport),
	]);
	return { client, close: () => client.close() };
}

test("mcp server: tool list is exactly the 11 CLI-mirroring tools, excludes config_creator/mcp/completion", async () => {
	const { client, close } = await connectedClient();
	try {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"capture",
			"config",
			"config_init",
			"diff",
			"enqueue",
			"list",
			"stats",
			"worker_start",
			"worker_status",
			"worker_stop",
		]);
		for (const excluded of [
			"config_creator",
			"config_add",
			"config_del",
			"config_remove",
			"config_set",
			"config_show",
			"config_validate",
			"mcp",
			"completion",
			"report",
		]) {
			assert.ok(!names.includes(excluded));
		}
	} finally {
		await close();
	}
});

test("mcp server: diff tool writes json+png AND html, returns htmlPath in its response", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-mcp-diff-"));
	const outDir = join(dir, "output");
	const dbPath = join(dir, "sitediff.sqlite");
	writeFileSync(
		join(dir, ".sitediff.json"),
		JSON.stringify({ outDir, dbPath }),
	);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		const db = openDb(dbPath);
		const a = makeMinimalSnapshot(db, dir, "a");
		const b = makeMinimalSnapshot(db, dir, "b");
		db.close();

		const { client, close } = await connectedClient();
		try {
			const result = await client.callTool({
				name: "diff",
				arguments: { shortIdA: a.shortId, shortIdB: b.shortId },
			});
			assert.equal(result.isError, undefined);
			const content = result.content as Array<{ type: string; text: string }>;
			const { htmlPath } = JSON.parse(content[0].text);
			const expectedHtmlPath = join(
				outDir,
				`diff-${a.shortId}-${b.shortId}.html`,
			);
			assert.equal(htmlPath, expectedHtmlPath);
			assert.ok(existsSync(expectedHtmlPath));
			assert.ok(
				existsSync(join(outDir, `diff-${a.shortId}-${b.shortId}.json`)),
			);
		} finally {
			await close();
		}
	} finally {
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mcp server: config_init force:true overwrites, config tool reports valid rows for it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-mcp-config-"));
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		const target = join(dir, ".sitediff.json");
		writeFileSync(target, JSON.stringify({ outDir: "./stale" }));
		const { client, close } = await connectedClient();
		try {
			const noForce = await client.callTool({
				name: "config_init",
				arguments: { config: target },
			});
			assert.equal(noForce.isError, true);

			const withForce = await client.callTool({
				name: "config_init",
				arguments: { config: target, force: true },
			});
			assert.equal(withForce.isError, undefined);
			const written = JSON.parse(readFileSync(target, "utf8"));
			assert.deepEqual(written.presets, {});
			assert.deepEqual(written.collections, {});

			const configResult = await client.callTool({
				name: "config",
				arguments: { config: dir },
			});
			assert.equal(configResult.isError, undefined);
			const content = configResult.content as Array<{
				type: string;
				text: string;
			}>;
			const { rows, valid } = JSON.parse(content[0].text);
			assert.equal(valid, true);
			assert.ok(rows.every((r: { valid: boolean }) => r.valid === true));
		} finally {
			await close();
		}
	} finally {
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mcp server: capture tool with enqueue:true calls the real capture() fn and returns queued-row JSON", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-mcp-"));
	const originalArgv1 = process.argv[1];
	const configPath = join(dir, ".sitediff.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			outDir: join(dir, "output"),
			dbPath: join(dir, "sitediff.sqlite"),
		}),
	);
	// worker.autostart defaults true, so enqueue's internal
	// ensureWorkerRunning would spawn using process.argv[1] as entry — same
	// re-run-this-test-file hazard documented in capture.test.ts. Point it at
	// a nonexistent path so the attempt fails immediately instead of forking.
	process.argv[1] = join(dir, "does-not-exist.ts");
	const cwd = process.cwd();
	process.chdir(dir);
	const { client, close } = await connectedClient();
	try {
		const result = await client.callTool({
			name: "capture",
			arguments: {
				url: "https://example.com/",
				enqueue: true,
				config: configPath,
			},
		});
		assert.equal(result.isError, undefined);
		const content = result.content as Array<{ type: string; text: string }>;
		assert.equal(content[0].type, "text");
		const parsed = JSON.parse(content[0].text);
		assert.equal(parsed.status, "queued");
		assert.ok(parsed.id);
	} finally {
		await close();
		process.chdir(cwd);
		process.argv[1] = originalArgv1;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mcp server: worker_start tool always spawns detached, never blocks the call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-mcp-worker-"));
	const originalArgv1 = process.argv[1];
	const originalCwd = process.cwd();
	// worker_start/stop/status take no config param — dbPath always
	// resolves relative to cwd via DEFAULT_CONFIG.
	process.chdir(dir);
	// same technique as tests/worker-cmd.test.ts: point spawn's entry at a
	// nonexistent path so the attempt is observable (crash logged) without a
	// real worker process actually running, while proving the call itself
	// returned immediately (⊥ ever falls through to a foreground loop).
	process.argv[1] = join(dir, "does-not-exist.ts");
	const { client, close } = await connectedClient();
	try {
		const result = await client.callTool({
			name: "worker_start",
			arguments: {},
		});
		const content = result.content as Array<{ type: string; text: string }>;
		const parsed = JSON.parse(content[0].text);
		assert.equal(parsed.started, true);

		const errLogPath = join(dir, "sitediff.sqlite.worker.err.log");
		const start = Date.now();
		while (
			!existsSync(errLogPath) ||
			readFileSync(errLogPath, "utf8").length === 0
		) {
			if (Date.now() - start > 10000) throw new Error("waitFor: timed out");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.match(readFileSync(errLogPath, "utf8"), /does-not-exist/);
	} finally {
		await close();
		process.argv[1] = originalArgv1;
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mcp server: path arguments outside the working directory and non-http urls are refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-mcp-guard-"));
	const cwd = process.cwd();
	process.chdir(dir);
	const { client, close } = await connectedClient();
	try {
		const outside = join(tmpdir(), "sitediff-mcp-outside.json");
		for (const [name, args] of [
			["config_init", { config: outside, force: true }],
			["config", { config: outside }],
			["enqueue", { file: "/etc/passwd" }],
		] as const) {
			const result = await client.callTool({ name, arguments: args });
			assert.equal(result.isError, true, name);
		}
		// a symlink inside cwd that points outside must not be followed
		const outsideDir = mkdtempSync(join(tmpdir(), "sitediff-mcp-link-"));
		symlinkSync(outsideDir, join(dir, "link"));
		const viaLink = await client.callTool({
			name: "config_init",
			arguments: { config: join(dir, "link", "x.json") },
		});
		assert.equal(viaLink.isError, true);
		assert.equal(existsSync(join(outsideDir, "x.json")), false);
		rmSync(outsideDir, { recursive: true, force: true });
		const fileUrl = await client.callTool({
			name: "capture",
			arguments: { url: "file:///etc/passwd" },
		});
		assert.equal(fileUrl.isError, true);
	} finally {
		await close();
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	}
});
