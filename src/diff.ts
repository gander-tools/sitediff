import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { getSnapshotByShortId, type SnapshotRow } from "./db.ts";
import {
	ensureStats,
	groupHarHeaders,
	type HarHeader,
	type StatsResult,
} from "./stats.ts";

export interface UrlMismatch {
	a: string;
	b: string;
}

interface CompatResult {
	rowA: SnapshotRow;
	rowB: SnapshotRow;
	statsA: StatsResult;
	statsB: StatsResult;
	urlMismatch?: UrlMismatch;
	screenshotDimsMatch: boolean;
}

function hostPathname(url: string): { host: string; pathname: string } {
	const u = new URL(url);
	return { host: u.hostname, pathname: u.pathname };
}

// pairing/comparison keys off pathname (+query for HAR resources), ⊥
// host — cross-host snapshots (e.g. localhost vs prod) compare meaningfully.
function pathnameOf(url: string): string {
	return new URL(url).pathname;
}

function pathnameQuery(url: string): string {
	const u = new URL(url);
	return u.pathname + u.search;
}

// full host incl. port (⊥ hostPathname's bare hostname) — body/header text
// embeds host:port together (e.g. "localhost:8001"), must strip as 1 unit.
export function fullHost(url: string): string {
	return new URL(url).host;
}

// longest host first, ⊥ naive sequential replace — avoids corrupting
// content when 1 host is a substring of the other (e.g. example.com vs
// www.example.com). Placeholder shared across both sides so post-normalize
// text (and derived byte length) matches whenever the real content matches.
const HOST_PLACEHOLDER = "__HOST__";

// www.<host> stripped/added to get the other form.
function wwwVariant(host: string): string {
	return host.startsWith("www.") ? host.slice(4) : `www.${host}`;
}

// candidate host strings for both sides, deduped — includes each side's
// www.<host>/bare-<host> counterpart when wwwEquivalent is on, so www and
// non-www count as the same host everywhere hosts are matched (hostNormalize,
// hostNormalizeUrl, isFirstParty).
function hostCandidates(
	hostA: string,
	hostB: string,
	wwwEquivalent: boolean,
): string[] {
	const base = [hostA, hostB];
	const variants = wwwEquivalent ? [wwwVariant(hostA), wwwVariant(hostB)] : [];
	return [...new Set([...base, ...variants])];
}

// used by diff.ts's verdict-computation call sites (body/header/console text)
// where a host mention w/o a URL scheme (JSON field, Set-Cookie Domain=,
// bare-host console text) must still normalize — broad match is deliberate,
// not a bug (see hostNormalizeUrl for the position-restricted counterpart
// used by report.ts's URL-display call sites).
export function hostNormalize(
	text: string,
	hostA: string,
	hostB: string,
	wwwEquivalent = true,
): string {
	const candidates = hostCandidates(hostA, hostB, wwwEquivalent).sort(
		(a, b) => b.length - a.length,
	);
	let out = text;
	for (const host of candidates) out = out.replaceAll(host, HOST_PLACEHOLDER);
	return out;
}

// normalizes exactly the host component of an absolute URL, ⊥ any other
// substring position (e.g. a path segment that happens to equal the host).
// Every call site's URLs are always absolute captured URLs, so a plain URL
// parse + exact-prefix replace is enough — no regex boundary-scan needed.
export function hostNormalizeUrl(
	url: string,
	hostA: string,
	hostB: string,
	wwwEquivalent = true,
): string {
	const u = new URL(url);
	if (!hostCandidates(hostA, hostB, wwwEquivalent).includes(u.host)) {
		return url;
	}
	const prefix = `${u.protocol}//${u.host}`;
	return `${u.protocol}//${HOST_PLACEHOLDER}${url.slice(prefix.length)}`;
}

