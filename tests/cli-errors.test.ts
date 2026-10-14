import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: "utf8",
		env,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status ?? 1,
	};
}

// biome-ignore lint: control-char regex intentional for ANSI detection
const ANSI = /\x1b\[/;

test("cli: error thrown by a subcommand prints clean message, no stack trace, exit 1", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		runCli(["config", "init"], dir); // first call creates the file
		const result = runCli(["config", "init"], dir); // second call: already exists

		assert.equal(result.status, 1);
		assert.match(result.stderr, /^Error: config file already exists:/);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// bare `config` no longer falls thru to Commander help — it now has its
// own default action rendering the whole-tree table.
test("cli: bare 'config' (no subcommand, no config file) -> table, exit 0, no stack trace", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["config"], dir);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /outDir/);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
		assert.doesNotMatch(result.stderr, /^Error:/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare root 'sitediff' (no subcommand) -> help text, exit 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli([], dir);
		assert.equal(result.status, 0);
		assert.match(result.stderr, /Usage: sitediff/);
		assert.doesNotMatch(result.stderr, /^Error:/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: 'config preset'/'config collection' no longer recognized (subcommands removed)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		runCli(["config", "init"], dir);
		const preset = runCli(["config", "preset", "add", "foo"], dir);
		assert.notEqual(preset.status, 0);
		assert.match(preset.stderr, /too many arguments for 'config'/);
		const collection = runCli(["config", "collection", "add", "bar"], dir);
		assert.notEqual(collection.status, 0);
		assert.match(collection.stderr, /too many arguments for 'config'/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: 'sitediff help' is unrecognized (help subcommand disabled)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["help"], dir);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown command/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: 'config help'/'config help init' unrecognized (help subcommand disabled at every level)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const bare = runCli(["config", "help"], dir);
		assert.notEqual(bare.status, 0);
		assert.match(bare.stderr, /too many arguments for 'config'/);

		const withSub = runCli(["config", "help", "init"], dir);
		assert.notEqual(withSub.status, 0);
		assert.match(withSub.stderr, /too many arguments for 'config'/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// bare `worker` used to alias `worker start` (foreground, blocks
// on SIGTERM) — it must show usage/help instead, like bare `config`.
test("cli: bare 'worker' (no subcommand) -> help text, exit 0, ⊥ starts foreground loop", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["worker"], dir);
		assert.equal(result.status, 0);
		assert.match(result.stderr, /Usage:.*worker/);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// same class as 'config help' — `.addHelpCommand(false)` didn't
// inherit from the parent Command, `worker help`/`worker help start` stayed
// reachable until workerCmd got its own explicit disable.
test("cli: 'worker help'/'worker help start' unrecognized (help subcommand disabled at every level)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const bare = runCli(["worker", "help"], dir);
		assert.notEqual(bare.status, 0);
		assert.match(bare.stderr, /unknown command/);

		const withSub = runCli(["worker", "help", "start"], dir);
		assert.notEqual(withSub.status, 0);
		assert.match(withSub.stderr, /unknown command/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Missing-required-arg is usage-display, not an error — stderr empty,
// help-only on stdout, exit 1 unchanged.
test("cli: 'capture' without url -> exit 1, help-only, no stderr msg", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["capture"], dir);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /Usage:.*capture/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Same treatment for nested subcommands — printed help must be THAT
// subcommand's own (e.g. diff's, not root sitediff's). Bare completion
// no longer gets an exit-0 special-case either: it behaves exactly like
// every other missing-required-arg command.
for (const cmd of ["stats", "diff", "completion"]) {
	test(`cli: '${cmd}' without required arg -> exit 1, help-only, ${cmd}'s own usage`, () => {
		const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
		try {
			const result = runCli([cmd], dir);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, "");
			assert.match(result.stdout, new RegExp(`Usage:.*${cmd}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("cli: old flat flags no longer recognized (breaking change, no compat shim)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["config", "--init"], dir);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown option/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: config init writes literal DEFAULT_CONFIG values", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const plain = runCli(["config", "init"], dir);
		assert.equal(plain.status, 0);
		assert.match(plain.stdout, /^created /);
		const plainContent = JSON.parse(
			readFileSync(join(dir, ".sitediff.json"), "utf8"),
		);
		assert.equal(plainContent.outDir, "./output");
		assert.deepEqual(plainContent.collections, {});
		assert.deepEqual(plainContent.presets, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: config init --bare is unrecognized (removed, init always writes full defaults)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["config", "init", "--bare"], dir);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown option/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: config init --with-defaults is unrecognized (removed historical flag)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["config", "init", "--with-defaults"], dir);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown option/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config — valid file renders table w/ valid=true rows, exit 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		runCli(["config", "init"], dir);
		// pin NO_COLOR — ambient CI=true would make picocolors color this.
		const result = runCli(["config"], dir, {
			...process.env,
			NO_COLOR: "1",
			FORCE_COLOR: undefined,
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /outDir/);
		assert.doesNotMatch(result.stdout, /false/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config — dangling collections.<name>.preset ref shows valid=false in its row, table mode still exits 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({ collections: { mobile: "ghost" } }),
		);
		// pin NO_COLOR — ambient CI=true would make picocolors color this.
		const result = runCli(["config"], dir, {
			...process.env,
			NO_COLOR: "1",
			FORCE_COLOR: undefined,
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /\/collections\/mobile[^\n]*false/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config — renders presets.<name>.* and collections.<name>.* as separate pointer rows, NOT a merged preview", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		writeFileSync(
			join(dir, ".sitediff.json"),
			JSON.stringify({
				config: { viewport: { height: 600 } },
				presets: { narrow: { viewport: { width: 800 } } },
				collections: { mobile: "narrow" },
			}),
		);
		const result = runCli(["config", "--json"], dir);
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		const find = (field: string) =>
			rows.find((r: { field: string }) => r.field === field);
		assert.equal(find("/presets/narrow/viewport/width")?.value, "800");
		assert.equal(find("/config/viewport/height")?.value, "600");
		assert.equal(find("/collections/mobile")?.value, "narrow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config — scalar values rendered unquoted, not JSON.stringify-wrapped", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const result = runCli(["config", "--json"], dir);
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		const row = rows.find(
			(r: { field: string }) => r.field === "/config/navTimeoutMs",
		);
		assert.equal(row?.value, "30000");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: bare config — valid=true colored when color supported, plain when NO_COLOR", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	try {
		const colored = runCli(["config"], dir, {
			...process.env,
			FORCE_COLOR: "1",
			NO_COLOR: undefined,
		});
		// biome-ignore lint: control-char regex intentional for ANSI detection
		assert.match(colored.stdout, /\x1b\[32m/); // pc.green wraps "true"

		const plain = runCli(["config"], dir, {
			...process.env,
			FORCE_COLOR: undefined,
			NO_COLOR: "1",
		});
		// biome-ignore lint: control-char regex intentional for ANSI detection
		assert.doesNotMatch(plain.stdout, /\x1b\[32m/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: global --config opt inherited by subcommands (works before or after subcommand token)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sitediff-cli-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "sitediff-cli-elsewhere-"));
	try {
		writeFileSync(
			join(elsewhere, ".sitediff.json"),
			JSON.stringify({ outDir: "from-elsewhere" }),
		);
		const result = runCli(["config", "--config", elsewhere, "--json"], dir);
		assert.equal(result.status, 0);
		const rows = JSON.parse(result.stdout);
		const outDirRow = rows.find(
			(r: { field: string }) => r.field === "/outDir",
		);
		assert.equal(outDirRow?.value, "from-elsewhere");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});
