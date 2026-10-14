# Config

No environment variables — the config file (`--config <path>` or cwd-discovered `.sitediff.json`) plus CLI flags are the only settings sources.

A JSON config file (default name `.sitediff.json`, discovered in cwd or set via `--config`) sets `outDir`, `dbPath`, `worker`, `wwwEquivalent`, a top-level `config` (viewport/navTimeoutMs/selectors/etc, used as the fallback whenever a capture doesn't select a collection or preset), and named `presets`/`collections` for reuse across runs. There's no interactive/point-edit CLI for it — edit the JSON file by hand. Manage it with:

```sh
sitediff config init [--force]  # scaffold a config file (full default values); --force overwrites an existing one
sitediff config [--json]        # show the whole config-file tree: field/value/source/valid rows
```

`config` (bare, no subcommand) renders 1 flat table covering every field —
top-level fields, `/worker/*`, every `/presets/<name>/*` field, every
`/collections/<name>` field — with a `source` column (`default`/`config
file`) and a `valid` column. Each row's `field` is an [RFC 6901 JSON
Pointer](https://datatracker.ietf.org/doc/html/rfc6901) into the raw
config-file tree (e.g. `/config/viewport/width`, `/collections/mobile`);
names containing `~` or `/` are escaped per the spec (`~0`/`~1`). A row is
`valid:false` when its value fails schema validation, OR (for
`/collections/<name>` specifically) when it names a preset that doesn't
exist in `presets{}`. No config file on disk isn't an error — you just get
default-only rows, all valid.

`--json` prints `{field,value,source,valid}[]` instead of a table, and
exits `1` if any row is invalid (`0` otherwise).

Run `sitediff config --help` (or `config init --help`) for the full flag list.

## worker

```json
{ "worker": { "autostart": true, "timeout": 30000 } }
```

`worker` lives on the config file's top level only — it's never part of
`config` or a preset, so it can't be overridden per-collection/preset.

- `worker.autostart` (bool, default `true`) — `capture --enqueue`/`enqueue` auto-starts a worker for this `dbPath` if none is running, without needing `--worker`.
- `worker.timeout` (ms, default `30000`) — a running worker self-exits after this much continuous idle time; `-1` disables the idle-exit entirely.

## wwwEquivalent

```json
{ "wwwEquivalent": true }
```

`wwwEquivalent` lives on the config file's top level only, default `true`. It
controls host-normalization in `diff`/`report`: when `true`, `www.<host>` and
`<host>` count as the same host — a resource, header value, or displayed URL
matching either form is treated identically. Set to `false` to require an
exact host-string match instead. No CLI/MCP flag exists for this — the config
file is the only way to set or inspect it (`sitediff config` shows its
resolved value + source under `/wwwEquivalent`).

## presets and collections

The config file's top level is `outDir`/`dbPath`/`worker`/`wwwEquivalent`
plus a nested `config` object holding the shared capture fields (`viewport`,
`navTimeoutMs`, `sessionPath`, `maskSelectors`, `hideSelectors`,
`dropSelectors`) — this is the fallback used whenever a capture doesn't
select a collection or preset. `outDir`/`dbPath`/`worker`/`wwwEquivalent` are
top-level-only — they can't be set inside `config` or a preset.

- `presets` — an object of named, reusable partial configs: `{ "<name>":
  config }`. Missing fields fall through to the top-level `config`, then to
  defaults.
- `collections` — an object of named groupings selected via `--collection
  <name>`: `{ "<name>": "<presetName>" }`. Each collection is a bare
  reference to an existing `presets` key by name — there's no per-collection
  inline override; add a new named preset instead if you need a variant.

Worked example — a `mobile` preset reused by a `checkout` collection:

```json
{
  "dbPath": "./sitediff.sqlite",
  "presets": {
    "mobile": {
      "viewport": { "width": 375, "height": 667 },
      "navTimeoutMs": 60000
    }
  },
  "collections": {
    "checkout": "mobile"
  }
}
```

Running `capture <url> --collection checkout` resolves to `viewport:
{width: 375, height: 667}` and `navTimeoutMs: 60000` (both from the
`mobile` preset).

There's no CLI to create/edit individual `presets`/`collections` entries —
add, rename, or remove them by hand-editing the JSON file, then run `sitediff
config` to check the `valid` column (it also catches a `collections.<name>`
value pointing at a preset name that doesn't exist).
