import { createHash, randomInt } from "node:crypto";
import { matchesGlob } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SnapshotStatus = "pending" | "completed" | "error" | "queued";

export interface SnapshotRow {
	id: number;
	url: string;
	timestamp: string;
	output_dir: string;
	status: SnapshotStatus;
	collection: string | null;
	short_id: string | null;
	width: number | null;
	height: number | null;
	job_payload: string | null;
}

// sole entry point for the "open one db, run one op, always close" shape —
// closes in `finally` even if `fn` throws.
export function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
	const db = openDb(dbPath);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

// completion description fields — mirrors `list`'s own columns
// (printListTable, src/cli.ts) minus short_id, which is the completion
// value itself, not part of its description.
export interface CompletionSummary {
	short_id: string;
	host: string;
	path: string;
	collection: string | null;
	width: number | null;
	height: number | null;
	timestamp: string;
	status: SnapshotStatus;
}

// completion-only path: read-only, never runs openDb's
// CREATE/ALTER migrations, and swallows every failure (missing file, locked,
// missing table/column on a stale db) into an empty list — a shell TAB press
// must never surface a stack trace or block on a lock.
export function getRecentSnapshotSummaries(
	dbPath: string,
): CompletionSummary[] {
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const rows = db
				.prepare(
					"SELECT short_id, url, collection, width, height, timestamp, status FROM snapshots WHERE short_id IS NOT NULL ORDER BY timestamp DESC LIMIT 50",
				)
				.all() as {
				short_id: string;
				url: string;
				collection: string | null;
				width: number | null;
				height: number | null;
				timestamp: string;
				status: SnapshotStatus;
			}[];
			// host/path derived from url same as listSnapshots — "?"
			// fallback on unparseable url, ⊥ throw.
			return rows.map(({ url, ...row }) => {
				try {
					const u = new URL(url);
					return { ...row, host: u.hostname, path: u.pathname };
				} catch {
					return { ...row, host: "?", path: "?" };
				}
			});
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

// node:sqlite's default busy_timeout is 0 (verified live, Node
// 24.18.0): concurrent access from another process (CLI + a running worker,
// both opening the same dbPath) throws SQLITE_BUSY immediately instead of
// waiting for the lock to clear (surfaced as a CI-only flake in
// `worker status --json`, spawned repeatedly while a worker was starting).
const BUSY_TIMEOUT_MS = 5000;

export function openDb(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      output_dir TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    )
  `);
	try {
		db.exec("ALTER TABLE snapshots ADD COLUMN collection TEXT");
	} catch {
		// column already exists (pre-existing db file) — idempotent, no migration framework
	}
	try {
		// bare column, no inline UNIQUE — SQLite forbids UNIQUE via ALTER TABLE ADD COLUMN
		db.exec("ALTER TABLE snapshots ADD COLUMN short_id TEXT");
	} catch {
		// column already exists (pre-existing db file) — idempotent, no migration framework
	}
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_short_id ON snapshots(short_id)",
	);
	try {
		db.exec("ALTER TABLE snapshots ADD COLUMN width INTEGER");
	} catch {
		// column already exists (pre-existing db file) — idempotent, no migration framework
	}
	try {
		db.exec("ALTER TABLE snapshots ADD COLUMN height INTEGER");
	} catch {
		// column already exists (pre-existing db file) — idempotent, no migration framework
	}
	try {
		db.exec("ALTER TABLE snapshots ADD COLUMN job_payload TEXT");
	} catch {
		// column already exists (pre-existing db file) — idempotent, no migration framework
	}
	db.exec(`
    CREATE TABLE IF NOT EXISTS redirect_urls (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      next_hop_id TEXT,
      http_status INTEGER,
      final_url_id TEXT,
      resolved_at TEXT
    )
  `);
	return db;
}

// normalizes before hashing so equivalent URLs (case/port/fragment/query-order/
// trailing-slash variants) collapse to the same redirect_urls row.
export function normalizeUrl(rawUrl: string): string {
	const u = new URL(rawUrl);
	u.hostname = u.hostname.toLowerCase();
	if (
		(u.protocol === "http:" && u.port === "80") ||
		(u.protocol === "https:" && u.port === "443")
	) {
		u.port = "";
	}
	u.hash = "";
	const params = new URLSearchParams(u.search);
	params.sort();
	u.search = params.toString();
	if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
		u.pathname = u.pathname.slice(0, -1);
	}
	return u.toString();
}

export function hashUrl(rawUrl: string): string {
	return createHash("sha256").update(normalizeUrl(rawUrl)).digest("hex");
}

const SHORT_ID_ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHORT_ID_LENGTH = 8;

export function makeShortId(): string {
	return Array.from(
		{ length: SHORT_ID_LENGTH },
		() => SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)],
	).join("");
}

const MAX_REDIRECT_HOPS = 20;

// persists a playwright-observed redirect chain, then path-compresses it:
// every hop's final_url_id is set to the terminal hop in 1 batch UPDATE.
// a cycle (or a chain longer than MAX_REDIRECT_HOPS) leaves final_url_id
// unset for new rows instead of throwing — "unresolved", not an error.
export function recordRedirectChain(
	db: DatabaseSync,
	redirects: { url: string; status: number | null }[],
): void {
	if (redirects.length === 0) return;

	const hashes = redirects.map((hop) => hashUrl(hop.url));
	const looped =
		redirects.length > MAX_REDIRECT_HOPS ||
		new Set(hashes).size !== hashes.length;

	const resolvedAt = new Date().toISOString();
	db.exec("BEGIN");
	try {
		for (let i = 0; i < redirects.length; i++) {
			const nextHopId = i < redirects.length - 1 ? hashes[i + 1] : null;
			db.prepare(
				`INSERT INTO redirect_urls (url_hash, url, next_hop_id, http_status, resolved_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(url_hash) DO UPDATE SET
				   url = excluded.url,
				   next_hop_id = excluded.next_hop_id,
				   http_status = excluded.http_status,
				   resolved_at = excluded.resolved_at`,
			).run(
				hashes[i],
				redirects[i].url,
				nextHopId,
				redirects[i].status,
				resolvedAt,
			);
		}

		if (!looped) {
			const terminalHash = hashes[hashes.length - 1];
			const placeholders = hashes.map(() => "?").join(",");
			db.prepare(
				`UPDATE redirect_urls SET final_url_id = ? WHERE url_hash IN (${placeholders})`,
			).run(terminalHash, ...hashes);
		}

		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

// O(1) lookup: 1 query joins a url's row to its precomputed final_url_id
// row — never walks next_hop_id at read time.
export function resolveFinalUrl(
	db: DatabaseSync,
	url: string,
): string | undefined {
	const row = db
		.prepare(
			`SELECT final.url AS url
			 FROM redirect_urls AS origin
			 JOIN redirect_urls AS final ON final.url_hash = origin.final_url_id
			 WHERE origin.url_hash = ?`,
		)
		.get(hashUrl(url)) as { url: string } | undefined;
	return row?.url;
}

const MAX_SHORT_ID_ATTEMPTS = 5;

export function insertSnapshot(
	db: DatabaseSync,
	row: {
		url: string;
		timestamp: string;
		outputDir: string;
		status: SnapshotStatus;
		collection?: string | null;
		width?: number | null;
		height?: number | null;
		jobPayload?: string | null;
	},
): string {
	for (let attempt = 0; attempt < MAX_SHORT_ID_ATTEMPTS; attempt++) {
		const shortId = makeShortId();
		try {
			db.prepare(
				"INSERT INTO snapshots (url, timestamp, output_dir, status, collection, short_id, width, height, job_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				row.url,
				row.timestamp,
				row.outputDir,
				row.status,
				row.collection ?? null,
				shortId,
				row.width ?? null,
				row.height ?? null,
				row.jobPayload ?? null,
			);
			return shortId;
		} catch (err) {
			const isShortIdConflict =
				err instanceof Error && err.message.includes("snapshots.short_id");
			if (!isShortIdConflict) throw err;
		}
	}
	throw new Error(
		`insertSnapshot: failed to generate unique short_id after ${MAX_SHORT_ID_ATTEMPTS} attempts`,
	);
}

export function updateSnapshotStatus(
	db: DatabaseSync,
	outputDir: string,
	status: SnapshotStatus,
): void {
	db.prepare("UPDATE snapshots SET status = ? WHERE output_dir = ?").run(
		status,
		outputDir,
	);
}

export function getSnapshotByOutputDir(
	db: DatabaseSync,
	outputDir: string,
): SnapshotRow | undefined {
	return db
		.prepare("SELECT * FROM snapshots WHERE output_dir = ?")
		.get(outputDir) as SnapshotRow | undefined;
}

// FIFO by `id` (not `timestamp`) — rapid successive enqueues can share an
// ISO-string timestamp at ms precision, `id` (AUTOINCREMENT) never ties.
export function getNextQueuedSnapshot(
	db: DatabaseSync,
): SnapshotRow | undefined {
	return db
		.prepare(
			"SELECT * FROM snapshots WHERE status = 'queued' ORDER BY id ASC LIMIT 1",
		)
		.get() as SnapshotRow | undefined;
}

const ALL_SNAPSHOT_STATUSES: SnapshotStatus[] = [
	"queued",
	"pending",
	"completed",
	"error",
];

export function countSnapshotsByStatus(
	db: DatabaseSync,
): Record<SnapshotStatus, number> {
	const counts = Object.fromEntries(
		ALL_SNAPSHOT_STATUSES.map((status) => [status, 0]),
	) as Record<SnapshotStatus, number>;
	const rows = db
		.prepare("SELECT status, COUNT(*) as n FROM snapshots GROUP BY status")
		.all() as { status: SnapshotStatus; n: number }[];
	for (const row of rows) counts[row.status] = row.n;
	return counts;
}

export function getSnapshotByShortId(
	db: DatabaseSync,
	shortId: string,
): SnapshotRow | undefined {
	return db
		.prepare("SELECT * FROM snapshots WHERE short_id = ?")
		.get(shortId) as SnapshotRow | undefined;
}

export interface ListFilters {
	collection?: string;
	width?: number;
	height?: number;
	host?: string;
	path?: string;
	after?: string;
	before?: string;
	status?: SnapshotStatus;
}

export type ListRow = SnapshotRow & { host: string; path: string };

// a stored `url` that fails `new URL()` parsing never aborts the whole
// listing — that row gets a "?" placeholder host/path (excluded from any
// --host/--path glob match) instead of throwing.
export function listSnapshots(
	db: DatabaseSync,
	filters: ListFilters = {},
): ListRow[] {
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	if (filters.collection !== undefined) {
		clauses.push("collection = ?");
		params.push(filters.collection);
	}
	if (filters.width !== undefined) {
		clauses.push("width = ?");
		params.push(filters.width);
	}
	if (filters.height !== undefined) {
		clauses.push("height = ?");
		params.push(filters.height);
	}
	if (filters.status !== undefined) {
		clauses.push("status = ?");
		params.push(filters.status);
	}
	if (filters.after !== undefined) {
		clauses.push("timestamp >= ?");
		params.push(filters.after);
	}
	if (filters.before !== undefined) {
		clauses.push("timestamp <= ?");
		params.push(filters.before);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = db
		.prepare(`SELECT * FROM snapshots ${where} ORDER BY timestamp DESC`)
		.all(...params) as unknown as SnapshotRow[];

	return rows
		.map((row): ListRow => {
			try {
				const u = new URL(row.url);
				return { ...row, host: u.hostname, path: u.pathname };
			} catch {
				return { ...row, host: "?", path: "?" };
			}
		})
		.filter((row) => {
			if (filters.host && !matchesGlob(row.host, filters.host)) return false;
			if (filters.path && !matchesGlob(row.path, filters.path)) return false;
			return true;
		});
}
