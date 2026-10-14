import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCliSync(args: string[], cwd: string) {
	try {
		const stdout = execFileSync(process.execPath, [cliPath, ...args], {
			encoding: "utf8",
			cwd,
		});
		return { stdout, status: 0 };
	} catch (err) {
		const e = err as { stdout: string; status: number };
		return { stdout: e.stdout, status: e.status };
	}
}

// async (not sync): `worker start -d` spawns a detached grandchild that
// outlives this call — an async wait keeps this process's event loop free
// while it happens, mirroring cli-capture-output.test.ts's rationale for
// the local http server sharing the process.
async function runCliAsync(args: string[], cwd: string) {
	const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
		encoding: "utf8",
		cwd,
	});
	return stdout;
}

// biome-ignore lint: control-char regex intentional for ANSI stripping
const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

// generous default: this file spawns real detached worker processes (each
// launching real chromium) — under a heavily loaded machine (whole suite's
// other files running concurrently, also launching real chromium), OS
// scheduling latency for a brand new process can legitimately exceed a
// tight timeout w/o anything actually being broken.
async function waitFor(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs = 60000,
): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
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

// list/stats/diff/worker ⊥ take a --config override — dbPath always
// resolves relative to cwd via DEFAULT_CONFIG, so every subprocess below
// runs w/ cwd pointed @ a fresh temp dir instead of threading env vars.
function isolatedDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("cli: worker status w/ nothing running -> zero counts, running=no, exit 0", () => {
	const dir = isolatedDir("sitediff-cli-worker-");
	try {
		const result = runCliSync(["worker", "status"], dir);
		assert.equal(result.status, 0);
		assert.match(stripAnsi(result.stdout), /running\s*│\s*no/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: worker status --json -> raw {counts,pid} JSON, not a table", () => {
	const dir = isolatedDir("sitediff-cli-worker-");
	try {
		const result = runCliSync(["worker", "status", "--json"], dir);
		assert.equal(result.status, 0);
		const parsed = JSON.parse(result.stdout);
		assert.deepEqual(parsed.counts, {
			queued: 0,
			pending: 0,
			completed: 0,
			error: 0,
		});
		assert.equal(parsed.pid, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: worker stop w/ nothing running -> clean message, exit 0 (idempotent)", () => {
	const dir = isolatedDir("sitediff-cli-worker-");
	try {
		const result = runCliSync(["worker", "stop"], dir);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /worker not running/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// retry:1 — real detached worker + real chromium E2E, one observed CI
// scheduling/GC-pause flake in 15+ runs, no recurrence, no bug found in
// worker.ts/pipeline.ts (sibling test using the same mechanism passed
// seconds later in the same failing run).
test("cli: worker start -d then capture --enqueue -> auto-picked-up, worker status reflects it, worker stop shuts it down", {
	retry: 1,
}, async () => {
	const dir = isolatedDir("sitediff-cli-worker-e2e-");
	try {
		const startOut = await runCliAsync(["worker", "start", "-d"], dir);
		assert.match(
			startOut,
			/worker started \(detached\)|worker already running/,
		);

		// polled, not a single sync check: under a heavily loaded machine (many
		// concurrent real-chromium tests across the suite), a status subprocess
		// can occasionally be slow to schedule — retry rather than assume the
		// first sample landed on time.
		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /running\s*│\s*yes/.test(stripAnsi(status));
		});

		const enqueueResult = runCliSync(
			["capture", `${baseUrl}/`, "--enqueue", "--json"],
			dir,
		);
		assert.equal(enqueueResult.status, 0);
		assert.equal(JSON.parse(enqueueResult.stdout).status, "queued");

		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /completed\s*│\s*1/.test(stripAnsi(status));
		});

		const stopOut = runCliSync(["worker", "stop"], dir);
		assert.equal(stopOut.status, 0);
		assert.match(stopOut.stdout, /worker stopped/);

		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /running\s*│\s*no/.test(stripAnsi(status));
		});
	} finally {
		runCliSync(["worker", "stop"], dir); // best-effort cleanup if a step failed mid-test
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: capture --enqueue --worker -> no prior `worker start` needed, job still gets processed (auto-ensure)", async () => {
	const dir = isolatedDir("sitediff-cli-worker-auto-");
	try {
		const preStatus = runCliSync(["worker", "status"], dir);
		assert.match(stripAnsi(preStatus.stdout), /running\s*│\s*no/);

		const enqueueResult = runCliSync(
			["capture", `${baseUrl}/`, "--enqueue", "--worker", "--json"],
			dir,
		);
		assert.equal(enqueueResult.status, 0);
		assert.equal(JSON.parse(enqueueResult.stdout).status, "queued");

		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /running\s*│\s*yes/.test(stripAnsi(status));
		});
		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /completed\s*│\s*1/.test(stripAnsi(status));
		});
	} finally {
		runCliSync(["worker", "stop"], dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: enqueue [file] w/o --worker flag -> worker.autostart default (true) still auto-starts it, job gets processed", async () => {
	const dir = isolatedDir("sitediff-cli-worker-autostart-");
	try {
		const preStatus = runCliSync(["worker", "status"], dir);
		assert.match(stripAnsi(preStatus.stdout), /running\s*│\s*no/);

		const urlFile = join(dir, "urls.txt");
		writeFileSync(urlFile, `${baseUrl}/\n`);
		const enqueueResult = runCliSync(["enqueue", urlFile], dir);
		assert.equal(enqueueResult.status, 0);
		assert.match(enqueueResult.stdout, /enqueued 1 url\(s\)/);

		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /running\s*│\s*yes/.test(stripAnsi(status));
		});
		await waitFor(() => {
			const status = runCliSync(["worker", "status"], dir).stdout;
			return /completed\s*│\s*1/.test(stripAnsi(status));
		});
	} finally {
		runCliSync(["worker", "stop"], dir);
		rmSync(dir, { recursive: true, force: true });
	}
});
