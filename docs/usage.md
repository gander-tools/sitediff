# Usage

```sh
sitediff capture <url> [--headed] [--config <path>] [--collection <name>] [--preset <name>] [--enqueue] [--worker]
```

- `<url>` — required, the page to capture.
- `--headed` — run the browser headed instead of headless (debugging).
- `--config <path>` — config file or directory (see [Config](config.md)).
- `--collection <name>` / `--preset <name>` — apply a named collection/preset from the config file.
- `--enqueue` — insert the URL as a queued job instead of capturing immediately; returns right away with `status: "queued"`. A `worker` process picks it up later.
- `--worker` — make sure a worker is running for this config's `dbPath`, starting one in the background if none is found. Combine with `--enqueue` to enqueue-and-ensure-processing in one call.

Output files are written under `${outDir}/<shot-id>/` (default `./output`): `capture.har`, `dom.html`, `screenshot.png`, `console.json`, `redirects.json`, `settings.json`.

`sitediff --version`/`-V` prints just the version string. `sitediff` with no arguments (or `--help`/`-h` at any level) prints usage help.

`--color`/`--no-color` (global, any subcommand) force ANSI output on/off. Without either, color is auto-detected from the real terminal (a real TTY, no `NO_COLOR` env var) — so piped/captured output (scripts, CI, tests) is plain by default.

## Enqueue

```sh
sitediff enqueue [file] [--config <path>] [--collection <name>] [--preset <name>] [--worker]
```

Bulk version of `capture --enqueue`: reads URLs one per line from `file` (or stdin if omitted), resolves config once via the same `--collection`/`--preset`/`--config` opts as `capture`, and inserts one `queued` snapshot row per URL. Prints `enqueued N url(s)`.

- `--worker` — make sure a worker is running for this config's `dbPath` after enqueueing, same as `capture --worker`.

```sh
sitediff enqueue urls.txt
cat urls.txt | sitediff enqueue
```

## Worker

Queued jobs (`capture <url> --enqueue` / `enqueue [file]`) sit in the `snapshots` table with `status: "queued"` until a worker processes them one at a time, FIFO. Any enqueue also auto-starts a worker when `worker.autostart` (default `true`) is set — see [Config](config.md).

```sh
sitediff worker status          # queued/pending/completed/error counts + whether a worker is running
sitediff worker status --json   # same report as raw JSON instead of a table
sitediff worker start           # run in the foreground, blocks until SIGTERM
sitediff worker start --detached  # same as -d: spawn a worker in the background and return immediately
sitediff worker                 # no subcommand -> usage/help, exit 0 (⊥ longer aliases `worker start`)
sitediff worker stop            # send SIGTERM to the running worker (no-op, exit 0, if none is running)
```

A worker only ever runs one capture at a time. On `SIGTERM` it finishes the job currently in flight (never aborts mid-capture) and does not pick up a new one before exiting. The idle-poll interval is a fixed `1000`ms, not configurable. Only one worker per `dbPath` is tracked at a time (a pidfile lives next to the sqlite file) — `worker start`/`capture --worker` are idempotent and won't start a second worker against the same database. A worker self-exits after `worker.timeout` ms (default `30000`) of continuous idle.

## List

```sh
sitediff list [--collection <name>] [--width <n>] [--height <n>] [--host <glob>] [--path <glob>] [--after <date>] [--before <date>] [--status <pending|completed|error>] [--json]
```

Lists stored snapshots, sorted newest-first. All filters are optional and AND-combined.

| flag | meaning |
| --- | --- |
| `--collection <name>` | exact match on the collection the snapshot was captured with |
| `--width <n>` / `--height <n>` | exact match on the viewport dimensions used |
| `--host <glob>` / `--path <glob>` | glob match against the captured URL's host/pathname |
| `--after <date>` / `--before <date>` | inclusive ISO-date range on capture timestamp |
| `--status <pending\|completed\|error>` | exact match; omitted shows every status |
| `--json` | print the raw row array instead of a table |

