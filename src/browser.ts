import { type Browser, type BrowserContext, chromium } from "playwright";

export interface ViewportSize {
	width: number;
	height: number;
}

export function parseViewport(raw: string | undefined): ViewportSize {
	if (!raw) return { width: 1920, height: 1080 };
	const [width, height] = raw.split("x").map(Number);
	if (!width || !height) return { width: 1920, height: 1080 };
	return { width, height };
}

// headless is CLI flag only, never part of BaseConfig — resolved
// standalone here, same leaf-helper pattern as parseViewport. ⊥ env fallback
// anymore — --headed is the sole override.
export function resolveHeadless(cliHeaded: boolean | undefined): boolean {
	return cliHeaded !== true;
}

export async function launchCaptureContext(
	headless: boolean,
	viewport: ViewportSize,
	harPath: string,
): Promise<{ browser: Browser; context: BrowserContext }> {
	const browser = await chromium.launch({ headless });
	const context = await browser.newContext({
		viewport,
		recordHar: { path: harPath, content: "embed", mode: "full" },
	});
	return { browser, context };
}
