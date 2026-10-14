# sitediff

Given a URL, runs one Playwright (Chromium) pass and captures full page behavior: redirect chain, HAR (with full response bodies), rendered DOM post-networkidle, screenshot, and console logs. Saves everything as files plus a sqlite record.

```sh
npx sitediff@latest capture <url>
```

Shell completion (bash/fish):

```sh
source <(sitediff completion bash)
```

See [docs/](docs/README.md) for install options, usage, and config.

## Development

The toolchain is pinned: Node 24 (see `.nvmrc`) with the npm that ships with it (npm 11).

```sh
nvm install   # first time only
nvm use
npm install
npm run build # output goes to dist/ (dist/sitediff is the CLI entry)
```

Git hooks are managed by [lefthook](https://lefthook.dev) (config in `lefthook.yml`: `npm pkg fix`, lint and typecheck on pre-commit). It is not an npm dependency, so install the hooks once per clone with your own lefthook binary or via npx:

```sh
lefthook install       # or: npx lefthook install
```

**Run npm only under the pinned Node, with the npm that ships with it. Never run `npm install -g npm`:** a different npm major rewrites `package-lock.json` and resolves a different dependency tree, which produces huge noisy diffs and breaks the other contributors' installs. CI uses `npm ci`, which never rewrites the lockfile.

`package.json` declares the supported range in `devEngines` (`onFail: "error"`) and `.npmrc` sets `engine-strict=true`, so installing under another Node or npm fails with `EBADDEVENGINES` / `EBADENGINE` instead of silently changing the lockfile. Published installs (`npm install -g sitediff`) are not affected: `.npmrc` is not part of the package and `engines` only requires Node >= 24. `.npmrc` also sets `ignore-scripts=true`, so dependency install scripts never run; the `npx playwright install chromium` step is the only post-install action you need.

To try a dependency bump on a newer Node, `--engine-strict=false` is not enough (it does not override `devEngines`). Temporarily set `devEngines.*.onFail` to `"warn"` in `package.json`, and revert it before committing.
