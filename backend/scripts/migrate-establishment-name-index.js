const {
  ID_STATUS_INDICE,
  COLECAO_RESERVAS,
  chaveNomeEstabelecimento,
  normalizarNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
} = require("../utils/nomeEstabelecimento");

const SCHEMA_VERSION = 1;

// Fase 1: somente leitura. Nunca grava; devolve o relatório completo.
async function analisarIndice(db) {
  const [estabs, reservas, statusSnap] = await Promise.all([
    db.collection("estabelecimentos").get(),
    db.collection(COLECAO_RESERVAS).get(),
    referenciaStatusIndiceNomes(db).get(),
  ]);

  const status = statusSnap.exists ? statusSnap.data() : null;
  const relatorio = {
    totalEstabelecimentos: estabs.size,
    semNome: [],
    colisoes: [],
    reservasDeOutroDono: [],
    reservasChaveIncompativel: [],
    reservasOrfas: [],
    reservasDivergentes: [],
    schemaIncompativel: false,
    ready: status?.ready === true,
    aCriar: [],
    bloqueios: [],
  };

  if (status && status.schema_version !== SCHEMA_VERSION) {
    relatorio.schemaIncompativel = true;
  }

  const idsEstab = new Set(estabs.docs.map((d) => d.id));
  const porChave = new Map();
  const chavePorEstab = new Map();

  for (const doc of estabs.docs) {
    const nome = normalizarNomeEstabelecimento(doc.data()?.nome);
    if (!nome) {
      relatorio.semNome.push(doc.id);
      continue;
    }
    const chave = chaveNomeEstabelecimento(nome);
    const anterior = porChave.get(chave);
    if (anterior) {
      anterior.ids.push(doc.id);
      continue;
    }
    porChave.set(chave, { ids: [doc.id], nome });
    chavePorEstab.set(doc.id, chave);
  }
  for (const [chave, item] of porChave) {
    if (item.ids.length > 1) {
      relatorio.colisoes.push({ chave, nome: item.nome, ids: item.ids });
    }
  }

  const reservasPorId = new Map();
  for (const doc of reservas.docs) {
    if (doc.id === ID_STATUS_INDICE) continue;
    const dados = doc.data() || {};
    reservasPorId.set(doc.id, dados);

    const chaveGravada = dados.nome_normalizado;
    const coerente =
      typeof chaveGravada === "string" &&
      chaveNomeEstabelecimento(chaveGravada) === chaveGravada &&
      referenciaReservaNome(db, chaveGravada).id === doc.id;
    if (!coerente) {
      relatorio.reservasChaveIncompativel.push(doc.id);
      continue;
    }
    if (!idsEstab.has(dados.establishment_id)) {
      relatorio.reservasOrfas.push(doc.id);
      continue;
    }
    if (chavePorEstab.get(dados.establishment_id) !== chaveGravada) {
      relatorio.reservasDivergentes.push({
        reserva: doc.id,
        establishment_id: dados.establishment_id,
      });
    }
  }

  for (const [chave, item] of porChave) {
    if (item.ids.length > 1) continue;
    const id = referenciaReservaNome(db, chave).id;
    const existente = reservasPorId.get(id);
    if (!existente) {
      relatorio.aCriar.push({ chave, establishment_id: item.ids[0] });
    } else if (existente.establishment_id !== item.ids[0]) {
      relatorio.reservasDeOutroDono.push({
        chave,
        reserva: id,
        establishment_id: item.ids[0],
        dono: existente.establishment_id,
      });
    }
  }

  if (relatorio.schemaIncompativel) {
    relatorio.bloqueios.push("schema_version do _meta incompatível");
  }
  if (relatorio.colisoes.length) relatorio.bloqueios.push("colisões de nomes");
  if (relatorio.reservasDeOutroDono.length) {
    relatorio.bloqueios.push("reservas pertencentes a outro estabelecimento");
  }
  if (relatorio.reservasChaveIncompativel.length) {
    relatorio.bloqueios.push(
      "reservas com chave incompatível com a normalização atual",
    );
  }
  if (relatorio.reservasOrfas.length) {
    relatorio.bloqueios.push(
      "reservas órfãs (estabelecimento inexistente); resolver manualmente",
    );
  }
  if (relatorio.reservasDivergentes.length) {
    relatorio.bloqueios.push(
      "reservas divergentes do nome atual do estabelecimento; resolver manualmente",
    );
  }
  return relatorio;
}

