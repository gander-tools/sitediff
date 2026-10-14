import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { insertSnapshot, openDb, type SnapshotStatus } from "../src/db.ts";
import {
	checkDiffCompat,
	computeDiff,
	diffConsole,
	diffDom,
	diffHarResources,
	diffRedirects,
	hostNormalizeUrl,
} from "../src/diff.ts";
import { ensureStats } from "../src/stats.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// full valid PNG (not just an IHDR-only stub) — diff.ts's screenshot section
// runs pngjs's real decoder, unlike stats.ts's IHDR-byte-only dims read.
function writeFixturePng(path: string, width: number, height: number): void {
	const png = new PNG({ width, height });
	png.data.fill(255);
	writeFileSync(path, PNG.sync.write(png));
}

interface HarEntryFixture {
	url: string;
	type?: string;
	sizeBytes?: number;
	headers?: Record<string, string>;
	bodyText?: string;
	encoding?: string;
}

function harFixture(entries: HarEntryFixture[], onLoad = 100): string {
	return JSON.stringify({
		log: {
			pages: [{ pageTimings: { onLoad } }],
			entries: entries.map((e) => ({
				_resourceType: e.type ?? "document",
				request: { url: e.url },
				response: {
					content: {
						size: e.sizeBytes ?? 10,
						...(e.bodyText !== undefined ? { text: e.bodyText } : {}),
						...(e.encoding !== undefined ? { encoding: e.encoding } : {}),
					},
					headers: Object.entries(e.headers ?? {}).map(([name, value]) => ({
						name,
						value,
					})),
				},
			})),
		},
	});
}

interface SnapshotFixtureOpts {
	status?: SnapshotStatus;
	url?: string;
	width?: number;
	height?: number;
	domHtml?: string;
	harEntries?: HarEntryFixture[];
	consoleEntries?: Array<{ type: string; text: string }>;
	redirects?: Array<{ url: string; method: string; status: number | null }>;
	skipFiles?: boolean;
}

function makeSnapshot(
	db: DatabaseSync,
	baseDir: string,
	name: string,
	opts: SnapshotFixtureOpts = {},
): { shortId: string; outputDir: string } {
	const outputDir = join(baseDir, name);
	mkdirSync(outputDir);
	const status = opts.status ?? "completed";
	if (!opts.skipFiles) {
		writeFileSync(join(outputDir, "dom.html"), opts.domHtml ?? "<html></html>");
		writeFixturePng(
			join(outputDir, "screenshot.png"),
			opts.width ?? 1920,
			opts.height ?? 1080,
		);
		writeFileSync(
			join(outputDir, "capture.har"),
			harFixture(opts.harEntries ?? [{ url: "https://example.com/" }]),
		);
		writeFileSync(
			join(outputDir, "console.json"),
			JSON.stringify(opts.consoleEntries ?? []),
		);
		writeFileSync(
			join(outputDir, "redirects.json"),
			JSON.stringify(opts.redirects ?? []),
		);
	}
	const shortId = insertSnapshot(db, {
		url: opts.url ?? "https://example.com/",
		timestamp: "2026-07-27T00:00:00.000Z",
		outputDir,
		status,
	});
	return { shortId, outputDir };
}

function withFixtureDb<T>(fn: (db: DatabaseSync, dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-diff-"));
	const db = openDb(join(dir, "test.sqlite"));
	try {
		return fn(db, dir);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("hostNormalizeUrl: replaces only the URL host, leaves a path segment equal to the host untouched", () => {
	const result = hostNormalizeUrl(
		"https://www.example.com/foo/example.com/bar",
		"www.example.com",
		"other.com",
	);
	assert.equal(result, "https://__HOST__/foo/example.com/bar");
});

test("hostNormalizeUrl: host+port form, path segment equal to bare host untouched", () => {
	const result = hostNormalizeUrl(
		"https://localhost:8888/foo/localhost/bar",
		"localhost:8888",
		"other.com",
	);
	assert.equal(result, "https://__HOST__/foo/localhost/bar");
});

test("hostNormalizeUrl: url whose host matches neither side is left unchanged", () => {
	const result = hostNormalizeUrl(
		"https://cdn.other.com/lib.js",
		"example.com",
		"www.example.com",
	);
	assert.equal(result, "https://cdn.other.com/lib.js");
});

test("checkDiffCompat: both completed, matching dims -> ok, screenshotDimsMatch true", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		const compat = checkDiffCompat(db, a.shortId, b.shortId);
		assert.equal(compat.screenshotDimsMatch, true);
		assert.equal(compat.urlMismatch, undefined);
	});
});

