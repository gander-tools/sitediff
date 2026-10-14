# Install

```sh
# run without installing (always use @latest — bare "npx sitediff" caches
# the first resolved version forever and won't pick up later releases)
npx sitediff@latest capture <url>

# install globally from npm
npm install -g sitediff

# or install the tarball attached to a GitHub release (../../releases)
npm install -g ./sitediff-*.tgz

# or clone the repo and run locally
npm install
npm run dev -- capture <url>
```

Playwright's Chromium browser must be installed once before first use, regardless of install method:

```sh
npx playwright install chromium
```
