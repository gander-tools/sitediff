import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright";
import { launchCaptureContext, type ViewportSize } from "./browser.ts";
import { attachConsoleCapture } from "./console-capture.ts";
import type { SnapshotRow, SnapshotStatus } from "./db.ts";
import {
	getSnapshotByOutputDir,
	insertSnapshot,
	openDb,
	recordRedirectChain,
	updateSnapshotStatus,
} from "./db.ts";
import { buildRedirectChain } from "./redirects.ts";
import { makeSnapshotId } from "./snapshot-id.ts";

// after a failed/timed-out navigation, Chrome briefly reports the page as
// still "navigating" — page.content() rejects transiently until it settles.
async function readPageContentWithRetry(
	page: Page,
	attempts = 10,
	delayMs = 150,
): Promise<string> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await page.content();
		} catch (error) {
			if (attempt === attempts - 1) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw new Error("unreachable");
}

export interface WorkerConfig {
	timeout: number;
	autostart: boolean;
}

export interface BaseConfig {
	outDir: string;
	dbPath: string;
	viewport: ViewportSize;
	navTimeoutMs: number;
	sessionPath?: string;
	maskSelectors: string[];
	hideSelectors: string[];
	dropSelectors: string[];
}

// `Partial<BaseConfig>` alone keeps `viewport: ViewportSize` required
// (TS's `Partial` is shallow) — every cascade level (file/collection/
// preset/CLI overrides) needs `viewport`'s own sub-fields independently
// omittable too, hence this explicit override.
export type PartialBaseConfig = Partial<Omit<BaseConfig, "viewport">> & {
	viewport?: Partial<ViewportSize>;
};

export interface CaptureResult {
	id: string;
	status: SnapshotStatus;
	outputDir: string;
	error?: unknown;
}

export interface SettingsMeta {
	collection?: { name: string; config: PartialBaseConfig };
	preset?: { name: string; config: PartialBaseConfig };
}

// shared by runCapture & insertQueuedSnapshot — insert then re-fetch the full
// row on the same sync db handle (short_id/etc are DB-generated, only
// available post-insert). Exported for src/enqueue.ts, which reuses it across
// an already-open db handle for a whole batch.
export function insertAndFetchSnapshot(
	db: DatabaseSync,
	row: Parameters<typeof insertSnapshot>[1],
	callerName: string,
): SnapshotRow {
	insertSnapshot(db, row);
	const fetched = getSnapshotByOutputDir(db, row.outputDir);
	if (!fetched) {
		throw new Error(
			`${callerName}: row vanished immediately after insert (${row.outputDir})`,
		);
	}
	return fetched;
}

export async function runCapture(
	url: string,
	config: BaseConfig,
	headless: boolean,
	meta: SettingsMeta = {},
): Promise<CaptureResult> {
	const snapshotId = makeSnapshotId();
	const outputDir = join(config.outDir, snapshotId);
	const collectionName = meta.collection?.name ?? null;

	const db = openDb(config.dbPath);
	let row: SnapshotRow;
	try {
		row = insertAndFetchSnapshot(
			db,
			{
				url,
				timestamp: new Date().toISOString(),
				outputDir,
				status: "pending",
				collection: collectionName,
				width: config.viewport.width,
				height: config.viewport.height,
			},
			"runCapture",
		);
	} catch (err) {
		db.close();
		throw err;
	}

	return executePipeline(db, row, url, config, headless, meta);
}

// inserts a `queued` row (persists the resolved config+meta the worker will
// later run w/) — never touches the pipeline itself.
export function insertQueuedSnapshot(
	url: string,
	config: BaseConfig,
	meta: SettingsMeta = {},
): SnapshotRow {
	const snapshotId = makeSnapshotId();
	const outputDir = join(config.outDir, snapshotId);
	const collectionName = meta.collection?.name ?? null;

	const db = openDb(config.dbPath);
	try {
		return insertAndFetchSnapshot(
			db,
			{
				url,
				timestamp: new Date().toISOString(),
				outputDir,
				status: "queued",
				collection: collectionName,
				width: config.viewport.width,
				height: config.viewport.height,
				jobPayload: JSON.stringify({ config, meta }),
			},
			"insertQueuedSnapshot",
		);
	} finally {
		db.close();
	}
}