const LEASE_MS = 5 * 60 * 1000;

// Lease no próprio _meta, adquirido por transação: só um migrador por vez.
// Expira sozinho, então uma execução interrompida não trava o índice para sempre.
async function adquirirLease(db, FieldValue, dono, leaseMs) {
  const statusRef = referenciaStatusIndiceNomes(db);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(statusRef);
    const atual = snap.exists ? snap.data() : {};
    if (
      atual.migracao_dono &&
      atual.migracao_dono !== dono &&
      Number(atual.migracao_expira_em) > Date.now()
    ) {
      const err = new Error(
        "Outra migração está em andamento (lease ativo); nada foi alterado.",
      );
      err.codigo = "MIGRACAO_EM_ANDAMENTO";
      throw err;
    }
    tx.set(statusRef, {
      ready: false,
      migrando: true,
      schema_version: SCHEMA_VERSION,
      migracao_dono: dono,
      migracao_expira_em: Date.now() + leaseMs,
      atualizado_em: FieldValue.serverTimestamp(),
    });
  });
}

async function liberarLease(db, dono) {
  const statusRef = referenciaStatusIndiceNomes(db);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(statusRef);
    if (snap.exists && snap.data().migracao_dono === dono) {
      tx.set(statusRef, {
        ready: false,
        migrando: false,
        schema_version: SCHEMA_VERSION,
      });
    }
  });
}

function exigirLease(snap, dono) {
  const d = snap.exists ? snap.data() : {};
  if (d.migracao_dono !== dono || Number(d.migracao_expira_em) <= Date.now()) {
    const err = new Error("Lease da migração perdido; execução abortada.");
    err.codigo = "LEASE_PERDIDO";
    throw err;
  }
}

async function executarMigracao({
  db,
  FieldValue,
  apply = false,
  log = () => {},
  hooks = {},
  leaseMs = LEASE_MS,
}) {
  // 1) Toda a pré-validação, sem tocar em _meta.
  const relatorio = await analisarIndice(db);
  log(
    `Pré-validação: ${relatorio.totalEstabelecimentos} estabelecimentos; ${relatorio.aCriar.length} reservas a criar; ${relatorio.bloqueios.length} bloqueios.`,
  );
  relatorio.aplicado = false;

  if (relatorio.bloqueios.length) {
    const err = new Error(
      `Migração bloqueada sem alterar dados: ${relatorio.bloqueios.join("; ")}.`,
    );
    err.relatorio = relatorio;
    throw err;
  }
  if (!apply) return relatorio;

  const statusRef = referenciaStatusIndiceNomes(db);
  if (relatorio.ready && relatorio.aCriar.length === 0) {
    relatorio.aplicado = true;
    return relatorio;
  }

  // 2) Fecha o índice (cadastro/renomeação exigem ready === true) e cria as
  // reservas faltantes sem sobrescrever. Falha aqui deixa ready=false e a
  // reexecução retoma de onde parou.
  const dono = require("crypto").randomUUID();
  await adquirirLease(db, FieldValue, dono, leaseMs);

  try {
    // Com o lease, reanalisa: o estado pode ter mudado desde a pré-validação.
    const reanalise = await analisarIndice(db);
    if (reanalise.bloqueios.length) {
      const err = new Error(
        `Migração bloqueada: ${reanalise.bloqueios.join("; ")}. Índice mantido indisponível (ready=false).`,
      );
      err.relatorio = reanalise;
      throw err;
    }

    for (const item of reanalise.aCriar) {
      const reservaRef = referenciaReservaNome(db, item.chave);
      const estabRef = db
        .collection("estabelecimentos")
        .doc(item.establishment_id);
      await db.runTransaction(async (tx) => {
        const [reserva, estab, meta] = await Promise.all([
          tx.get(reservaRef),
          tx.get(estabRef),
          tx.get(statusRef),
        ]);
        exigirLease(meta, dono);
        tx.update(statusRef, { migracao_expira_em: Date.now() + leaseMs });
        if (reserva.exists) {
          if (reserva.data()?.establishment_id !== item.establishment_id) {
            throw new Error(
              "Conflito concorrente; reserva existente preservada.",
            );
          }
          return;
        }
        const nome = estab.exists
          ? normalizarNomeEstabelecimento(estab.data()?.nome)
          : null;
        if (!nome || chaveNomeEstabelecimento(nome) !== item.chave) {
          throw new Error("Estabelecimento mudou durante a migração.");
        }
        tx.create(reservaRef, {
          establishment_id: item.establishment_id,
          nome_normalizado: item.chave,
          criado_em: FieldValue.serverTimestamp(),
        });
      });
      if (hooks.aposReserva) await hooks.aposReserva(item);
    }

    // 3) Revalida tudo; só então libera o índice.
    const final = await analisarIndice(db);
    if (final.bloqueios.length || final.aCriar.length) {
      const err = new Error(
        "Verificação final falhou; índice mantido indisponível (ready=false).",
      );
      err.relatorio = final;
      throw err;
    }
    await db.runTransaction(async (tx) => {
      exigirLease(await tx.get(statusRef), dono);
      tx.set(statusRef, {
        ready: true,
        schema_version: SCHEMA_VERSION,
        atualizado_em: FieldValue.serverTimestamp(),
      });
    });
    final.aplicado = true;
    final.reservasCriadas = reanalise.aCriar.length;
    return final;
  } catch (err) {
    // Falha limpa: libera o lease (ready continua false) para retomada imediata.
    // Se o processo morrer, o lease expira sozinho.
    await liberarLease(db, dono).catch(() => {});
    throw err;
  }
}

