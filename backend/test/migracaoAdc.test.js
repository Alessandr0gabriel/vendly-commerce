const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const {
  caminhoArquivoAdc,
  validarCredenciaisJson,
  validarFlags,
  validarModoAdc,
} = require("../scripts/migrate-establishment-name-index");

const PROJETO = "sandro-saas";
const CONTA = `vendly-firestore-diagnostico@${PROJETO}.iam.gserviceaccount.com`;
const adcValido = JSON.stringify({
  type: "impersonated_service_account",
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${CONTA}:generateAccessToken`,
});

const base = () => ({
  env: {},
  conteudoAdc: adcValido,
  expectedProject: PROJETO,
  expectedServiceAccount: CONTA,
});

test("ADC impersonado com projeto e conta corretos é aceito", () => {
  assert.deepEqual(validarModoAdc(base()), { serviceAccount: CONTA });
});

test("ADC rejeita Emulator, projeto ausente/divergente e conta inesperada", () => {
  assert.throws(
    () =>
      validarModoAdc({
        ...base(),
        env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      }),
    /Emulator/,
  );
  assert.throws(
    () => validarModoAdc({ ...base(), env: { USE_FIREBASE_EMULATOR: "false" } }),
    /Emulator/,
  );
  assert.throws(
    () => validarModoAdc({ ...base(), expectedProject: null }),
    /sandro-saas/,
  );
  assert.throws(
    () => validarModoAdc({ ...base(), expectedProject: "outro-projeto" }),
    /sandro-saas/,
  );
  assert.throws(
    () => validarModoAdc({ ...base(), env: { GOOGLE_CLOUD_PROJECT: "outro" } }),
    /diverge/,
  );
  assert.throws(
    () =>
      validarModoAdc({
        ...base(),
        expectedServiceAccount:
          "vendly-diagnostico@outro-proj.iam.gserviceaccount.com",
      }),
    /não pertence/,
  );
  assert.throws(
    () => validarModoAdc({ ...base(), apply: true }),
    /confirm-production/,
  );
  assert.deepEqual(
    validarModoAdc({ ...base(), apply: true, confirmProduction: true }),
    { serviceAccount: CONTA },
  );
  assert.throws(
    () =>
      validarModoAdc({
        ...base(),
        conteudoAdc: adcValido.replace("diagnostico", "admin"),
      }),
    /não é a conta de serviço esperada/,
  );
});

test("aplicação ADC exige conta, projeto e confirmação explícita", () => {
  const baseArgs = [
    "--apply",
    "--adc",
    `--expect-project=${PROJETO}`,
    `--expect-service-account=${CONTA}`,
  ];
  assert.throws(() => validarFlags(baseArgs), /confirm-production/);
  assert.equal(
    validarFlags([...baseArgs, "--confirm-production"]).apply,
    true,
  );
  assert.throws(
    () =>
      validarFlags([
        "--apply",
        "--adc",
        `--expect-project=${PROJETO}`,
        "--confirm-production",
      ]),
    /Modo de execução inválido/,
  );
  assert.throws(
    () =>
      validarFlags([
        "--dry-run",
        "--adc",
        `--expect-project=${PROJETO}`,
        `--expect-service-account=${CONTA}`,
        "--confirm-production",
      ]),
    /só pode ser usado com --apply/,
  );
});

test("credenciais JSON recusam placeholder/projeto/conta divergentes e exigem conta explícita no apply", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const conteudo = JSON.stringify({
    type: "service_account",
    project_id: PROJETO,
    client_email: CONTA,
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  assert.deepEqual(
    validarCredenciaisJson({
      conteudo,
      expectedProject: PROJETO,
    }),
    { projectId: PROJETO, serviceAccount: CONTA },
  );
  assert.throws(
    () => validarCredenciaisJson({ conteudo, expectedProject: "outro" }),
    /projeto/,
  );
  assert.throws(
    () =>
      validarCredenciaisJson({
        conteudo,
        expectedProject: PROJETO,
        apply: true,
      }),
    /expect-service-account/,
  );
  assert.throws(
    () =>
      validarCredenciaisJson({
        conteudo,
        expectedProject: PROJETO,
        expectedServiceAccount:
          "vendly-outro@sandro-saas.iam.gserviceaccount.com",
        apply: true,
      }),
    /expect-service-account/,
  );
  assert.throws(
    () =>
      validarCredenciaisJson({
        conteudo: conteudo.replace(PROJETO, "SEU_PROJECT_ID"),
        expectedProject: PROJETO,
      }),
    /placeholder/,
  );
});

test("ADC rejeita chave de service account, usuário comum e arquivo inválido", () => {
  for (const conteudoAdc of [
    JSON.stringify({ type: "service_account", private_key: "x" }),
    JSON.stringify({ type: "authorized_user" }),
    "não é json",
    "",
  ]) {
    assert.throws(() => validarModoAdc({ ...base(), conteudoAdc }));
  }
});

test("caminho do ADC respeita GOOGLE_APPLICATION_CREDENTIALS e o padrão do Windows", () => {
  assert.equal(
    caminhoArquivoAdc({ GOOGLE_APPLICATION_CREDENTIALS: "C:\\x.json" }, "win32"),
    "C:\\x.json",
  );
  assert.match(
    caminhoArquivoAdc({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32"),
    /gcloud[\\/]application_default_credentials\.json$/,
  );
});
