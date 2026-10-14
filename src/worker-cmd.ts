import { spawn } from "node:child_process";
import { appendFileSync, openSync } from "node:fs";
import { countSnapshotsByStatus, openDb, type SnapshotStatus } from "./db.ts";
import type { WorkerConfig } from "./pipeline.ts";
import { runWorkerLoop } from "./worker.ts";
import { readWorkerPid, writeWorkerPid } from "./worker-pid.ts";

// business logic behind `worker`/`worker start`/`worker stop`/`worker status`
// (cli.ts stays parse -> call -> print -> exit only).
// dbPath/worker taken as primitives (⊥ a whole BaseConfig) — worker lives on
// appConfig top-level only now, never part of the capture config.

export async function startWorkerForeground(
	dbPath: string,
	worker: WorkerConfig,
): Promise<void> {
	const controller = new AbortController();
	const onTerm = () => controller.abort();
	process.on("SIGTERM", onTerm);
	try {
		await runWorkerLoop(dbPath, worker, { signal: controller.signal });
	} finally {
		process.off("SIGTERM", onTerm);
	}
}

function workerErrLogPath(dbPath: string): string {
	return `${dbPath}.worker.err.log`;
}

// idempotent auto-start: no-op if a live worker already owns this dbPath's
// pidfile, else spawns a detached foreground worker process. Shared by
// `worker start -d` and `capture --worker`.
export function ensureWorkerRunning(dbPath: string): { started: boolean } {
	if (readWorkerPid(dbPath) !== undefined) return { started: false };

	const entry = process.argv[1];
	const errLogPath = workerErrLogPath(dbPath);
	// stderr goes to a real fd, not a Node pipe: a pipe needs this (parent)
	// process alive to relay it, but this process exits right after spawning
	// a *detached* child — an fd survives that and keeps a startup crash
	// (bad entry, module load error) from vanishing into nothing.
	const errFd = openSync(errLogPath, "a");
	// bare `worker` no longer aliases `worker start` — spell it out.
	const child = spawn(process.execPath, [entry, "worker", "start"], {
		detached: true,
		stdio: ["ignore", "ignore", errFd],
	});
	child.on("error", (err) => {
		appendFileSync(errLogPath, `spawn error: ${err.stack ?? err}\n`);
	});
	// the child writes its own pidfile once its loop starts (worker.ts); write
	// it here too so a `status`/`stop` call racing the child's own startup
	// still sees a pid immediately rather than a brief false-negative window.
	if (child.pid !== undefined) writeWorkerPid(dbPath, child.pid);
	child.unref();
	return { started: true };
}

export function stopWorker(dbPath: string): { stopped: boolean } {
	const pid = readWorkerPid(dbPath);
	if (pid === undefined) return { stopped: false };
	process.kill(pid, "SIGTERM");
	return { stopped: true };
}

export interface WorkerStatusReport {
	counts: Record<SnapshotStatus, number>;
	pid?: number;
}

export function workerStatusReport(dbPath: string): WorkerStatusReport {
	const db = openDb(dbPath);
	const counts = countSnapshotsByStatus(db);
	db.close();
	return { counts, pid: readWorkerPid(dbPath) };
}