const VARIAVEIS_EMULATOR = [
  "USE_FIREBASE_EMULATOR",
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
];
const PROJETO_PRODUCAO = "sandro-saas";
const REGEX_EMAIL_SA = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

function caminhoArquivoAdc(env = process.env, plataforma = process.platform) {
  const path = require("node:path");
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (plataforma === "win32") {
    return path.join(
      env.APPDATA || "",
      "gcloud",
      "application_default_credentials.json",
    );
  }
  return path.join(
    env.HOME || "",
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
}

// Valida o modo ADC sem tocar na rede. Só aceita credencial impersonada,
// nunca chave privada, e nunca devolve segredos (apenas o e-mail da conta).
function validarModoAdc({
  env,
  conteudoAdc,
  expectedProject,
  expectedServiceAccount,
  apply = false,
  confirmProduction = false,
}) {
  const emulador = VARIAVEIS_EMULATOR.filter((v) => env[v]);
  if (emulador.length) {
    throw new Error(
      `--adc é incompatível com variáveis de Emulator definidas (${emulador.join(", ")}).`,
    );
  }
  if (expectedProject !== PROJETO_PRODUCAO) {
    throw new Error(`--adc exige --expect-project=${PROJETO_PRODUCAO}.`);
  }
  if (apply && !confirmProduction) {
    throw new Error("Aplicação ADC em produção exige --confirm-production.");
  }
  for (const v of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]) {
    if (env[v] && env[v] !== expectedProject) {
      throw new Error(`${v} diverge do projeto esperado.`);
    }
  }
  if (!REGEX_EMAIL_SA.test(expectedServiceAccount || "")) {
    throw new Error(
      "--adc exige --expect-service-account=<conta>@<projeto>.iam.gserviceaccount.com.",
    );
  }
  if (
    !expectedServiceAccount.endsWith(
      `@${expectedProject}.iam.gserviceaccount.com`,
    )
  ) {
    throw new Error("A conta de serviço não pertence ao projeto esperado.");
  }

  let adc;
  try {
    adc = JSON.parse(conteudoAdc);
  } catch {
    throw new Error(
      "Arquivo ADC ausente ou inválido. Execute o login ADC com impersonação.",
    );
  }
  if (adc?.type !== "impersonated_service_account") {
    throw new Error(
      "O ADC deve ser do tipo impersonated_service_account (chaves de service account não são aceitas no modo --adc).",
    );
  }
  const match = /serviceAccounts\/([^/:]+):generateAccessToken/.exec(
    String(adc.service_account_impersonation_url || ""),
  );
  if (!match || match[1] !== expectedServiceAccount) {
    throw new Error(
      "A conta impersonada no ADC não é a conta de serviço esperada.",
    );
  }
  return { serviceAccount: match[1] };
}

