const dotenv = require("dotenv");
const path = require("node:path");

module.exports = function loadLocalEnv() {
  dotenv.config({
    path: path.resolve(__dirname, "../.env.local"),
    quiet: true,
  });

  if (process.env.USE_FIREBASE_EMULATOR !== "true") {
    throw new Error(
      "USE_FIREBASE_EMULATOR=true é obrigatório. Configure backend/.env.local.",
    );
  }

  if (
    !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIREBASE_PROJECT_ID !== "vendly-local"
  ) {
    throw new Error(
      "Configure FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST e FIREBASE_PROJECT_ID=vendly-local em backend/.env.local.",
    );
  }
};