// resolve both sides, refuse (throw) on unknown shortId or
// incomplete status BEFORE any file read — an error/pending snapshot may
// have partial/missing files, so reading stats pre-gate would surface a raw
// ENOENT instead of this clear message. urlMismatch is informational only
// (host|pathname compare) and never blocks the comparison.
function checkCompatGate(
	db: DatabaseSync,
	shortIdA: string,
	shortIdB: string,
): { rowA: SnapshotRow; rowB: SnapshotRow; urlMismatch?: UrlMismatch } {
	const rowA = getSnapshotByShortId(db, shortIdA);
	if (!rowA) throw new Error(`unknown shortId: ${shortIdA}`);
	const rowB = getSnapshotByShortId(db, shortIdB);
	if (!rowB) throw new Error(`unknown shortId: ${shortIdB}`);

	for (const [label, row] of [
		["A", rowA],
		["B", rowB],
	] as const) {
		if (row.status !== "completed") {
			const reason =
				row.status === "pending"
					? "snapshot incomplete: still pending"
					: "snapshot incomplete: capture ended in error";
			throw new Error(
				`cannot diff: snapshot ${label} (${row.short_id}) - ${reason}`,
			);
		}
	}

	const a = hostPathname(rowA.url);
	const b = hostPathname(rowB.url);
	const urlMismatch: UrlMismatch | undefined =
		a.host !== b.host || a.pathname !== b.pathname
			? { a: rowA.url, b: rowB.url }
			: undefined;

	return { rowA, rowB, urlMismatch };
}

// screenshot-compat gate compares actual pixel dims (read into
// stats.json's screenshot field, via IHDR byte-read), not
// config.viewport/DB width|height - fullPage:true capture means real dims
// diverge from viewport whenever page content height changes.
export function checkDiffCompat(
	db: DatabaseSync,
	shortIdA: string,
	shortIdB: string,
): CompatResult {
	const { rowA, rowB, urlMismatch } = checkCompatGate(db, shortIdA, shortIdB);
	const statsA = ensureStats(db, shortIdA);
	const statsB = ensureStats(db, shortIdB);
	const screenshotDimsMatch =
		statsA.screenshot.width === statsB.screenshot.width &&
		statsA.screenshot.height === statsB.screenshot.height;

	return { rowA, rowB, statsA, statsB, urlMismatch, screenshotDimsMatch };
}

export interface ScreenshotDiff {
	pixelDiffCount: number;
	diffImagePath: string;
}

// pngjs decodes both PNGs to raw RGBA buffers (pixelmatch operates on
// buffers only, never reads/writes .png files itself), pixelmatch diffs
// them, pngjs re-encodes the result - written to cwd (see plan's Context
// note on diff output location). Caller (computeDiff) only invokes this
// when checkDiffCompat's screenshotDimsMatch is true; dims mismatch drops
// the whole section instead (graceful degradation).
export function diffScreenshots(
	outputDirA: string,
	outputDirB: string,
	diffImagePath: string,
): ScreenshotDiff {
	const imgA = PNG.sync.read(readFileSync(join(outputDirA, "screenshot.png")));
	const imgB = PNG.sync.read(readFileSync(join(outputDirB, "screenshot.png")));
	const { width, height } = imgA;
	const diffImg = new PNG({ width, height });
	const pixelDiffCount = pixelmatch(
		imgA.data,
		imgB.data,
		diffImg.data,
		width,
		height,
		{ threshold: 0.1 },
	);
	writeFileSync(diffImagePath, PNG.sync.write(diffImg));
	return { pixelDiffCount, diffImagePath };
}

export interface DomDiff {
	before: number;
	after: number;
	delta: number;
	identical: boolean;
	normalizedBefore: number;
	normalizedAfter: number;
	normalizedDelta: number;
}

// domSizeBytes delta unchanged; gains `identical` - host-normalized dom.html
// text equality, alongside (⊥ replacing) the size-delta fields. Also
// gains normalized byte counts (before/after/delta of the SAME
// host-normalized text used for `identical`) so a raw delta can be told
// apart from pure host-string-length noise without a full HTML diff.
export function diffDom(
	statsA: StatsResult,
	statsB: StatsResult,
	outputDirA: string,
	outputDirB: string,
	hostA: string,
	hostB: string,
	wwwEquivalent = true,
): DomDiff {
	const htmlA = readFileSync(join(outputDirA, "dom.html"), "utf8");
	const htmlB = readFileSync(join(outputDirB, "dom.html"), "utf8");
	const normalizedA = hostNormalize(htmlA, hostA, hostB, wwwEquivalent);
	const normalizedB = hostNormalize(htmlB, hostA, hostB, wwwEquivalent);
	const normalizedBefore = Buffer.byteLength(normalizedA, "utf8");
	const normalizedAfter = Buffer.byteLength(normalizedB, "utf8");
	return {
		before: statsA.domSizeBytes,
		after: statsB.domSizeBytes,
		delta: statsB.domSizeBytes - statsA.domSizeBytes,
		identical: normalizedA === normalizedB,
		normalizedBefore,
		normalizedAfter,
		normalizedDelta: normalizedAfter - normalizedBefore,
	};
}

