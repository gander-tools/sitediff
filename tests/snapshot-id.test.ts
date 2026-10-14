import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSnapshotId } from "../src/snapshot-id.ts";

test("makeSnapshotId produces unique ids across calls", () => {
	const a = makeSnapshotId();
	const b = makeSnapshotId();
	assert.notEqual(a, b);
});

test("makeSnapshotId embeds a filesystem-safe timestamp", () => {
	const id = makeSnapshotId(new Date("2026-07-22T10:11:12.345Z"));
	assert.match(id, /^2026-07-22T10-11-12-345Z_[0-9a-f-]{36}$/);
});
