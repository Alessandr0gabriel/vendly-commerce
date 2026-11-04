const test = require("node:test");
const assert = require("node:assert/strict");
const withTimeout = require("../utils/withTimeout");

test("withTimeout resolves when the Emulator responds", async () => {
  assert.equal(
    await withTimeout(() => Promise.resolve("ok"), 100, "Emulator"),
    "ok",
  );
});

test("withTimeout rejects with a clear local service message", async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 5, "Authentication Emulator"),
    /Authentication Emulator não respondeu em 5ms/,
  );
});
