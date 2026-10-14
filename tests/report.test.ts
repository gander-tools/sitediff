import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiffReport } from "../src/diff.ts";
import { generateReport } from "../src/report.ts";

function baseReport(overrides: Partial<DiffReport> = {}): DiffReport {
	return {
		urlA: "http://a.test/x",
		urlB: "http://b.test/x",
		pathMatch: true,
		dom: {
			before: 100,
			after: 120,
			delta: 20,
			identical: false,
			normalizedBefore: 100,
			normalizedAfter: 120,
			normalizedDelta: 20,
		},
		harResources: { paired: [], added: [], removed: [] },
		console: { groups: [] },
		redirects: { lengthA: 0, lengthB: 0, lengthDelta: 0, hops: [] },
		...overrides,
	};
}

function withOutDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-report-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("generateReport: throws a clear error when diff-<A>-<B>.json is missing", () => {
	withOutDir((dir) => {
		assert.throws(
			() => generateReport(dir, "aaa", "bbb"),
			/run "sitediff diff aaa bbb" first/,
		);
	});
});

test("generateReport: writes diff-<A>-<B>.html rendering every DiffReport field", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					urlMismatch: { a: "http://a.test/x", b: "http://b.test/y" },
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "changed",
								headerDiffCount: 0,
								a: {
									type: "script",
									sizeBytes: 10,
									headers: { "content-type": ["text/plain"] },
								},
								b: {
									type: "script",
									sizeBytes: 12,
									headers: { "content-type": ["text/plain"] },
								},
							},
						],
						added: [
							{
								url: "/new",
								entry: {
									url: "http://b.test/new",
									type: "script",
									sizeBytes: 5,
									headers: {},
								},
							},
						],
						removed: [],
					},
					console: {
						groups: [
							{
								type: "log",
								text: "hello",
								countA: 1,
								countB: 0,
								status: "removed",
							},
						],
					},
					redirects: {
						lengthA: 1,
						lengthB: 1,
						lengthDelta: 0,
						hops: [
							{
								index: 0,
								a: { url: "http://a.test/", method: "GET", status: 301 },
								b: { url: "http://b.test/", method: "GET", status: 301 },
								changed: false,
							},
						],
					},
				}),
				null,
				2,
			),
		);

		const htmlPath = generateReport(dir, "aaa", "bbb");
		assert.equal(htmlPath, join(dir, "diff-aaa-bbb.html"));
		const html = readFileSync(htmlPath, "utf8");

		assert.match(
			html,
			/url mismatch: http:\/\/a\.test\/x vs http:\/\/b\.test\/y/,
		);
		assert.match(html, /before: 100 bytes/);
		assert.match(html, /\/x/);
		assert.match(html, /\/new/);
		assert.match(html, /hello/);
		assert.match(html, /301/);
	});
});

test("generateReport: styles via a single Pico.css CDN link, ⊥ a bundled framework — 1 small inline <style> for diff-row colors is not a framework", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const linkMatches = [...html.matchAll(/<link[^>]*stylesheet[^>]*>/g)];
		assert.equal(linkMatches.length, 1);
		assert.match(linkMatches[0][0], /cdn\.jsdelivr\.net\/npm\/@picocss\/pico/);
		const styleMatches = [...html.matchAll(/<style/g)];
		assert.equal(styleMatches.length, 1);
	});
});

test("generateReport: escapes HTML-unsafe characters from captured-page data", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					console: {
						groups: [
							{
								type: "log",
								text: '<script>alert("x")</script>',
								countA: 1,
								countB: 0,
								status: "removed",
							},
						],
					},
					harResources: {
						paired: [],
						added: [
							{
								url: "/evil",
								entry: {
									url: 'http://b.test/"><script>alert(1)</script>',
									type: "script",
									sizeBytes: 1,
									headers: { "x-evil": ["<img src=x onerror=alert(1)>"] },
								},
							},
						],
						removed: [],
					},
				}),
			),
		);

		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.doesNotMatch(html, /<script>alert/);
		assert.doesNotMatch(html, /<img src=x onerror/);
		assert.match(html, /&lt;script&gt;alert/);
	});
});

