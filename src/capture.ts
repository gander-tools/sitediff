import { existsSync } from "node:fs";
import { resolveHeadless } from "./browser.ts";
import { resolveCaptureConfig } from "./config.ts";
import { enqueueUrls } from "./enqueue.ts";
import type { CaptureResult, PartialBaseConfig } from "./pipeline.ts";
import { runCapture } from "./pipeline.ts";
import { assertHttpUrl } from "./url-guard.ts";
import { ensureWorkerRunning } from "./worker-cmd.ts";

function loadDotEnv(): void {
	if (existsSync(".env")) {
		process.loadEnvFile(".env");
	}
}

export interface CaptureOptions {
	headless?: boolean;
	overrides?: PartialBaseConfig;
	configPath?: string;
	collectionName?: string;
	presetName?: string;
	enqueue?: boolean;
	worker?: boolean;
}

export async function capture(
	url: string,
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const {
		headless: cliHeaded,
		overrides,
		configPath,
		collectionName,
		presetName,
		enqueue,
		worker: ensureWorker,
	} = options;
	assertHttpUrl(url);
	loadDotEnv();
	const headless = resolveHeadless(cliHeaded);
	const { config, meta, worker } = await resolveCaptureConfig(configPath, {
		collectionName,
		presetName,
		overrides,
	});

	if (ensureWorker) {
		ensureWorkerRunning(config.dbPath);
	}

	if (enqueue) {
		const [row] = enqueueUrls([url], config, worker, meta);
		return {
			id: row.short_id ?? "",
			status: "queued",
			outputDir: row.output_dir,
		};
	}

	return runCapture(url, config, headless, meta);
}
