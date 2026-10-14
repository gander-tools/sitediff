import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { requireBin, runBin } from "./helpers.ts";

before(requireBin);

function run(args: string[], cwd: string): Promise<string> {
	return runBin(args, cwd);
}

// local (not tests/cli-worker.test.ts's own waitFor) — that one polls a
// different target (tsx source via runCliSync) and isn't exported; not worth
// a cross-directory (tests/ <-> tests/integration/) import for one helper.
async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("waitFor: timed out");
}

test("built dist/sitediff: worker start -d / status / stop lifecycle", async () => {
	const dir = mkdtempSync(
		join(tmpdir(), "sitediff-integration-worker-lifecycle-"),
	);
	try {
		const before = await run(["worker", "status"], dir);
		assert.match(before, /running[^\n]*no/);

		const startOut = await run(["worker", "start", "-d"], dir);
		assert.match(startOut, /started/);

		await waitFor(async () => {
			const status = await run(["worker", "status"], dir);
			return (
				/running[^\n]*yes/.test(status) && /worker pid[^\n]*\d/.test(status)
			);
		}, 10_000);

		const stopOut = await run(["worker", "stop"], dir);
		assert.match(stopOut, /stopped/);

		await waitFor(async () => {
			const status = await run(["worker", "status"], dir);
			return /running[^\n]*no/.test(status);
		}, 3_000);
	} finally {
		try {
			await run(["worker", "stop"], dir);
		} catch {
			// best-effort — must not leak a detached worker process on test failure
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
