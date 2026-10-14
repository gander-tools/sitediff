import { resolveHeadless } from "./browser.ts";
import { getNextQueuedSnapshot, openDb } from "./db.ts";
import type { BaseConfig, SettingsMeta, WorkerConfig } from "./pipeline.ts";
import { runCaptureForRow } from "./pipeline.ts";
import { clearWorkerPid, writeWorkerPid } from "./worker-pid.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkerLoopOptions {
	pollMs?: number;
	signal: AbortSignal;
}

// no direct `process.on(SIGTERM)` here (same split as the worker command, one level further:
// cli.ts wires the OS signal to an AbortController, this stays pure/testable
// w/o real signals) — loop checks `signal.aborted` only BETWEEN jobs, so a
// job already picked up always finishes (worker "finishes in-flight job,
// doesn't pick up a new one before exit").
export async function runWorkerLoop(
	dbPath: string,
	worker: WorkerConfig,
	opts: WorkerLoopOptions,
): Promise<void> {
	const { signal } = opts;
	// ⊥ env fallback anymore — hardcoded 1000ms default.
	const pollMs = opts.pollMs ?? 1000;
	const timeoutMs = worker.timeout;

	writeWorkerPid(dbPath, process.pid);
	try {
		let idleSince: number | undefined;
		while (!signal.aborted) {
			const db = openDb(dbPath);
			const row = getNextQueuedSnapshot(db);
			db.close();

			if (!row) {
				if (timeoutMs >= 0) {
					idleSince ??= Date.now();
					if (Date.now() - idleSince >= timeoutMs) {
						// re-check right before actually exiting — closes the race
						// where a concurrent enqueue's ensureWorkerRunning sees this
						// still-alive-but-exiting pid as "already running", skips
						// spawning a replacement, and the just-inserted row is never
						// picked up until a human runs `worker start` manually.
						const recheckDb = openDb(dbPath);
						const recheckRow = getNextQueuedSnapshot(recheckDb);
						recheckDb.close();
						if (!recheckRow) break;
						idleSince = undefined;
						continue;
					}
				}
				await sleep(pollMs);
				continue;
			}
			idleSince = undefined;

			const { config: jobConfig, meta } = JSON.parse(
				row.job_payload ?? "{}",
			) as { config: BaseConfig; meta?: SettingsMeta };
			await runCaptureForRow(row, jobConfig, resolveHeadless(undefined), meta);
		}
	} finally {
		clearWorkerPid(dbPath);
	}
}