test("checkDiffCompat: unknown shortId throws", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a");
		assert.throws(
			() => checkDiffCompat(db, a.shortId, "nonexistent"),
			/unknown shortId/,
		);
	});
});

test("checkDiffCompat: pending snapshot refused with distinct message, before any file read", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			status: "pending",
			skipFiles: true, // proves the throw happens before file access
		});
		const b = makeSnapshot(db, dir, "b");
		assert.throws(
			() => checkDiffCompat(db, a.shortId, b.shortId),
			/still pending/,
		);
	});
});

test("checkDiffCompat: error snapshot refused with distinct message, before any file read", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			status: "error",
			skipFiles: true,
		});
		const b = makeSnapshot(db, dir, "b");
		assert.throws(
			() => checkDiffCompat(db, a.shortId, b.shortId),
			/capture ended in error/,
		);
	});
});

test("checkDiffCompat: screenshot dims mismatch -> screenshotDimsMatch false, does not throw", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { width: 1920, height: 1080 });
		const b = makeSnapshot(db, dir, "b", { width: 800, height: 600 });
		const compat = checkDiffCompat(db, a.shortId, b.shortId);
		assert.equal(compat.screenshotDimsMatch, false);
	});
});

test("checkDiffCompat: urlMismatch populated iff host|pathname differ", () => {
	withFixtureDb((db, dir) => {
		const same1 = makeSnapshot(db, dir, "same1", {
			url: "https://example.com/page",
		});
		const same2 = makeSnapshot(db, dir, "same2", {
			url: "https://example.com/page?x=1",
		});
		assert.equal(
			checkDiffCompat(db, same1.shortId, same2.shortId).urlMismatch,
			undefined,
		);

		const diffHost = makeSnapshot(db, dir, "diffhost", {
			url: "https://other.com/page",
		});
		const mismatch = checkDiffCompat(
			db,
			same1.shortId,
			diffHost.shortId,
		).urlMismatch;
		assert.deepEqual(mismatch, {
			a: "https://example.com/page",
			b: "https://other.com/page",
		});
	});
});

test("diffDom: before/after/delta from stats", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { domHtml: "<a></a>" });
		const b = makeSnapshot(db, dir, "b", { domHtml: "<a>longer content</a>" });
		const statsA = ensureStats(db, a.shortId);
		const statsB = ensureStats(db, b.shortId);
		const dom = diffDom(
			statsA,
			statsB,
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		assert.equal(dom.before, "<a></a>".length);
		assert.equal(dom.after, "<a>longer content</a>".length);
		assert.equal(dom.delta, dom.after - dom.before);
	});
});

test("diffDom: identical true for dom.html equal except host string", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			domHtml: '<a href="https://localhost:8001/x">link</a>',
		});
		const b = makeSnapshot(db, dir, "b", {
			domHtml: '<a href="https://www.example.com/x">link</a>',
		});
		const statsA = ensureStats(db, a.shortId);
		const statsB = ensureStats(db, b.shortId);
		const dom = diffDom(
			statsA,
			statsB,
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(dom.identical, true);
	});
});

test("diffDom: normalizedBefore/normalizedAfter/normalizedDelta reflect host-stripped byte length, distinct from raw before/after/delta", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			domHtml: '<a href="https://localhost:8001/x">link</a>',
		});
		const b = makeSnapshot(db, dir, "b", {
			domHtml: '<a href="https://www.example.com/x">link</a>',
		});
		const statsA = ensureStats(db, a.shortId);
		const statsB = ensureStats(db, b.shortId);
		const dom = diffDom(
			statsA,
			statsB,
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.notEqual(dom.before, dom.after);
		assert.equal(dom.normalizedBefore, dom.normalizedAfter);
		assert.equal(dom.normalizedDelta, 0);
	});
});

