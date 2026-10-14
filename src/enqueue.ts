import { join } from "node:path";
import { openDb, type SnapshotRow } from "./db.ts";
import type { BaseConfig, SettingsMeta, WorkerConfig } from "./pipeline.ts";
import { insertAndFetchSnapshot } from "./pipeline.ts";
import { makeSnapshotId } from "./snapshot-id.ts";
import { assertHttpUrl } from "./url-guard.ts";
import { ensureWorkerRunning } from "./worker-cmd.ts";

// pure decision, injectable — a TTY stdin with no `file` arg means
// there's nothing to read (interactive terminal, nobody piped input); reading
// it anyway is what throws the raw EAGAIN this replaces. Kept standalone (not
// inlined in cli.ts's action) so it has a direct unit test — spawnSync-based
// CLI integration tests can't simulate a TTY stdin to exercise this branch.
export function enqueueHasNoInput(
	file: string | undefined,
	stdinIsTTY: boolean | undefined,
): boolean {
	return file === undefined && stdinIsTTY === true;
}

// bulk version of insertQueuedSnapshot (pipeline.ts) — opens the db ONCE for
// the whole batch (⊥ reopening per url) and returns every inserted row
// (⊥ bare count — capture()'s --enqueue branch needs short_id/output_dir
// from the row it inserts). Insert-only besides the autostart call below —
// (an earlier rule: never touch worker-ensure) is superseded: autostart
// intentionally punches through that separation.
export function enqueueUrls(
	urls: string[],
	config: BaseConfig,
	worker: WorkerConfig,
	meta: SettingsMeta = {},
): SnapshotRow[] {
	for (const url of urls) assertHttpUrl(url);
	const collectionName = meta.collection?.name ?? null;
	const db = openDb(config.dbPath);
	let rows: SnapshotRow[];
	try {
		rows = urls.map((url) =>
			insertAndFetchSnapshot(
				db,
				{
					url,
					timestamp: new Date().toISOString(),
					outputDir: join(config.outDir, makeSnapshotId()),
					status: "queued",
					collection: collectionName,
					width: config.viewport.width,
					height: config.viewport.height,
					jobPayload: JSON.stringify({ config, meta }),
				},
				"enqueueUrls",
			),
		);
	} finally {
		db.close();
	}

	if (worker.autostart) ensureWorkerRunning(config.dbPath);

	return rows;
}
