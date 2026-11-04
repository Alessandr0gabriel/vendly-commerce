const loadLocalEnv = require("./load-local-env");

try {
  loadLocalEnv();
  process.env.NODE_ENV = "development";
  require("../server");
} catch (err) {
  console.error(`[DEV] Inicialização local bloqueada: ${err.message}`);
  process.exit(1);
}