test("diffHarResources: identical, changed, added, removed", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{ url: "https://example.com/same", sizeBytes: 10 },
				{ url: "https://example.com/changed", sizeBytes: 10 },
				{ url: "https://example.com/removed", sizeBytes: 5 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{ url: "https://example.com/same", sizeBytes: 10 },
				{ url: "https://example.com/changed", sizeBytes: 99 },
				{ url: "https://example.com/added", sizeBytes: 5 },
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		const verdictByPath = Object.fromEntries(
			result.paired.map((p) => [p.url, p.verdict]),
		);
		assert.equal(verdictByPath["/same"], "identical");
		assert.equal(verdictByPath["/changed"], "changed");
		assert.equal(result.added.length, 1);
		assert.equal(result.added[0].url, "https://example.com/added");
		assert.equal(result.removed.length, 1);
		assert.equal(result.removed[0].url, "https://example.com/removed");
	});
});

test("diffHarResources: same-URL repeats grouped and paired positionally", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{ url: "https://example.com/poll", sizeBytes: 1 },
				{ url: "https://example.com/poll", sizeBytes: 2 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{ url: "https://example.com/poll", sizeBytes: 1 },
				{ url: "https://example.com/poll", sizeBytes: 3 },
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		assert.equal(result.paired.length, 2);
		assert.equal(result.paired[0].verdict, "identical");
		assert.equal(result.paired[1].verdict, "changed");
	});
});

test("diffHarResources: header verdict ignores date, case-insensitively", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://example.com/x",
					sizeBytes: 10,
					headers: { Date: "Mon, 01 Jan 2026 00:00:00 GMT", "x-a": "1" },
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://example.com/x",
					sizeBytes: 10,
					headers: { date: "Tue, 02 Jan 2026 00:00:00 GMT", "x-a": "1" },
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
		assert.equal(result.paired[0].headerDiffCount, 0);
	});
});

test("diffHarResources: headerDiffCount excludes date, counts real header diffs", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://example.com/x",
					sizeBytes: 10,
					headers: { Date: "Mon, 01 Jan 2026 00:00:00 GMT", "x-a": "1" },
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://example.com/x",
					sizeBytes: 10,
					headers: { date: "Tue, 02 Jan 2026 00:00:00 GMT", "x-a": "2" },
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		assert.equal(result.paired[0].verdict, "changed");
		assert.equal(result.paired[0].headerDiffCount, 1);
	});
});

test("diffHarResources: same pathname+query, different host -> paired, ⊥ added/removed", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{ url: "https://localhost:8001/build/app.js", sizeBytes: 10 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{ url: "https://www.example.com/build/app.js", sizeBytes: 10 },
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired.length, 1);
		assert.equal(result.paired[0].url, "/build/app.js");
		assert.equal(result.paired[0].verdict, "identical");
		assert.equal(result.added.length, 0);
		assert.equal(result.removed.length, 0);
	});
});

test("diffHarResources: body host-normalized before size verdict (raw sizeBytes differs only by host length)", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://localhost:8001/api/self",
					bodyText: '{"self":"https://localhost:8001/api/self"}',
					sizeBytes: 44,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: '{"self":"https://www.example.com/api/self"}',
					sizeBytes: 45,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffHarResources: host substring of other host doesn't corrupt normalization", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://example.com/api/self",
					bodyText: "host is example.com",
					sizeBytes: 20,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "host is www.example.com",
					sizeBytes: 24,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffHarResources: header values host-normalized before verdict", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://localhost:8001/redirecting",
					sizeBytes: 10,
					headers: { Location: "https://localhost:8001/target" },
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/redirecting",
					sizeBytes: 10,
					headers: { Location: "https://www.example.com/target" },
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffHarResources: regression guard - bare-host Set-Cookie Domain= attr (no URL scheme) still host-normalized after hostNormalize/hostNormalizeUrl split", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://localhost:8001/login",
					sizeBytes: 10,
					headers: { "Set-Cookie": "sid=x; Domain=localhost:8001; Path=/" },
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/login",
					sizeBytes: 10,
					headers: { "Set-Cookie": "sid=x; Domain=www.example.com; Path=/" },
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffHarResources: third-party entry w/ incidental hostA string in body compared raw, unaffected by host diff", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://cdn.other.com/lib.js",
					bodyText: "loaded from localhost:8001",
					sizeBytes: 27,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://cdn.other.com/lib.js",
					bodyText: "loaded from www.example.com",
					sizeBytes: 28,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "changed");
	});
});

