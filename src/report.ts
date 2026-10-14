import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ConsoleGroupDiff,
	DiffReport,
	HarResourcePaired,
	HarResourceUnmatched,
	RedirectHopDiff,
} from "./diff.ts";

const PICO_CSS_CDN =
	"https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css";

// every string sourced from a captured (untrusted, arbitrary target site)
// page must be entity-escaped before landing in the HTML template —
// harResources url/headers, console type/text, redirect hop urls. Numbers/
// booleans (byte counts, verdicts, pixelDiffCount) are never user-controlled
// strings and are interpolated raw.
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// bare table, no own <details> — the entry-level <details> in
// unmatchedSection is the sole collapse point (double-wrapping was redundant).
function headersToHtml(headers: Record<string, string[]>): string {
	const rows = Object.entries(headers)
		.map(
			([key, values]) =>
				`<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(values.join(", "))}</td></tr>`,
		)
		.join("");
	return `<table><tbody>${rows}</tbody></table>`;
}

// entry-level <details> gets a border-color accent — green for "added"
// (b-only), red for "removed" (a-only); the entry itself has no a/b pair to
// diff field-by-field, so per-field coloring doesn't apply here.
function harResourceRow(
	entry: HarResourceUnmatched["entry"],
	kind: "added" | "removed",
): string {
	const summary = `${escapeHtml(entry.url)} — ${escapeHtml(entry.type)} — ${entry.sizeBytes} bytes`;
	return `<details class="entry-${kind}"><summary>${summary}</summary>${headersToHtml(entry.headers)}</details>`;
}

const MISSING = "—";

// A/B diff table for a row's expanded detail — 4-state background
// coloring off the already-sentinel'd ("—" = missing side) a/b strings:
// missing in a + present in b = added (green); present in a + missing in b
// = removed (red); both present, different = changed (orange); equal = same
// (no background). Renders every row it's given, incl. keys a summary count
// elsewhere may deliberately exclude (e.g. `date`) — the table is the
// full raw picture, the count is the verdict-consistent one.
function diffRowClass(a: string, b: string): string {
	if (a === MISSING && b !== MISSING) return "diff-row-added";
	if (b === MISSING && a !== MISSING) return "diff-row-removed";
	if (a === b) return "diff-row-same";
	return "diff-row-changed";
}

