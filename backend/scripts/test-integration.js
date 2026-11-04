const { spawnSync } = require("node:child_process");
const loadLocalEnv = require("./load-local-env");

try {
  loadLocalEnv();
} catch (err) {
  console.error(`[DEV] Teste de integração cancelado: ${err.message}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "test/integration/estoque-emulator.test.js",
    "test/integration/sec01-sec02-emulator.test.js",
    "test/integration/assinatura-emulator.test.js",
    "test/integration/estabelecimentoNome-emulator.test.js",
    "test/integration/superadminSeguranca-emulator.test.js",
    "test/integration/consistenciaAdmin-emulator.test.js",
    "test/integration/migracaoIndiceNomes-emulator.test.js",
  ],
  {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(
    `[DEV] Não foi possível iniciar o teste: ${result.error.message}`,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