Table/JSON columns: `short_id`, `host`, `path`, `collection`, `width`, `height`, `timestamp`, `status`.

## Stats

```sh
sitediff stats <shortId> [--json]
```

Reads a snapshot's `capture.har`/`dom.html`/`screenshot.png` and writes `${outputDir}/stats.json` — load time, total transferred bytes, DOM size, screenshot dimensions, and a per-resource breakdown (host/path/type/size/headers). An unknown `shortId` fails fast. `--json` also prints the full report to stdout.

## Diff

```sh
sitediff diff <shortIdA> <shortIdB> [--json]
```

Compares two snapshots — any two, host/path need not match. Writes `diff-<A>-<B>.json` (sectioned report: screenshot/DOM/HAR-resources/console/redirects), when screenshot dimensions match `diff-<A>-<B>.png`, and — as its last step — a static HTML report `diff-<A>-<B>.html`, all under the resolved config's `outDir` (cwd-discovered `.sitediff.json` if present, else the default `./output`). `--json` also prints the full report to stdout. If the HTML step fails, the whole command fails (exit 1) even though the json/png already wrote.

| flag | meaning |
| --- | --- |
| `<shortIdA>` / `<shortIdB>` | required, the two snapshots to compare |
| `--json` | also print the full report to stdout |

Both snapshots must have `status: "completed"` or the whole comparison is refused; a screenshot pixel-dimension mismatch only drops the `screenshot` section, every other section still runs. A `urlMismatch` field is added to the report (informational only) whenever the two snapshots' host or path differ.

The comparison itself is host-agnostic: HAR resources pair by path (+query), not full URL, so the same asset served from two different hosts (e.g. a local dev copy vs production) still pairs and compares correctly instead of showing up as one added and one removed resource per side. Redirect hops likewise compare by path. Response bodies and header values are host-normalized before the identical/changed verdict, so a host name of different length alone never flips the verdict.

The HTML report renders every field of the diff report (screenshot, DOM, HAR resources, console, redirects) in a single page styled via a Pico.css CDN link. All values sourced from the captured pages are HTML-escaped before rendering, since captured pages are untrusted content. It opens with a legend explaining its terminology (`shotId`, `path match`/`url mismatch`, verdict states), followed by each shotId's full captured URL. HAR "paired" resources and Redirect hops each render as a flat list of collapsed `<details>` rows (closed by default, one click expands the a/b diff table downward — never widening the page sideways); each side's URL is shown host-normalized inside, since a resource/hop is paired by path and the host difference is expected noise once paired — HAR's "added"/"removed" entries are collapsed `<details>` too but keep the raw URL, since those entries have no pair and the host is diagnostically useful there. The DOM section shows host-normalized before/after/delta byte counts alongside the raw ones, so a size delta caused purely by host-string length is distinguishable from a real content change.

## MCP

```sh
sitediff mcp
```

Starts an MCP server over stdio (`@modelcontextprotocol/sdk`'s `McpServer` +
`StdioServerTransport`) so an LLM agent/client can drive `sitediff` as a
set of tools instead of shelling out to the CLI. Blocks — this is a
long-running process, same shape as `worker start` (no `-d`/detached mode).

Exposes 1 tool per CLI subcommand, using the same underlying functions as
each CLI action: `capture`, `enqueue`, `list`, `stats`, `diff`, `config_init`,
`config_validate`, `config_show`, `config_set`, `config_del`, `config_add`,
`config_remove`, `worker_start`, `worker_stop`, `worker_status`. Every tool
response is JSON content only (no table/plain text). Tool params mirror the
matching CLI's flags, with two differences:

- `enqueue` takes `file` (path, same as CLI) or `urls: string[]` — never
  stdin, since MCP has no interactive stdin stream to read.
- `worker_start` always spawns detached; there's no foreground/blocking
  variant over MCP (a blocking call would hang the tool call forever).

Not exposed: `mcp` itself (no recursive self-wrap), `completion` (shell-only,
meaningless as an LLM tool).
