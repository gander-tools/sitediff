import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const binPath = fileURLToPath(
	new URL("../../dist/sitediff", import.meta.url),
);

export function requireBin(): void {
	if (!existsSync(binPath)) {
		throw new Error(
			`${binPath} not found - run "npm run build" before "npm run test:integration"`,
		);
	}
}

// throws (rejects) on a non-zero exit — matches every existing call site's
// try/catch or assert.rejects usage.
export async function runBin(
	args: string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const { stdout } = await execFileAsync(binPath, args, {
		cwd,
		env: env ?? process.env,
	});
	return stdout;
}

export interface RunBinSyncResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

// never throws — callers that need the exit code/stderr on a non-zero exit
// (e.g. asserting a validation failure) use this instead of runBin.
export function runBinSync(args: string[], cwd?: string): RunBinSyncResult {
	const result = spawnSync(binPath, args, { cwd, encoding: "utf8" });
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}

export interface LocalServer {
	server: Server;
	baseUrl: string;
	port: number;
}

// ephemeral fixture server for tests that need something real to capture
// without hitting a live external site.
export async function startLocalServer(): Promise<LocalServer> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><body><h1>ok</h1></body></html>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address !== "object") {
		throw new Error("startLocalServer: could not determine listening port");
	}
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		port: address.port,
	};
}

export async function stopLocalServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