interface HarResourceEntry {
	url: string;
	type: string;
	sizeBytes: number;
	headers: Record<string, string[]>;
	bodyText: string | undefined;
	encoding: string | undefined;
}

interface HarEntryRaw {
	_resourceType: string;
	request: { url: string };
	response: {
		content: { size: number; text?: string; encoding?: string };
		headers: HarHeader[];
	};
}

// reads capture.har directly (not thru stats.json's trimmed resources[],
// which omits the query string needed for exact full-URL pairing here - see
// plan's Context note).
function readHarResources(outputDir: string): HarResourceEntry[] {
	const har = JSON.parse(
		readFileSync(join(outputDir, "capture.har"), "utf8"),
	) as { log: { entries: HarEntryRaw[] } };
	return har.log.entries.map((entry) => ({
		url: entry.request.url,
		type: entry._resourceType,
		sizeBytes: entry.response.content.size,
		headers: groupHarHeaders(entry.response.headers),
		bodyText: entry.response.content.text,
		encoding: entry.response.content.encoding,
	}));
}

// groups by pathname+query, ⊥ full url (host excluded from pairing key).
function groupByUrl(
	entries: HarResourceEntry[],
): Map<string, HarResourceEntry[]> {
	const groups = new Map<string, HarResourceEntry[]>();
	for (const entry of entries) {
		const key = pathnameQuery(entry.url);
		const list = groups.get(key);
		if (list) list.push(entry);
		else groups.set(key, [entry]);
	}
	return groups;
}

const IGNORED_HEADER_FOR_VERDICT = "date";

// header comparison for the identical/changed verdict ignores `date`
// case-insensitively (always varies per-request regardless of content,
// RFC 7231) - other headers compared byte-verbatim. Ignored differences are
// not hidden from the report, just excluded from the verdict.
function headerDiffKeys(
	a: Record<string, string[]>,
	b: Record<string, string[]>,
): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	keys.delete(IGNORED_HEADER_FOR_VERDICT);
	const diffs: string[] = [];
	for (const key of keys) {
		const av = a[key] ?? [];
		const bv = b[key] ?? [];
		if (av.length !== bv.length || av.some((v, i) => v !== bv[i])) {
			diffs.push(key);
		}
	}
	return diffs;
}

// an entry's body/header text is normalized only when the entry's OWN host
// is one of the 2 snapshot hosts (first-party) — a third-party entry (e.g.
// CDN resource) incidentally containing hostA|hostB in its text is left raw,
// so its own genuine cross-run differences aren't masked. Trade-off: a
// third-party entry referencing hostA/hostB itself may false-positive as
// "changed" - accepted.
// honors wwwEquivalent — www.<hostA>/www.<hostB> count as first-party
// too when enabled, else exact-equality only.
function isFirstParty(
	entry: HarResourceEntry,
	hostA: string,
	hostB: string,
	wwwEquivalent: boolean,
): boolean {
	const host = new URL(entry.url).host;
	return hostCandidates(hostA, hostB, wwwEquivalent).includes(host);
}

// header values host-normalized same as body text before the verdict
// compare — a Location/Link/Content-Location/Set-Cookie carrying an absolute
// host-qualified URL must not false-positive as "changed" across hosts.
function normalizeHeaderValues(
	entry: HarResourceEntry,
	hostA: string,
	hostB: string,
	wwwEquivalent: boolean,
): Record<string, string[]> {
	if (!isFirstParty(entry, hostA, hostB, wwwEquivalent)) return entry.headers;
	const out: Record<string, string[]> = {};
	for (const [key, values] of Object.entries(entry.headers)) {
		out[key] = values.map((v) => hostNormalize(v, hostA, hostB, wwwEquivalent));
	}
	return out;
}

