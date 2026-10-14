import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getSnapshotByShortId } from "./db.ts";

export interface HarHeader {
	name: string;
	value: string;
}

interface HarEntry {
	_resourceType: string;
	request: { url: string };
	response: { content: { size: number }; headers: HarHeader[] };
}

interface HarLog {
	log: {
		pages: Array<{ pageTimings: { onLoad: number } }>;
		entries: HarEntry[];
	};
}

export interface StatsResource {
	host: string;
	path: string;
	type: string;
	sizeBytes: number;
	headers: Record<string, string[]>;
}

export interface StatsResult {
	loadTimeMs: number | null;
	totalBytes: number;
	domSizeBytes: number;
	screenshot: { width: number; height: number };
	resources: StatsResource[];
}

// PNG IHDR width/height live at fixed byte offsets 16-23 (big-endian
// u32 each) — reading just those bytes avoids a full-file read/decode and
// keeps this dims-only check dependency-free.
function readPngDims(path: string): { width: number; height: number } {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(24);
		readSync(fd, buf, 0, 24, 0);
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	} finally {
		closeSync(fd);
	}
}

// exported: reused by diff.ts's HAR-resources section, which reads
// capture.har directly (not thru stats.json's resources[] — see plan's
// Context note on the query-field gap).
export function groupHarHeaders(
	headers: HarHeader[],
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const h of headers) {
		const key = h.name.toLowerCase();
		if (!out[key]) out[key] = [];
		out[key].push(h.value);
	}
	return out;
}

// resolves shortId thru getSnapshotByShortId (unknown ->
// throw), sums/reads HAR fields with the -1-sentinel guards, writes
// ${outputDir}/stats.json, and returns the same object (avoids a redundant
// re-read for ensureStats's lazy-reuse path).
export function generateStats(db: DatabaseSync, shortId: string): StatsResult {
	const row = getSnapshotByShortId(db, shortId);
	if (!row) throw new Error(`unknown shortId: ${shortId}`);
	const outputDir = row.output_dir;

	return generateStatsForOutputDir(outputDir);
}

// split out so tests can drive it against a hand-built fixture outputDir
// without needing a full db round-trip.
export function generateStatsForOutputDir(outputDir: string): StatsResult {
	const har = JSON.parse(
		readFileSync(join(outputDir, "capture.har"), "utf8"),
	) as HarLog;

	const onLoad = har.log.pages[0]?.pageTimings.onLoad ?? -1;
	const loadTimeMs = onLoad >= 0 ? onLoad : null;

	let totalBytes = 0;
	const resources: StatsResource[] = har.log.entries.map((entry) => {
		const size = entry.response.content.size;
		if (size >= 0) totalBytes += size;
		const u = new URL(entry.request.url);
		return {
			host: u.hostname,
			path: u.pathname,
			type: entry._resourceType,
			sizeBytes: size,
			headers: groupHarHeaders(entry.response.headers),
		};
	});

	const domSizeBytes = statSync(join(outputDir, "dom.html")).size;
	const screenshot = readPngDims(join(outputDir, "screenshot.png"));

	const stats: StatsResult = {
		loadTimeMs,
		totalBytes,
		domSizeBytes,
		screenshot,
		resources,
	};
	writeFileSync(join(outputDir, "stats.json"), JSON.stringify(stats, null, 2));
	return stats;
}

// reuse an already-written stats.json as-is (snapshot files are
// immutable post-capture) — only a missing file triggers generation.
export function ensureStats(db: DatabaseSync, shortId: string): StatsResult {
	const row = getSnapshotByShortId(db, shortId);
	if (!row) throw new Error(`unknown shortId: ${shortId}`);
	const statsPath = join(row.output_dir, "stats.json");
	if (existsSync(statsPath)) {
		return JSON.parse(readFileSync(statsPath, "utf8")) as StatsResult;
	}
	return generateStatsForOutputDir(row.output_dir);
}
