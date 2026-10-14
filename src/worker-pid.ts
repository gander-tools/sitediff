import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// keyed off dbPath, ⊥ outDir — 2 configs sharing a dbPath but pointing
// @ different outDirs must still collide onto the same worker/pidfile to
// keep the "1 worker proc = 1 op @ time, strictly serial" constraint.
function pidFilePath(dbPath: string): string {
	return `${dbPath}.worker.pid`;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// returns the live worker pid for this dbPath, or undefined — a stale
// pidfile (dead pid, or unparseable content) is deleted as a side effect.
export function readWorkerPid(dbPath: string): number | undefined {
	const path = pidFilePath(dbPath);
	if (!existsSync(path)) return undefined;
	const pid = Number(readFileSync(path, "utf8").trim());
	if (!Number.isInteger(pid) || !isAlive(pid)) {
		unlinkSync(path);
		return undefined;
	}
	return pid;
}

export function writeWorkerPid(dbPath: string, pid: number): void {
	writeFileSync(pidFilePath(dbPath), String(pid));
}

export function clearWorkerPid(dbPath: string): void {
	const path = pidFilePath(dbPath);
	if (existsSync(path)) unlinkSync(path);
}