// runs today's pipeline against an EXISTING row (e.g. a `queued` row picked
// up by the worker) — never inserts a new row. Transitions the given
// row queued -> pending before pipeline work starts, mirroring the
// synchronous path.
export async function runCaptureForRow(
	row: SnapshotRow,
	config: BaseConfig,
	headless: boolean,
	meta: SettingsMeta = {},
): Promise<CaptureResult> {
	const db = openDb(config.dbPath);
	updateSnapshotStatus(db, row.output_dir, "pending");
	return executePipeline(db, row, row.url, config, headless, meta);
}

async function executePipeline(
	db: DatabaseSync,
	row: SnapshotRow,
	url: string,
	config: BaseConfig,
	headless: boolean,
	meta: SettingsMeta = {},
): Promise<CaptureResult> {
	const outputDir = row.output_dir;
	const shortId = row.short_id ?? "";

	let browser:
		| Awaited<ReturnType<typeof launchCaptureContext>>["browser"]
		| undefined;

	try {
		mkdirSync(outputDir, { recursive: true });

		const launched = await launchCaptureContext(
			headless,
			config.viewport,
			join(outputDir, "capture.har"),
		);
		browser = launched.browser;
		const { context } = launched;
		const page = await context.newPage();

		const consoleEntries = attachConsoleCapture(page);

		let finalResponse: Awaited<ReturnType<typeof page.goto>> = null;
		try {
			finalResponse = await page.goto(url, {
				waitUntil: "networkidle",
				timeout: config.navTimeoutMs,
			});
		} catch {
			// nav timeout or nav-level failure — capture continues on current page state
		}

		const redirects = await buildRedirectChain(finalResponse);
		recordRedirectChain(db, redirects);

		type StyleableElement = { style: { display: string } };
		for (const selector of config.hideSelectors) {
			await page.locator(selector).evaluateAll((els) => {
				for (const el of els as unknown as StyleableElement[])
					el.style.display = "none";
			});
		}
		type RemovableElement = { remove(): void };
		for (const selector of config.dropSelectors) {
			await page.locator(selector).evaluateAll((els) => {
				for (const el of els as unknown as RemovableElement[]) el.remove();
			});
		}

		const domHtml = await readPageContentWithRetry(page);
		writeFileSync(join(outputDir, "dom.html"), domHtml);
		await page.screenshot({
			path: join(outputDir, "screenshot.png"),
			fullPage: true,
			mask: config.maskSelectors.map((selector) => page.locator(selector)),
		});
		writeFileSync(
			join(outputDir, "console.json"),
			JSON.stringify(consoleEntries, null, 2),
		);
		writeFileSync(
			join(outputDir, "redirects.json"),
			JSON.stringify(redirects, null, 2),
		);
		const settings: Record<string, unknown> = {};
		if (meta.collection) settings.collection = meta.collection;
		if (meta.preset) settings.preset = meta.preset;
		// headless never persisted to settings.json at all (file-side ban
		// on the field, now extends to the output side too)
		settings.config = config;
		writeFileSync(
			join(outputDir, "settings.json"),
			JSON.stringify(settings, null, 2),
		);

		await context.close();
		await browser.close();

		updateSnapshotStatus(db, outputDir, "completed");
		return { id: shortId, status: "completed", outputDir };
	} catch (pipelineError) {
		if (browser) {
			await browser.close().catch(() => {});
		}
		updateSnapshotStatus(db, outputDir, "error");
		return { id: shortId, status: "error", outputDir, error: pipelineError };
	} finally {
		db.close();
	}
}
