const dotenv = require("dotenv");
const path = require("node:path");

module.exports = function loadEnv() {
  if (process.env.USE_FIREBASE_EMULATOR === "true") {
    return dotenv.config({
      path: path.resolve(__dirname, "../.env.local"),
      quiet: true,
    });
  }

  return dotenv.config();
};
