// only http(s) pages are capturable: a file:, data: or other scheme would let
// the browser read local files or non-web resources into the snapshot.
// the message deliberately never echoes the input (it may be file content).
export function assertHttpUrl(url: string): void {
	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch {
		throw new Error("invalid url (only http and https urls are allowed)");
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error("unsupported url scheme (only http and https are allowed)");
	}
}
