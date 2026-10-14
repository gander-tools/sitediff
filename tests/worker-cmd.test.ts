import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BaseConfig } from "../src/pipeline.ts";
import { ensureWorkerRunning } from "../src/worker-cmd.ts";

function tempConfig(): { config: BaseConfig; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-worker-cmd-"));
	return {
		dir,
		config: {
			outDir: join(dir, "output"),
			dbPath: join(dir, "sitediff.sqlite"),
			viewport: { width: 1920, height: 1080 },
			navTimeoutMs: 5000,
			maskSelectors: [],
			hideSelectors: [],
			dropSelectors: [],
		},
	};
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 10000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// the detached worker child is spawned with stdio fully ignored — if it
// crashes at startup (bad entry path, module load error, whatever), that
// error must land somewhere readable instead of vanishing, or a real
// production failure looks identical to "still starting up" forever.
test("ensureWorkerRunning: child crash at startup is captured to the worker err log, not swallowed silently", async () => {
	const { config, dir } = tempConfig();
	const originalArgv1 = process.argv[1];
	try {
		process.argv[1] = join(dir, "does-not-exist.ts");
		ensureWorkerRunning(config.dbPath);

		const errLogPath = `${config.dbPath}.worker.err.log`;
		let contents = "";
		await waitFor(() => {
			contents = existsSync(errLogPath) ? readFileSync(errLogPath, "utf8") : "";
			return contents.length > 0;
		});
		assert.match(contents, /does-not-exist/);
	} finally {
		process.argv[1] = originalArgv1;
		rmSync(dir, { recursive: true, force: true });
	}
});