// size verdict uses byte length of host-normalized body text, ⊥ raw HAR
// `content.size` — a host-string-length difference alone must not flip the
// verdict. base64 (binary) bodies, or entries w/ no captured body, skip
// normalization (unsafe/meaningless on binary data) and keep raw sizeBytes.
function bodyByteLengthForVerdict(
	entry: HarResourceEntry,
	hostA: string,
	hostB: string,
	wwwEquivalent: boolean,
): number {
	if (
		entry.encoding === "base64" ||
		entry.bodyText === undefined ||
		!isFirstParty(entry, hostA, hostB, wwwEquivalent)
	) {
		return entry.sizeBytes;
	}
	return Buffer.byteLength(
		hostNormalize(entry.bodyText, hostA, hostB, wwwEquivalent),
		"utf8",
	);
}

// bodyText/encoding exist only to compute the verdict (above) — ⊥ serialized
// into the report, which would embed every resource's full response body.
type PublicHarResourceEntry = Omit<HarResourceEntry, "bodyText" | "encoding">;

function toPublicEntry(entry: HarResourceEntry): PublicHarResourceEntry {
	const { bodyText: _bodyText, encoding: _encoding, ...rest } = entry;
	return rest;
}

// paired a/b never carry their own `url` — the pair's `url` (path,
// above) IS the identity for both sides; a per-side url here duplicated it
// (protocol/host is the only thing that could differ, not worth a field
// whose shape doesn't match the unmatched-entry `url` it sits next to).
type PairedHarResourceEntry = Omit<PublicHarResourceEntry, "url">;

function toPairedEntry(entry: HarResourceEntry): PairedHarResourceEntry {
	const { url: _url, ...rest } = toPublicEntry(entry);
	return rest;
}

export interface HarResourcePaired {
	url: string;
	verdict: "identical" | "changed";
	headerDiffCount: number;
	a: PairedHarResourceEntry;
	b: PairedHarResourceEntry;
}

export interface HarResourceUnmatched {
	url: string;
	entry: PublicHarResourceEntry;
}

export interface HarResourcesDiff {
	paired: HarResourcePaired[];
	added: HarResourceUnmatched[];
	removed: HarResourceUnmatched[];
}

// pairs by pathname+query, ⊥ host (cross-host snapshots pair
// meaningfully). Same-path repeats (e.g. polling XHR) grouped, paired
// positionally within the group (HAR entry order = request chronological
// order). Excess/missing entries within a group (or a path present only on
// one side) report as added/removed instead of being force-paired against
// something unrelated — added/removed keep the entry's own full url here
// (computeDiff host-normalizes it before writing JSON, same as paired);
// paired entries key on path only (host legitimately differs, uninteresting
// once paired).
export function diffHarResources(
	outputDirA: string,
	outputDirB: string,
	hostA: string,
	hostB: string,
	wwwEquivalent = true,
): HarResourcesDiff {
	const groupsA = groupByUrl(readHarResources(outputDirA));
	const groupsB = groupByUrl(readHarResources(outputDirB));
	const keys = new Set([...groupsA.keys(), ...groupsB.keys()]);

	const paired: HarResourcePaired[] = [];
	const added: HarResourceUnmatched[] = [];
	const removed: HarResourceUnmatched[] = [];

	for (const key of keys) {
		const listA = groupsA.get(key) ?? [];
		const listB = groupsB.get(key) ?? [];
		const pairCount = Math.min(listA.length, listB.length);
		for (let i = 0; i < pairCount; i++) {
			const a = listA[i];
			const b = listB[i];
			const sizesMatch =
				bodyByteLengthForVerdict(a, hostA, hostB, wwwEquivalent) ===
				bodyByteLengthForVerdict(b, hostA, hostB, wwwEquivalent);
			const normA = normalizeHeaderValues(a, hostA, hostB, wwwEquivalent);
			const normB = normalizeHeaderValues(b, hostA, hostB, wwwEquivalent);
			const headerDiffCount = headerDiffKeys(normA, normB).length;
			const headersMatch = headerDiffCount === 0;
			paired.push({
				url: key,
				verdict: sizesMatch && headersMatch ? "identical" : "changed",
				headerDiffCount,
				a: toPairedEntry(a),
				b: toPairedEntry(b),
			});
		}
		for (let i = pairCount; i < listA.length; i++) {
			removed.push({ url: listA[i].url, entry: toPublicEntry(listA[i]) });
		}
		for (let i = pairCount; i < listB.length; i++) {
			added.push({ url: listB[i].url, entry: toPublicEntry(listB[i]) });
		}
	}

	return { paired, added, removed };
}