test("diffHarResources: entry's own host is www.<hostA> -> counted first-party + normalized when wwwEquivalent true", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "loaded from www.example.com",
					sizeBytes: 28,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "loaded from example.com",
					sizeBytes: 23,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"other.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffHarResources: same www-variant setup, wwwEquivalent false -> stays third-party, raw compare", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "loaded from www.example.com",
					sizeBytes: 28,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "loaded from example.com",
					sizeBytes: 23,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"example.com",
			"other.com",
			false,
		);
		assert.equal(result.paired[0].verdict, "changed");
	});
});

test("diffHarResources: first-party entry w/ same host string still normalized", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			harEntries: [
				{
					url: "https://localhost:8001/api/self",
					bodyText: "loaded from localhost:8001",
					sizeBytes: 27,
				},
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			harEntries: [
				{
					url: "https://www.example.com/api/self",
					bodyText: "loaded from www.example.com",
					sizeBytes: 28,
				},
			],
		});
		const result = diffHarResources(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.paired[0].verdict, "identical");
	});
});

test("diffConsole: only reports groups whose count differs", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			consoleEntries: [
				{ type: "log", text: "same" },
				{ type: "error", text: "gone" },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			consoleEntries: [
				{ type: "log", text: "same" },
				{ type: "warn", text: "new" },
			],
		});
		const result = diffConsole(
			a.outputDir,
			b.outputDir,
			"example.com",
			"example.com",
		);
		const byText = Object.fromEntries(
			result.groups.map((g) => [g.text, g.status]),
		);
		assert.equal(byText.gone, "removed");
		assert.equal(byText.new, "added");
		assert.equal(byText.same, undefined);
	});
});

test("diffConsole: host-normalized text groups entries with only host difference as same key", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			url: "https://localhost:8001/",
			consoleEntries: [{ type: "log", text: "fetch from localhost:8001/api" }],
		});
		const b = makeSnapshot(db, dir, "b", {
			url: "https://www.example.com/",
			consoleEntries: [{ type: "log", text: "fetch from www.example.com/api" }],
		});
		const result = diffConsole(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.groups.length, 0);
	});
});

test("diffConsole: report text field is host-normalized", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			url: "https://localhost:8001/",
			consoleEntries: [{ type: "log", text: "loaded localhost:8001/x" }],
		});
		const b = makeSnapshot(db, dir, "b", { url: "https://www.example.com/" });
		const result = diffConsole(
			a.outputDir,
			b.outputDir,
			"localhost:8001",
			"www.example.com",
		);
		assert.equal(result.groups[0].text, "loaded __HOST__/x");
	});
});

test("computeDiff: pathMatch true for same path different host", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			url: "https://localhost:8001/page",
		});
		const b = makeSnapshot(db, dir, "b", {
			url: "https://www.example.com/page",
		});
		const report = computeDiff(db, a.shortId, b.shortId, dir);
		assert.equal(report.pathMatch, true);
		assert.equal(report.urlA, "https://localhost:8001/page");
		assert.equal(report.urlB, "https://www.example.com/page");
	});
});

test("computeDiff: urlA/urlB populated even when path matches (⊥ only on urlMismatch)", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { url: "https://example.com/same" });
		const b = makeSnapshot(db, dir, "b", { url: "https://example.com/same" });
		const report = computeDiff(db, a.shortId, b.shortId, dir);
		assert.equal(report.urlMismatch, undefined);
		assert.equal(report.urlA, "https://example.com/same");
		assert.equal(report.urlB, "https://example.com/same");
	});
});

