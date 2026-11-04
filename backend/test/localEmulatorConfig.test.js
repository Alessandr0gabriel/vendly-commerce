const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const backendRoot = path.resolve(__dirname, "..");

function loadFirebaseConfig(overrides = {}) {
  const env = {
    ...process.env,
    USE_FIREBASE_EMULATOR: "true",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_PROJECT_ID: "vendly-local",
    ...overrides,
  };

  delete env.FIREBASE_SERVICE_ACCOUNT;
  delete env.FIREBASE_PRIVATE_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;

  return spawnSync(process.execPath, ["-e", "require('./config/firebase')"], {
    cwd: backendRoot,
    env,
    encoding: "utf8",
  });
}

test("local Firebase Admin initializes without production credentials", () => {
  const result = loadFirebaseConfig();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Authentication: 127\.0\.0\.1:9099/);
});

test("remote Auth Emulator host is rejected before Firebase initialization", () => {
  const result = loadFirebaseConfig({
    FIREBASE_AUTH_EMULATOR_HOST: "identitytoolkit.googleapis.com:443",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIREBASE_AUTH_EMULATOR_HOST deve usar/);
});

test("remote Firestore Emulator host is rejected before Firebase initialization", () => {
  const result = loadFirebaseConfig({
    FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIRESTORE_EMULATOR_HOST deve usar/);
});

test("missing Auth Emulator host fails closed", () => {
  const result = loadFirebaseConfig({ FIREBASE_AUTH_EMULATOR_HOST: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIREBASE_AUTH_EMULATOR_HOST deve ser/);
});
