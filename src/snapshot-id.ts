import { randomUUID } from "node:crypto";

export function makeSnapshotId(now: Date = new Date()): string {
	const ts = now.toISOString().replace(/[:.]/g, "-");
	return `${ts}_${randomUUID()}`;
}