test("generateReport: screenshot section shows the image (basename src, ⊥ diffImagePath verbatim) and pixel count when present; image collapsed by default, pixel count always visible", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					screenshot: {
						pixelDiffCount: 42,
						diffImagePath: join(dir, "diff-aaa-bbb.png"),
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /Pixel diff count: 42/);
		assert.match(html, /<img src="diff-aaa-bbb\.png"/);
		assert.doesNotMatch(html, new RegExp(dir.replaceAll("/", "\\/")));
		// pixel count sits outside/before the collapsed <details> wrapping the image
		const pixelIdx = html.indexOf("Pixel diff count: 42");
		const detailsIdx = html.indexOf("<details><summary>show image diff");
		const imgIdx = html.indexOf('<img src="diff-aaa-bbb.png"');
		assert.ok(pixelIdx < detailsIdx);
		assert.ok(detailsIdx < imgIdx);
	});
});

test("generateReport: screenshot section shows a note when screenshot is absent (dims mismatch)", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /dimensions differ/);
		assert.doesNotMatch(html, /<img/);
	});
});

test("generateReport: renders a legend explaining shotId/path match/verdicts", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /Legend/);
		assert.match(html, /shotId/);
		assert.match(html, /status code/);
	});
});

test("generateReport: header shows each shotId's full captured url", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					urlA: "https://a.test/page",
					urlB: "https://b.test/page",
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /aaa.*https:\/\/a\.test\/page/s);
		assert.match(html, /bbb.*https:\/\/b\.test\/page/s);
	});
});

test("generateReport: HAR paired table drops per-side url (redundant w/ path column), redirects table still shows per-side url", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					urlA: "https://a.test/page",
					urlB: "https://b.test/page",
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "changed",
								headerDiffCount: 0,
								a: {
									type: "script",
									sizeBytes: 10,
									headers: {},
								},
								b: {
									type: "script",
									sizeBytes: 12,
									headers: {},
								},
							},
						],
						added: [
							{
								url: "/new",
								entry: {
									url: "https://b.test/new",
									type: "script",
									sizeBytes: 5,
									headers: {},
								},
							},
						],
						removed: [],
					},
					redirects: {
						lengthA: 1,
						lengthB: 1,
						lengthDelta: 0,
						hops: [
							{
								index: 0,
								a: {
									url: "https://__HOST__/page",
									method: "GET",
									status: 200,
								},
								b: {
									url: "https://__HOST__/page",
									method: "GET",
									status: 200,
								},
								changed: false,
							},
						],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const harSection = html.slice(
			html.indexOf("<h2>HAR resources</h2>"),
			html.indexOf("<h2>Console</h2>"),
		);
		const pairedTable = harSection.slice(
			0,
			harSection.indexOf("<h3>added</h3>"),
		);
		const redirectsSection = html.slice(html.indexOf("<h2>Redirects</h2>"));
		// paired table: url cell dropped entirely (path column already covers it)
		assert.doesNotMatch(pairedTable, /__HOST__\/x/);
		assert.doesNotMatch(pairedTable, /a\.test\/x/);
		assert.doesNotMatch(pairedTable, /b\.test\/x/);
		assert.match(pairedTable, /<summary>\/x — /);
		// redirect hops: unaffected, still render per-side url
		assert.match(redirectsSection, /__HOST__\/page/);
		// added/removed sections keep the raw host — diagnostic value, unpaired
		assert.match(harSection, /b\.test\/new/);
	});
});

test("generateReport: DOM section shows host-normalized before/after/delta alongside raw", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					dom: {
						before: 63726,
						after: 112258,
						delta: 48532,
						identical: false,
						normalizedBefore: 63700,
						normalizedAfter: 63700,
						normalizedDelta: 0,
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /host-normalized before: 63700 bytes/);
		assert.match(html, /after: 63700 bytes/);
		assert.match(html, /delta: 0/);
	});
});