interface ConsoleEntry {
	type: string;
	text: string;
}

export interface ConsoleGroupDiff {
	type: string;
	text: string;
	countA: number;
	countB: number;
	status: "added" | "removed" | "changed";
}

export interface ConsoleDiff {
	groups: ConsoleGroupDiff[];
}

// keyed by JSON.stringify([type,text]) - robust regardless of what
// characters appear in a console message's text.
function groupConsoleEntries(
	entries: ConsoleEntry[],
	hostA: string,
	hostB: string,
	wwwEquivalent: boolean,
): Map<string, { type: string; text: string; count: number }> {
	const groups = new Map<
		string,
		{ type: string; text: string; count: number }
	>();
	for (const entry of entries) {
		const text = hostNormalize(entry.text, hostA, hostB, wwwEquivalent);
		const key = JSON.stringify([entry.type, text]);
		const existing = groups.get(key);
		if (existing) existing.count++;
		else groups.set(key, { type: entry.type, text, count: 1 });
	}
	return groups;
}

// groups console.json entries by (type,text), reports only groups
// whose count differs between A and B (new/missing/count-changed) - no
// positional pairing (decided scope).
// text host-normalized (hostA/hostB -> shared placeholder) before
// grouping & before being written into the report, same helper as
// harResources/redirects.
export function diffConsole(
	outputDirA: string,
	outputDirB: string,
	hostA: string,
	hostB: string,
	wwwEquivalent = true,
): ConsoleDiff {
	const entriesA = JSON.parse(
		readFileSync(join(outputDirA, "console.json"), "utf8"),
	) as ConsoleEntry[];
	const entriesB = JSON.parse(
		readFileSync(join(outputDirB, "console.json"), "utf8"),
	) as ConsoleEntry[];
	const groupsA = groupConsoleEntries(entriesA, hostA, hostB, wwwEquivalent);
	const groupsB = groupConsoleEntries(entriesB, hostA, hostB, wwwEquivalent);
	const keys = new Set([...groupsA.keys(), ...groupsB.keys()]);

	const groups: ConsoleGroupDiff[] = [];
	for (const key of keys) {
		const countA = groupsA.get(key)?.count ?? 0;
		const countB = groupsB.get(key)?.count ?? 0;
		if (countA === countB) continue;
		const source = groupsA.get(key) ?? groupsB.get(key);
		const type = source ? source.type : "";
		const text = source ? source.text : "";
		const status =
			countA === 0 ? "added" : countB === 0 ? "removed" : "changed";
		groups.push({ type, text, countA, countB, status });
	}
	return { groups };
}

interface RedirectHopEntry {
	url: string;
	method: string;
	status: number | null;
}

export interface RedirectHopDiff {
	index: number;
	a?: RedirectHopEntry;
	b?: RedirectHopEntry;
	changed: boolean;
}

export interface RedirectsDiff {
	lengthA: number;
	lengthB: number;
	lengthDelta: number;
	hops: RedirectHopDiff[];
}

