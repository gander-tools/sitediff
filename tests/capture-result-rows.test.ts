import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCaptureResultRows } from "../src/config-cmd.ts";

test("buildCaptureResultRows: completed, no error -> 3 rows, no error row", () => {
	const rows = buildCaptureResultRows({
		id: "aB3xY7Qm",
		status: "completed",
		outputDir: "x",
	});
	assert.deepEqual(rows, [
		{ field: "id", value: "aB3xY7Qm" },
		{ field: "status", value: "completed" },
		{ field: "outputDir", value: "x" },
	]);
});

test("buildCaptureResultRows: Error instance -> flattened to message string", () => {
	const rows = buildCaptureResultRows({
		id: "aB3xY7Qm",
		status: "error",
		outputDir: "x",
		error: new Error("boom"),
	});
	assert.deepEqual(rows, [
		{ field: "id", value: "aB3xY7Qm" },
		{ field: "status", value: "error" },
		{ field: "outputDir", value: "x" },
		{ field: "error", value: "boom" },
	]);
});

test("buildCaptureResultRows: non-Error error value -> String()'d", () => {
	const rows = buildCaptureResultRows({
		id: "aB3xY7Qm",
		status: "error",
		outputDir: "x",
		error: "raw string",
	});
	assert.deepEqual(rows.at(-1), { field: "error", value: "raw string" });
});