test("generateReport: HAR paired row collapsed into <details>, summary shows verdict + headerDiffCount; raw table still lists a header excluded from the count (e.g. date), missing-side key renders —", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "identical",
								headerDiffCount: 0,
								a: {
									type: "script",
									sizeBytes: 10,
									headers: {
										date: ["Mon, 01 Jan 2026 00:00:00 GMT"],
										"x-only-a": ["1"],
									},
								},
								b: {
									type: "script",
									sizeBytes: 10,
									headers: { date: ["Tue, 02 Jan 2026 00:00:00 GMT"] },
								},
							},
						],
						added: [],
						removed: [],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		// summary is verdict-consistent (headerDiffCount is the trusted, precomputed value)
		assert.match(
			html,
			/<summary>\/x — identical — 0 headers differ<\/summary>/,
		);
		// the raw table still shows the date row as differing, and the
		// a-only key as missing on b — independent of the summary count
		assert.match(
			html,
			/<tr class="diff-row-changed"><td>date<\/td><td>Mon, 01 Jan 2026 00:00:00 GMT<\/td><td>Tue, 02 Jan 2026 00:00:00 GMT<\/td><\/tr>/,
		);
		assert.match(
			html,
			/<tr class="diff-row-removed"><td>x-only-a<\/td><td>1<\/td><td>—<\/td><\/tr>/,
		);
	});
});

test("generateReport: HAR paired summary count matches a real headerDiffCount", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "changed",
								headerDiffCount: 2,
								a: { type: "script", sizeBytes: 10, headers: {} },
								b: { type: "script", sizeBytes: 10, headers: {} },
							},
						],
						added: [],
						removed: [],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /<summary>\/x — changed — 2 headers differ<\/summary>/);
	});
});

test("generateReport: HAR paired section has no parent <table> — flat sequential <details>, summary prefixed with path", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "changed",
								headerDiffCount: 1,
								a: { type: "script", sizeBytes: 10, headers: {} },
								b: { type: "script", sizeBytes: 12, headers: {} },
							},
						],
						added: [],
						removed: [],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const harSection = html.slice(
			html.indexOf("<h3>paired</h3>"),
			html.indexOf("<h3>added</h3>"),
		);
		assert.doesNotMatch(harSection, /<th>path<\/th>/);
		assert.doesNotMatch(harSection, /<th>details<\/th>/);
		assert.match(
			harSection,
			/<summary>\/x — changed — 1 headers differ<\/summary>/,
		);
	});
});

test("generateReport: HAR paired section with 0 pairs renders no orphaned markup", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const harSection = html.slice(
			html.indexOf("<h3>paired</h3>"),
			html.indexOf("<h3>added</h3>"),
		);
		assert.doesNotMatch(harSection, /<table>|<details>/);
	});
});

test("generateReport: redirects section has no parent <table> — flat sequential <details>, summary prefixed with index", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					redirects: {
						lengthA: 1,
						lengthB: 1,
						lengthDelta: 0,
						hops: [
							{
								index: 0,
								a: { url: "https://__HOST__/x", method: "GET", status: 301 },
								b: { url: "https://__HOST__/x", method: "GET", status: 301 },
								changed: false,
							},
						],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const redirectsSection = html.slice(html.indexOf("<h2>Redirects</h2>"));
		assert.doesNotMatch(redirectsSection, /<th>#<\/th>/);
		assert.match(redirectsSection, /<summary>#0 — unchanged<\/summary>/);
	});
});

test("generateReport: redirects section with 0 hops renders no orphaned markup", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const redirectsSection = html.slice(html.indexOf("<h2>Redirects</h2>"));
		assert.doesNotMatch(redirectsSection, /<details>/);
	});
});