test("computeDiff: harResources paired entries carry no per-side url; redirect hop url host-normalized on both sides; urlA/urlB stay raw", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			url: "https://localhost:8001/page",
			harEntries: [{ url: "https://localhost:8001/x", sizeBytes: 10 }],
			redirects: [
				{ url: "https://localhost:8001/page", method: "GET", status: 200 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			url: "https://www.example.com/page",
			harEntries: [{ url: "https://www.example.com/x", sizeBytes: 10 }],
			redirects: [
				{ url: "https://www.example.com/page", method: "GET", status: 200 },
			],
		});
		const report = computeDiff(db, a.shortId, b.shortId, dir);
		assert.equal(report.urlA, "https://localhost:8001/page");
		assert.equal(report.urlB, "https://www.example.com/page");
		assert.equal(report.harResources.paired[0].url, "/x");
		assert.ok(!("url" in report.harResources.paired[0].a));
		assert.ok(!("url" in report.harResources.paired[0].b));
		assert.equal(report.redirects.hops[0].a?.url, "https://__HOST__/page");
		assert.equal(report.redirects.hops[0].b?.url, "https://__HOST__/page");
	});
});

test("computeDiff: harResources added/removed 1st-party url gets host-normalized, 3rd-party stays raw", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			url: "https://localhost:8001/page",
			harEntries: [
				{ url: "https://localhost:8001/only-a", sizeBytes: 10 },
				{ url: "https://cdn.example.net/only-a-3p", sizeBytes: 10 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			url: "https://www.example.com/page",
			harEntries: [],
		});
		const report = computeDiff(db, a.shortId, b.shortId, dir);
		const removedUrls = report.harResources.removed.map((r) => r.entry.url);
		assert.ok(removedUrls.includes("https://__HOST__/only-a"));
		assert.ok(removedUrls.includes("https://cdn.example.net/only-a-3p"));
	});
});

test("computeDiff: pathMatch false for different path", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { url: "https://example.com/one" });
		const b = makeSnapshot(db, dir, "b", { url: "https://example.com/two" });
		const report = computeDiff(db, a.shortId, b.shortId, dir);
		assert.equal(report.pathMatch, false);
	});
});

test("diffRedirects: chain-length delta + per-hop positional compare", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			redirects: [
				{ url: "https://example.com/1", method: "GET", status: 301 },
				{ url: "https://example.com/2", method: "GET", status: 200 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			redirects: [{ url: "https://example.com/2", method: "GET", status: 200 }],
		});
		const result = diffRedirects(a.outputDir, b.outputDir);
		assert.equal(result.lengthA, 2);
		assert.equal(result.lengthB, 1);
		assert.equal(result.lengthDelta, -1);
		assert.equal(result.hops[0].changed, true);
		assert.equal(result.hops[1].changed, true);
	});
});

test("diffRedirects: same pathname, different host -> hop unchanged", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", {
			redirects: [
				{ url: "https://localhost:8001/page", method: "GET", status: 301 },
			],
		});
		const b = makeSnapshot(db, dir, "b", {
			redirects: [
				{ url: "https://www.example.com/page", method: "GET", status: 301 },
			],
		});
		const result = diffRedirects(a.outputDir, b.outputDir);
		assert.equal(result.hops[0].changed, false);
	});
});

test("computeDiff: full report, writes diff-<A>-<B>.json and .png, screenshot present when dims match", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			const report = computeDiff(db, a.shortId, b.shortId, dir);
			assert.ok(report.screenshot);
			assert.equal(report.screenshot?.pixelDiffCount, 0);
			assert.ok(existsSync(join(dir, `diff-${a.shortId}-${b.shortId}.json`)));
			assert.ok(existsSync(join(dir, `diff-${a.shortId}-${b.shortId}.png`)));
			const written = JSON.parse(
				readFileSync(join(dir, `diff-${a.shortId}-${b.shortId}.json`), "utf8"),
			);
			assert.deepEqual(written.dom, report.dom);
		} finally {
			process.chdir(cwd);
		}
	});
});

test("computeDiff: screenshot dims mismatch -> report has no screenshot key, other sections still present", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { width: 1920, height: 1080 });
		const b = makeSnapshot(db, dir, "b", { width: 800, height: 600 });
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			const report = computeDiff(db, a.shortId, b.shortId, dir);
			assert.equal(report.screenshot, undefined);
			assert.ok(report.dom);
			assert.ok(report.harResources);
			assert.ok(report.console);
			assert.ok(report.redirects);
		} finally {
			process.chdir(cwd);
		}
	});
});