function validarCredenciaisJson({
  conteudo,
  expectedProject,
  expectedServiceAccount,
  apply = false,
}) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(conteudo);
  } catch {
    throw new Error("Credenciais JSON ausentes ou inválidas.");
  }
  let chavePrivadaValida = false;
  if (typeof serviceAccount?.private_key === "string") {
    try {
      chavePrivadaValida =
        require("node:crypto").createPrivateKey(serviceAccount.private_key)
          .asymmetricKeyType === "rsa";
    } catch {
      // A chave não é válida; não propagar dados do conteúdo para o erro.
    }
  }
  if (
    !serviceAccount ||
    serviceAccount.type !== "service_account" ||
    !chavePrivadaValida ||
    !REGEX_EMAIL_SA.test(serviceAccount.client_email || "") ||
    !serviceAccount.project_id ||
    serviceAccount.project_id === "SEU_PROJECT_ID"
  ) {
    throw new Error("Credenciais JSON ausentes, placeholder ou inválidas.");
  }
  if (
    expectedProject !== PROJETO_PRODUCAO ||
    serviceAccount.project_id !== PROJETO_PRODUCAO
  ) {
    throw new Error(
      "Projeto esperado e projeto das credenciais devem ser sandro-saas.",
    );
  }
  if (
    apply &&
    (!expectedServiceAccount ||
      serviceAccount.client_email !== expectedServiceAccount ||
      !expectedServiceAccount.endsWith(
        `@${PROJETO_PRODUCAO}.iam.gserviceaccount.com`,
      ))
  ) {
    throw new Error(
      "Aplicação exige --expect-service-account igual à conta das credenciais no projeto sandro-saas.",
    );
  }
  return {
    projectId: serviceAccount.project_id,
    serviceAccount: serviceAccount.client_email,
  };
}

function validarFlags(args) {
  const valorOpcao = (nome) => {
    const encontrados = args.filter((a) => a.startsWith(`${nome}=`));
    if (encontrados.length > 1) {
      throw new Error(`Opção repetida: ${nome}.`);
    }
    return encontrados.length ? encontrados[0].slice(nome.length + 1) : null;
  };
  const expectedProject = valorOpcao("--expect-project");
  const expectedServiceAccount = valorOpcao("--expect-service-account");
  const opcoesComValor = ["--expect-project", "--expect-service-account"];
  const flags = args.filter((a) => !a.includes("="));
  const options = new Set(flags);
  if (options.size !== flags.length) {
    throw new Error("Opção repetida.");
  }
  if (
    args.some((a) =>
      a.includes("=")
        ? !opcoesComValor.some((o) => a.startsWith(`${o}=`))
        : ![
            "--dry-run",
            "--apply",
            "--emulator",
            "--confirm-production",
            "--adc",
          ].includes(a),
    )
  ) {
    throw new Error("Opção desconhecida.");
  }

  const dryRun = options.has("--dry-run");
  const apply = options.has("--apply");
  const usarAdc = options.has("--adc");
  if (dryRun === apply || (usarAdc && !expectedServiceAccount && apply)) {
    throw new Error("Modo de execução inválido.");
  }
  if (usarAdc && apply && !options.has("--confirm-production")) {
    throw new Error("Aplicação ADC em produção exige --confirm-production.");
  }
  if (usarAdc && options.has("--emulator")) {
    throw new Error("--adc não pode ser combinado com --emulator.");
  }
  if (options.has("--confirm-production") && !apply) {
    throw new Error("--confirm-production só pode ser usado com --apply.");
  }
  if (expectedServiceAccount && !usarAdc && !apply) {
    throw new Error(
      "--expect-service-account só pode ser usado com --adc ou --apply.",
    );
  }
  return {
    expectedProject,
    expectedServiceAccount,
    usarAdc,
    dryRun,
    apply,
    emulator: options.has("--emulator"),
    confirmProduction: options.has("--confirm-production"),
  };
}

function inicializarFirestoreAdc(projectId) {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  const app = initializeApp(
    { credential: applicationDefault(), projectId },
    "migracao-indice-nomes-adc",
  );
  return { db: getFirestore(app), FieldValue };
}