test("generateReport: HAR added/removed entries are flat <details>, no parent <table>, headers table not double-wrapped", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [],
						added: [
							{
								url: "/new",
								entry: {
									url: "https://b.test/new",
									type: "script",
									sizeBytes: 5,
									headers: { "content-type": ["text/plain"] },
								},
							},
						],
						removed: [],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const addedSection = html.slice(
			html.indexOf("<h3>added</h3>"),
			html.indexOf("<h3>removed</h3>"),
		);
		assert.doesNotMatch(addedSection, /<table><thead>/);
		assert.match(
			addedSection,
			/<summary>https:\/\/b\.test\/new — script — 5 bytes<\/summary>/,
		);
		// headers table renders once inside the entry's <details>, not double-wrapped
		const detailsCount = (addedSection.match(/<details[ >]/g) ?? []).length;
		assert.equal(detailsCount, 1);
		assert.match(addedSection, /content-type/);
	});
});

test("generateReport: HAR added section with 0 entries renders no orphaned markup", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const addedSection = html.slice(
			html.indexOf("<h3>added</h3>"),
			html.indexOf("<h3>removed</h3>"),
		);
		assert.doesNotMatch(addedSection, /<table>|<details>/);
	});
});

test("generateReport: redirects row collapsed into <details>, summary is changed/unchanged only — no field count — method now rendered+diffed", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					redirects: {
						lengthA: 1,
						lengthB: 1,
						lengthDelta: 0,
						hops: [
							{
								index: 0,
								a: { url: "https://__HOST__/x", method: "GET", status: 301 },
								b: { url: "https://__HOST__/x", method: "POST", status: 301 },
								changed: false,
							},
						],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const redirectsSection = html.slice(html.indexOf("<h2>Redirects</h2>"));
		assert.match(redirectsSection, /<summary>#0 — unchanged<\/summary>/);
		assert.doesNotMatch(redirectsSection, /differ/);
		assert.match(
			redirectsSection,
			/<tr class="diff-row-changed"><td>method<\/td><td>GET<\/td><td>POST<\/td><\/tr>/,
		);
	});
});

test("generateReport: diffTableHtml 4-state coloring — same/added/removed/changed", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [
							{
								url: "/x",
								verdict: "changed",
								headerDiffCount: 1,
								a: {
									type: "script",
									sizeBytes: 10,
									headers: {
										same: ["1"],
									},
								},
								b: {
									type: "script",
									sizeBytes: 10,
									headers: {
										same: ["1"],
										"only-b": ["2"],
									},
								},
							},
						],
						added: [],
						removed: [],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		// same: both present, equal -> no background state
		assert.match(
			html,
			/<tr class="diff-row-same"><td>same<\/td><td>1<\/td><td>1<\/td><\/tr>/,
		);
		// added: missing in a, present in b -> green
		assert.match(
			html,
			/<tr class="diff-row-added"><td>only-b<\/td><td>—<\/td><td>2<\/td><\/tr>/,
		);
	});
});

test("generateReport: HAR added entry gets a green border-accent class, removed entry gets red", () => {
	withOutDir((dir) => {
		writeFileSync(
			join(dir, "diff-aaa-bbb.json"),
			JSON.stringify(
				baseReport({
					harResources: {
						paired: [],
						added: [
							{
								url: "/new",
								entry: {
									url: "https://b.test/new",
									type: "script",
									sizeBytes: 5,
									headers: {},
								},
							},
						],
						removed: [
							{
								url: "/gone",
								entry: {
									url: "https://a.test/gone",
									type: "script",
									sizeBytes: 5,
									headers: {},
								},
							},
						],
					},
				}),
			),
		);
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		const addedSection = html.slice(
			html.indexOf("<h3>added</h3>"),
			html.indexOf("<h3>removed</h3>"),
		);
		const removedSection = html.slice(html.indexOf("<h3>removed</h3>"));
		assert.match(addedSection, /<details class="entry-added">/);
		assert.match(removedSection, /<details class="entry-removed">/);
	});
});

test("generateReport: every <summary> gets button-style CSS, base font-size fixed at 16px", () => {
	withOutDir((dir) => {
		writeFileSync(join(dir, "diff-aaa-bbb.json"), JSON.stringify(baseReport()));
		const html = readFileSync(generateReport(dir, "aaa", "bbb"), "utf8");
		assert.match(html, /summary\s*\{[^}]*\}/);
		assert.match(html, /--pico-font-size:\s*16px/);
	});
});
