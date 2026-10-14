import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// async execFile, not execFileSync: the local http server below lives in
// this same process, so a *sync* child-process wait would block the event
// loop and deadlock the child's request against it.
async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			[cliPath, ...args],
			{
				encoding: "utf8",
				env,
			},
		);
		return { stdout, status: 0 };
	} catch (err) {
		const e = err as { stdout: string; code: number };
		return { stdout: e.stdout, status: e.code };
	}
}

let server: Server;
let baseUrl: string;

before(async () => {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><body><h1>ok</h1></body></html>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address && typeof address === "object") {
		baseUrl = `http://127.0.0.1:${address.port}`;
	}
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("cli: capture <url> w/o --json -> table output, not JSON", async () => {
	const result = await runCli(["capture", baseUrl]);
	assert.equal(result.status, 0);
	assert.throws(() => JSON.parse(result.stdout));
	assert.match(result.stdout, /status/);
	assert.match(result.stdout, /completed/);
});

test("cli: capture <url> --json -> unchanged JSON output", async () => {
	const result = await runCli(["capture", baseUrl, "--json"]);
	assert.equal(result.status, 0);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.status, "completed");
});

test("cli: capture status row colored green when color supported, plain when NO_COLOR", async () => {
	const colored = await runCli(["capture", baseUrl], {
		...process.env,
		FORCE_COLOR: "1",
		NO_COLOR: undefined,
	});
	// biome-ignore lint: control-char regex intentional for ANSI detection
	assert.match(colored.stdout, /\x1b\[32m[^\n]*completed[^\n]*\x1b\[0m/);

	const plain = await runCli(["capture", baseUrl], {
		...process.env,
		FORCE_COLOR: undefined,
		NO_COLOR: "1",
	});
	// biome-ignore lint: control-char regex intentional for ANSI detection
	assert.doesNotMatch(plain.stdout, /\x1b\[32m/);
	assert.match(plain.stdout, /completed/);
});

test("cli: capture <url> --enqueue -> status=queued, exit 0, pipeline never runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-enqueue-"));
	try {
		// worker.autostart:false — this test asserts the pipeline never runs;
		// the (unrelated) default autostart would otherwise spawn a real
		// detached worker against a dbPath this test deletes right after
		// asserting, racing the worker's own startup.
		const configPath = join(dir, ".sitediff.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				outDir: join(dir, "output"),
				dbPath: join(dir, "sitediff.sqlite"),
				worker: { autostart: false, timeout: 30000 },
			}),
		);
		const result = await runCli([
			"capture",
			baseUrl,
			"--enqueue",
			"--json",
			"--config",
			configPath,
		]);
		assert.equal(result.status, 0);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.status, "queued");
		// capture()'s --enqueue branch delegates to enqueueUrls and must
		// still surface the inserted row's own id/outputDir, not just a count.
		assert.ok(parsed.id.length > 0);
		assert.ok(parsed.outputDir.length > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
