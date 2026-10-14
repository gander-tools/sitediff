import type { Page } from "playwright";

export interface ConsoleEntry {
	type: string;
	text: string;
}

export function attachConsoleCapture(page: Page): ConsoleEntry[] {
	const entries: ConsoleEntry[] = [];
	page.on("console", (msg) => {
		entries.push({ type: msg.type(), text: msg.text() });
	});
	return entries;
}
