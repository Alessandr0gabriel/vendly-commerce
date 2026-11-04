const { initializeApp, cert, getApps } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
  AggregateField,
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const useFirestoreEmulator = process.env.USE_FIREBASE_EMULATOR === "true";

function validarHostEmulador(host, variavel) {
  if (!host || host.includes("://") || /[/?#]/.test(host)) {
    throw new Error(
      `[DEV] ${variavel} deve ser host:porta local, sem protocolo.`,
    );
  }

  let endereco;
  try {
    endereco = new URL(`http://${host}`);
  } catch {
    throw new Error(`[DEV] ${variavel} inválido.`);
  }

  const hostsLocais = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const porta = Number(endereco.port);

  if (
    !hostsLocais.has(endereco.hostname) ||
    !Number.isInteger(porta) ||
    porta < 1 ||
    porta > 65535 ||
    endereco.username ||
    endereco.password
  ) {
    throw new Error(
      `[DEV] ${variavel} deve usar localhost, 127.0.0.1 ou ::1 e uma porta válida.`,
    );
  }

  return host;
}

let app;

if (useFirestoreEmulator) {
  const firestoreEmulatorHost = validarHostEmulador(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST",
  );
  const authEmulatorHost = validarHostEmulador(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    "FIREBASE_AUTH_EMULATOR_HOST",
  );
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (projectId !== "vendly-local") {
    throw new Error(
      "[DEV] FIREBASE_PROJECT_ID deve ser exatamente vendly-local no modo Emulator.",
    );
  }

  process.env.FIREBASE_AUTH_EMULATOR_HOST = authEmulatorHost;
  app = getApps()[0] || initializeApp({ projectId });
  console.log("[DEV] Firestore e Authentication Emulators ativos");
  console.log(`[DEV] Projeto: ${projectId}`);
  console.log(`[DEV] Firestore: ${firestoreEmulatorHost}`);
  console.log(`[DEV] Authentication: ${authEmulatorHost}`);
} else {
  let serviceAccount;

  // Credenciais do Firebase Admin SDK devem vir apenas de variáveis de ambiente.
  // Nunca manter um arquivo JSON com a service account no projeto.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error(
        "❌ Erro ao decodificar a variável FIREBASE_SERVICE_ACCOUNT:",
        err.message,
      );
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT inválida. Configure a service account em JSON no ambiente.",
      );
    }
  }

  if (!serviceAccount) {
    throw new Error(
      "❌ Não foi possível carregar as credenciais do Firebase Admin SDK. Defina FIREBASE_SERVICE_ACCOUNT no ambiente.",
    );
  }

  // Inicialização utilizando o padrão modular estável do Firebase Admin SDK.
  app =
    getApps()[0] ||
    initializeApp({
      credential: cert(serviceAccount),
    });
}

// Instâncias dos serviços
const db = getFirestore(app);
const auth = getAuth(app);

module.exports = {
  db,
  auth,
  FieldValue,
  Timestamp,
  AggregateField: AggregateField || {},
};