// redirects.json (both sides) treated as 1 sequence - chain-length
// delta + per-hop pathname (⊥ full url, host excluded)/status positional
// compare (decided scope); raw url still stored/shown in report per hop.
export function diffRedirects(
	outputDirA: string,
	outputDirB: string,
): RedirectsDiff {
	const chainA = JSON.parse(
		readFileSync(join(outputDirA, "redirects.json"), "utf8"),
	) as RedirectHopEntry[];
	const chainB = JSON.parse(
		readFileSync(join(outputDirB, "redirects.json"), "utf8"),
	) as RedirectHopEntry[];

	const maxLen = Math.max(chainA.length, chainB.length);
	const hops: RedirectHopDiff[] = [];
	for (let i = 0; i < maxLen; i++) {
		const a = chainA[i];
		const b = chainB[i];
		const changed =
			!a ||
			!b ||
			pathnameOf(a.url) !== pathnameOf(b.url) ||
			a.status !== b.status;
		hops.push({ index: i, a, b, changed });
	}

	return {
		lengthA: chainA.length,
		lengthB: chainB.length,
		lengthDelta: chainB.length - chainA.length,
		hops,
	};
}

export interface DiffReport {
	urlA: string;
	urlB: string;
	urlMismatch?: UrlMismatch;
	pathMatch: boolean;
	screenshot?: ScreenshotDiff;
	dom: DomDiff;
	harResources: HarResourcesDiff;
	console: ConsoleDiff;
	redirects: RedirectsDiff;
}

// outDir passed in by the caller (resolved BEFORE `withDb` opens the
// db — this fn stays fully synchronous, ⊥ `await` inside, so it never
// races `withDb`'s sync `finally`-close against a pending async callback).
// assembles every section into 1 report, writes
// diff-<A>-<B>.json under outDir. Graceful degradation: a status-incomplete
// snapshot disqualifies the whole comparison (thrown by checkDiffCompat,
// before this fn runs); a screenshot-dims mismatch only drops the
// `screenshot` key, every other section still runs.
export function computeDiff(
	db: DatabaseSync,
	shortIdA: string,
	shortIdB: string,
	outDir: string,
	wwwEquivalent = true,
): DiffReport {
	const compat = checkDiffCompat(db, shortIdA, shortIdB);
	const outputDirA = compat.rowA.output_dir;
	const outputDirB = compat.rowB.output_dir;
	const hostA = fullHost(compat.rowA.url);
	const hostB = fullHost(compat.rowB.url);

	const harResources = diffHarResources(
		outputDirA,
		outputDirB,
		hostA,
		hostB,
		wwwEquivalent,
	);
	// added/removed url normalized (host is noise once diffed); hostNormalizeUrl
	// only touches a URL whose host is exactly hostA/hostB (or www-variant), so
	// 3rd-party hosts (e.g. youtube.com, connect.facebook.net) stay raw -
	// genuinely diagnostic there, unlike a 1st-party host leak. paired entries
	// carry no per-side url at all - nothing to normalize there.
	for (const u of [...harResources.added, ...harResources.removed]) {
		u.url = hostNormalizeUrl(u.url, hostA, hostB, wwwEquivalent);
		u.entry.url = hostNormalizeUrl(u.entry.url, hostA, hostB, wwwEquivalent);
	}

	const redirects = diffRedirects(outputDirA, outputDirB);
	for (const hop of redirects.hops) {
		if (hop.a)
			hop.a.url = hostNormalizeUrl(hop.a.url, hostA, hostB, wwwEquivalent);
		if (hop.b)
			hop.b.url = hostNormalizeUrl(hop.b.url, hostA, hostB, wwwEquivalent);
	}

	const report: DiffReport = {
		urlA: compat.rowA.url,
		urlB: compat.rowB.url,
		urlMismatch: compat.urlMismatch,
		pathMatch: pathnameOf(compat.rowA.url) === pathnameOf(compat.rowB.url),
		dom: diffDom(
			compat.statsA,
			compat.statsB,
			outputDirA,
			outputDirB,
			hostA,
			hostB,
			wwwEquivalent,
		),
		harResources,
		console: diffConsole(outputDirA, outputDirB, hostA, hostB, wwwEquivalent),
		redirects,
	};

	mkdirSync(outDir, { recursive: true });

	if (compat.screenshotDimsMatch) {
		const diffImagePath = join(outDir, `diff-${shortIdA}-${shortIdB}.png`);
		report.screenshot = diffScreenshots(outputDirA, outputDirB, diffImagePath);
	}

	const jsonPath = join(outDir, `diff-${shortIdA}-${shortIdB}.json`);
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));

	return report;
}