async function main() {
  const loadEnv = require("../config/loadEnv");
  const args = process.argv.slice(2);
  let configuracao;
  try {
    configuracao = validarFlags(args);
  } catch (err) {
    console.error(
      "Uso: node scripts/migrate-establishment-name-index.js --dry-run|--apply [--emulator|--confirm-production]\n" +
        "     ADC: --dry-run|--apply --adc --expect-project=sandro-saas --expect-service-account=<conta> [--confirm-production]",
    );
    console.error(`Migração bloqueada: ${err.message}`);
    process.exit(1);
  }
  const {
    expectedProject,
    expectedServiceAccount,
    usarAdc,
    apply,
    emulator,
    confirmProduction,
  } = configuracao;

  try {
    loadEnv();
  } catch (err) {
    console.error(`Migração bloqueada: ${err.message}`);
    process.exit(1);
  }

  const emulatorAtivo =
    process.env.USE_FIREBASE_EMULATOR === "true";
  if (
    !emulatorAtivo &&
    VARIAVEIS_EMULATOR.some(
      (variavel) =>
        process.env[variavel] !== undefined &&
        process.env[variavel] !== "",
    )
  ) {
    console.error(
      "Migração bloqueada: remova todas as variáveis do Firebase Emulator antes de acessar produção.",
    );
    process.exit(1);
  }

  if (usarAdc) {
    try {
      let conteudoAdc = "";
      try {
        conteudoAdc = require("node:fs").readFileSync(
          caminhoArquivoAdc(),
          "utf8",
        );
      } catch {
        // validarModoAdc reporta ADC ausente.
      }
      const { serviceAccount } = validarModoAdc({
        env: process.env,
        conteudoAdc,
        expectedProject,
        expectedServiceAccount,
        apply,
        confirmProduction,
      });
      console.log(
        `Projeto Firebase: ${expectedProject}; ADC impersonando ${serviceAccount} (Emulator desativado)`,
      );
      const { db, FieldValue } = inicializarFirestoreAdc(expectedProject);
      const relatorio = await executarMigracao({
        db,
        FieldValue,
        apply,
        log: console.log,
      });
      console.log(JSON.stringify(relatorio, null, 2));
      console.log(
        apply
          ? "Migração aplicada e validada."
          : "Dry-run: nenhuma gravação foi feita.",
      );
    } catch (err) {
      if (err.relatorio) {
        console.error(`Migração interrompida: ${err.message}`);
        console.error(JSON.stringify(err.relatorio, null, 2));
      } else {
        console.error(
          `Migração interrompida sem relatório. Código: ${err.code || "indisponível"}. Verifique ADC, IAM e conectividade.`,
        );
      }
      process.exitCode = 1;
    }
    return;
  }

  if (emulator && process.env.USE_FIREBASE_EMULATOR !== "true") {
    console.error("--emulator exige USE_FIREBASE_EMULATOR=true.");
    process.exit(1);
  }
  if (
    apply &&
    process.env.USE_FIREBASE_EMULATOR !== "true" &&
    !confirmProduction
  ) {
    console.error(
      "Aplicação fora do Emulator exige a opção explícita --confirm-production.",
    );
    process.exit(1);
  }

  if (process.env.USE_FIREBASE_EMULATOR !== "true") {
    let credenciais;
    try {
      credenciais = validarCredenciaisJson({
        conteudo: process.env.FIREBASE_SERVICE_ACCOUNT,
        expectedProject,
        expectedServiceAccount,
        apply,
      });
    } catch {
      console.error(
        "Migração bloqueada: credenciais JSON inválidas/placeholder ou projeto/conta não correspondentes.",
      );
      process.exit(1);
    }
    console.log(`Projeto Firebase: ${credenciais.projectId} (Emulator desativado)`);
  }

  try {
    const { db, FieldValue } = require("../config/firebase");
    const relatorio = await executarMigracao({
      db,
      FieldValue,
      apply,
      log: console.log,
    });
    console.log(JSON.stringify(relatorio, null, 2));
    console.log(
      apply ? "Índice de nomes pronto." : "Dry-run: nenhuma gravação foi feita.",
    );
  } catch (err) {
    if (err.relatorio) {
      console.error(`Migração interrompida: ${err.message}`);
      console.error(JSON.stringify(err.relatorio, null, 2));
    } else {
      console.error(
        `Migração interrompida sem relatório. Código: ${err.code || "indisponível"}. Verifique credenciais, IAM e conectividade.`,
      );
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  analisarIndice,
  executarMigracao,
  SCHEMA_VERSION,
  caminhoArquivoAdc,
  validarModoAdc,
  validarFlags,
  validarCredenciaisJson,
  PROJETO_PRODUCAO,
};