test("computeDiff: status-incomplete snapshot disqualifies the whole comparison", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a", { status: "error", skipFiles: true });
		const b = makeSnapshot(db, dir, "b");
		assert.throws(() => computeDiff(db, a.shortId, b.shortId, dir));
	});
});

test("computeDiff: running diff twice on the same pair doesn't rewrite either side's stats.json", () => {
	withFixtureDb((db, dir) => {
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			computeDiff(db, a.shortId, b.shortId, dir);
			const mtimeA1 = statSync(join(a.outputDir, "stats.json")).mtimeMs;
			const mtimeB1 = statSync(join(b.outputDir, "stats.json")).mtimeMs;

			computeDiff(db, a.shortId, b.shortId, dir);
			const mtimeA2 = statSync(join(a.outputDir, "stats.json")).mtimeMs;
			const mtimeB2 = statSync(join(b.outputDir, "stats.json")).mtimeMs;

			assert.equal(mtimeA1, mtimeA2);
			assert.equal(mtimeB1, mtimeB2);
		} finally {
			process.chdir(cwd);
		}
	});
});

test("cli: diff --json prints the full report to stdout, writes files under DEFAULT_CONFIG.outDir when no config file, exit 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-diff-cli-"));
	// ⊥ .sitediff.json present -> falls back to DEFAULT_CONFIG's
	// outDir/dbPath ("./output"/"./sitediff.sqlite"), resolved relative to cwd.
	const dbPath = join(dir, "sitediff.sqlite");
	const outDir = join(dir, "output");
	try {
		const db = openDb(dbPath);
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		db.close();

		const result = spawnSync(
			process.execPath,
			[cliPath, "diff", a.shortId, b.shortId, "--json"],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const lines = result.stdout.trim().split("\n");
		assert.ok(
			lines.some((l) =>
				l.includes(`output/diff-${a.shortId}-${b.shortId}.json`),
			),
		);
		assert.ok(
			lines.some((l) =>
				l.includes(`output/diff-${a.shortId}-${b.shortId}.png`),
			),
		);
		// diff's last step generates the html report too, folding `report` in.
		assert.ok(
			lines.some((l) =>
				l.includes(`output/diff-${a.shortId}-${b.shortId}.html`),
			),
		);
		const jsonLine = lines[lines.length - 1];
		const report = JSON.parse(jsonLine);
		assert.ok(report.dom);
		assert.ok(existsSync(join(outDir, `diff-${a.shortId}-${b.shortId}.json`)));
		assert.ok(existsSync(join(outDir, `diff-${a.shortId}-${b.shortId}.html`)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: diff fails (exit 1) when html generation fails, even though json/png already wrote", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-diff-cli-htmlfail-"));
	const dbPath = join(dir, "sitediff.sqlite");
	const outDir = join(dir, "output");
	try {
		const db = openDb(dbPath);
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		db.close();
		// pre-create the html write target as a directory — writeFileSync on it
		// throws EISDIR, simulating a generateReport failure after json/png wrote.
		mkdirSync(outDir, { recursive: true });
		mkdirSync(join(outDir, `diff-${a.shortId}-${b.shortId}.html`));

		const result = spawnSync(
			process.execPath,
			[cliPath, "diff", a.shortId, b.shortId],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.ok(existsSync(join(outDir, `diff-${a.shortId}-${b.shortId}.json`)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: diff resolves outDir/dbPath from cwd-discovered .sitediff.json when present", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-diff-cli-cfg-"));
	const outDir = join(dir, "custom-out");
	const dbPath = join(dir, "custom.sqlite");
	writeFileSync(
		join(dir, ".sitediff.json"),
		JSON.stringify({ outDir, dbPath }),
	);
	try {
		const db = openDb(dbPath);
		const a = makeSnapshot(db, dir, "a");
		const b = makeSnapshot(db, dir, "b");
		db.close();

		const result = spawnSync(
			process.execPath,
			[cliPath, "diff", a.shortId, b.shortId],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(
			result.stdout.includes(
				join(outDir, `diff-${a.shortId}-${b.shortId}.json`),
			),
		);
		assert.ok(existsSync(join(outDir, `diff-${a.shortId}-${b.shortId}.json`)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
