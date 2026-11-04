const test = require("node:test");
const assert = require("node:assert/strict");

const authRestPath = require.resolve("../utils/firebaseAuthRest");

test("local password login calls only the configured loopback emulator", async (context) => {
  const previousMode = process.env.USE_FIREBASE_EMULATOR;
  const previousHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const previousFetch = global.fetch;
  let requestedUrl;

  process.env.USE_FIREBASE_EMULATOR = "true";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ idToken: "emulator-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  context.after(() => {
    if (previousMode === undefined) delete process.env.USE_FIREBASE_EMULATOR;
    else process.env.USE_FIREBASE_EMULATOR = previousMode;
    if (previousHost === undefined)
      delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = previousHost;
    global.fetch = previousFetch;
    delete require.cache[authRestPath];
  });

  delete require.cache[authRestPath];
  const { signInWithPassword } = require("../utils/firebaseAuthRest");
  const response = await signInWithPassword("admin@vendly.local", "local-pass");

  assert.equal(response.idToken, "emulator-token");
  assert.equal(
    requestedUrl,
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key",
  );
  assert.equal(requestedUrl.includes("identitytoolkit.googleapis.com"), true);
  assert.equal(requestedUrl.startsWith("http://127.0.0.1:9099/"), true);
});

test("local password login rejects a remote Auth host before fetch", async (context) => {
  const previousMode = process.env.USE_FIREBASE_EMULATOR;
  const previousHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const previousFetch = global.fetch;
  let fetchCalled = false;

  process.env.USE_FIREBASE_EMULATOR = "true";
  process.env.FIREBASE_AUTH_EMULATOR_HOST =
    "identitytoolkit.googleapis.com:443";
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch must not run for a remote Auth host");
  };

  context.after(() => {
    if (previousMode === undefined) delete process.env.USE_FIREBASE_EMULATOR;
    else process.env.USE_FIREBASE_EMULATOR = previousMode;
    if (previousHost === undefined)
      delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = previousHost;
    global.fetch = previousFetch;
    delete require.cache[authRestPath];
  });

  delete require.cache[authRestPath];
  const { signInWithPassword } = require("../utils/firebaseAuthRest");

  await assert.rejects(
    signInWithPassword("admin@vendly.local", "local-pass"),
    /Authentication Emulator local/,
  );
  assert.equal(fetchCalled, false);
});
