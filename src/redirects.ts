import type { Request, Response } from "playwright";

export interface RedirectHop {
	url: string;
	method: string;
	status: number | null;
}

export async function buildRedirectChain(
	response: Response | null,
): Promise<RedirectHop[]> {
	if (!response) return [];

	const chain: RedirectHop[] = [];
	let req: Request | null = response.request();

	while (req) {
		const res = await req.response();
		chain.unshift({
			url: req.url(),
			method: req.method(),
			status: res?.status() ?? null,
		});
		req = req.redirectedFrom();
	}

	return chain;
}