function diffTableHtml(rows: [string, string, string][]): string {
	const trs = rows
		.map(([key, a, b]) => {
			const cls = diffRowClass(a, b);
			return `<tr class="${cls}"><td>${escapeHtml(key)}</td><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`;
		})
		.join("");
	return `<table><thead><tr><th>field</th><th>a</th><th>b</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function headerDiffRows(
	a: Record<string, string[]>,
	b: Record<string, string[]>,
): [string, string, string][] {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	return keys.map((key) => [
		key,
		(a[key] ?? ["—"]).join(", "),
		(b[key] ?? ["—"]).join(", "),
	]);
}

// paired a/b never carry their own url (diff.ts PairedHarResourceEntry) -
// the pair's `url` (path) is the only identity, for both sides.
// flat top-level <details>, ⊥ nested in a table cell — a <table>
// inside a <td> widened its column sideways on expand instead of the row
// growing downward. Closed <summary> shows the verdict-consistent
// headerDiffCount (diff.ts) — ⊥ recomputed here from the raw table
// below, which stays independent (may show a differing row, e.g. `date`,
// that the count deliberately excludes).
function harResourcePairedRow(p: HarResourcePaired): string {
	const rows: [string, string, string][] = [
		["type", p.a.type, p.b.type],
		["size", String(p.a.sizeBytes), String(p.b.sizeBytes)],
		...headerDiffRows(p.a.headers, p.b.headers),
	];
	const summary = `${escapeHtml(p.url)} — ${p.verdict} — ${p.headerDiffCount} headers differ`;
	return `<details><summary>${summary}</summary>${diffTableHtml(rows)}</details>`;
}

function harResourcesSection(paired: HarResourcePaired[]): string {
	return paired.map(harResourcePairedRow).join("");
}

// flat top-level <details>, ⊥ nested in a table cell.
function unmatchedSection(
	entries: HarResourceUnmatched[],
	kind: "added" | "removed",
): string {
	return entries.map((e) => harResourceRow(e.entry, kind)).join("");
}

function consoleSection(groups: ConsoleGroupDiff[]): string {
	const rows = groups
		.map(
			(g) =>
				`<tr><td>${escapeHtml(g.type)}</td><td>${escapeHtml(g.text)}</td><td>${g.countA}</td><td>${g.countB}</td><td>${g.status}</td></tr>`,
		)
		.join("");
	return `<table><thead><tr><th>type</th><th>text</th><th>count a</th><th>count b</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// flat top-level <details>, ⊥ nested in a table cell (same fix as the paired
// rows). Closed <summary> shows `changed` only (⊥ a differing-field count —
// `changed` itself is pathname+status only, so a raw {url,method,status}
// count could contradict it, e.g. a method-only difference). A hop where a
// or b is entirely absent (added/removed hop) renders "—" for all 3 fields
// on that side.
function redirectHopRow(h: RedirectHopDiff): string {
	const rows: [string, string, string][] = [
		["url", h.a?.url ?? "—", h.b?.url ?? "—"],
		["method", h.a?.method ?? "—", h.b?.method ?? "—"],
		[
			"status",
			h.a?.status != null ? String(h.a.status) : "—",
			h.b?.status != null ? String(h.b.status) : "—",
		],
	];
	const summary = `#${h.index} — ${h.changed ? "changed" : "unchanged"}`;
	return `<details><summary>${summary}</summary>${diffTableHtml(rows)}</details>`;
}

function redirectsSection(hops: RedirectHopDiff[]): string {
	return hops.map(redirectHopRow).join("");
}

// one legend block, once, at the top of the report — explains terms
// that read as cryptic/wrong without codebase context. Static text, ⊥
// per-report data.
const LEGEND_HTML = `<details open>
<summary>Legend</summary>
<ul>
<li><strong>shotId</strong> — short id of one captured snapshot (a full page load + its HAR/DOM/console/screenshot); the URL next to it below is what was actually captured, host included.</li>
<li><strong>path match / url mismatch</strong> — comparisons in this report are host-agnostic by design (e.g. comparing a prod capture against a localhost capture is the normal case): <code>path match</code> is true when both snapshots' URL path is the same; <code>url mismatch</code> only appears when the paths differ, and is informational — it never blocks the diff.</li>
<li><strong>verdict: identical / changed</strong> — a paired item (HAR resource) whose content matches after stripping host differences.</li>
<li><strong>verdict: added / removed</strong> — an item present on only one side (b-only / a-only). In the Console section, this can also mean the SAME message appeared with a different status code or detail — grouping is by exact message text, so "status 400" and "status 404" count as two different messages (one removed, one added) rather than one changed message. This is deliberate, not a bug.</li>
</ul>
</details>`;

// img src is the basename only, derived from the shortIds — ⊥
// report.screenshot.diffImagePath verbatim, which is outDir-joined
// (src/diff.ts's diffScreenshots call site) and would double the path since
// the html/png land in the same directory side by side.
function screenshotSection(
	report: DiffReport,
	shortIdA: string,
	shortIdB: string,
): string {
	if (!report.screenshot) {
		return "<p>Screenshot dimensions differ — no image diff.</p>";
	}
	const imgFile = `diff-${shortIdA}-${shortIdB}.png`;
	return `<p>Pixel diff count: ${report.screenshot.pixelDiffCount}</p><details><summary>show image diff</summary><img src="${escapeHtml(imgFile)}" alt="screenshot diff"></details>`;
}

function reportHtml(
	report: DiffReport,
	shortIdA: string,
	shortIdB: string,
): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>sitediff report: ${escapeHtml(shortIdA)} vs ${escapeHtml(shortIdB)}</title>
<link rel="stylesheet" href="${PICO_CSS_CDN}">
<style>
:root{--pico-font-size:16px}
.diff-row-removed{background:#fee2e2}
.diff-row-added{background:#dcfce7}
.diff-row-changed{background:#ffedd5}
.diff-row-same{background:none}
.entry-added{border-left:4px solid #16a34a}
.entry-removed{border-left:4px solid #dc2626}
summary{padding:.35rem .75rem;background:rgba(128,128,128,.15);border-radius:var(--pico-border-radius);cursor:pointer}
</style>
</head>
<body>
<main class="container">
<h1>sitediff report: ${escapeHtml(shortIdA)} vs ${escapeHtml(shortIdB)}</h1>
${LEGEND_HTML}
<p>${escapeHtml(shortIdA)} → ${escapeHtml(report.urlA)}<br>${escapeHtml(shortIdB)} → ${escapeHtml(report.urlB)}</p>
<p>path match: ${report.pathMatch}${
		report.urlMismatch
			? ` | url mismatch: ${escapeHtml(report.urlMismatch.a)} vs ${escapeHtml(report.urlMismatch.b)}`
			: ""
	}</p>

<h2>Screenshot</h2>
${screenshotSection(report, shortIdA, shortIdB)}

<h2>DOM</h2>
<p>before: ${report.dom.before} bytes | after: ${report.dom.after} bytes | delta: ${report.dom.delta} | identical: ${report.dom.identical}</p>
<p>host-normalized before: ${report.dom.normalizedBefore} bytes | after: ${report.dom.normalizedAfter} bytes | delta: ${report.dom.normalizedDelta}</p>

<h2>HAR resources</h2>
<h3>paired</h3>
${harResourcesSection(report.harResources.paired)}
<h3>added</h3>
${unmatchedSection(report.harResources.added, "added")}
<h3>removed</h3>
${unmatchedSection(report.harResources.removed, "removed")}

<h2>Console</h2>
${consoleSection(report.console.groups)}

<h2>Redirects</h2>
<p>length a: ${report.redirects.lengthA} | length b: ${report.redirects.lengthB} | delta: ${report.redirects.lengthDelta}</p>
${redirectsSection(report.redirects.hops)}
</main>
</body>
</html>
`;
}

// reads an already-computed diff-<A>-<B>.json (⊥ recomputes, ⊥ touches the
// db), renders every DiffReport field 1:1, writes diff-<A>-<B>.html
// alongside it in the same outDir.
export function generateReport(
	outDir: string,
	shortIdA: string,
	shortIdB: string,
): string {
	const jsonPath = join(outDir, `diff-${shortIdA}-${shortIdB}.json`);
	if (!existsSync(jsonPath)) {
		throw new Error(
			`no diff report found at ${jsonPath} — run "sitediff diff ${shortIdA} ${shortIdB}" first`,
		);
	}
	const report = JSON.parse(readFileSync(jsonPath, "utf8")) as DiffReport;
	const htmlPath = join(outDir, `diff-${shortIdA}-${shortIdB}.html`);
	writeFileSync(htmlPath, reportHtml(report, shortIdA, shortIdB));
	return htmlPath;
}
