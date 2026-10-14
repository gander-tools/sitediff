import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { sitediff: "src/cli.ts" },
	outExtensions: () => ({ js: "" }),
});
