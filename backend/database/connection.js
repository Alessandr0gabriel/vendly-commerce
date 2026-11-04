require("../config/loadEnv")();

const { db, auth, FieldValue } = require("../config/firebase");
const withTimeout = require("../utils/withTimeout");

// Firestore é schemaless — não existe mais "CREATE TABLE" nem "ALTER TABLE ADD COLUMN".
// As coleções (admin, estabelecimentos, produtos, pedidos, historico_pedidos,
// historico_pedidos_arquivados) são criadas automaticamente no primeiro documento
// gravado em cada uma. Por isso esse arquivo ficou muito mais simples: a única
// responsabilidade que sobra aqui é garantir o superadmin padrão.

async function seedDefaultSuperAdmin() {
  const defaultEmail = process.env.DEFAULT_SUPERADMIN_EMAIL;
  const defaultPassword = process.env.DEFAULT_SUPERADMIN_PASSWORD;
  const defaultRole = process.env.DEFAULT_SUPERADMIN_ROLE;

  let userRecord = null;

  try {
    userRecord = await auth.getUserByEmail(defaultEmail);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw err;
    }
  }

  // Usuário ainda não existe no Firebase Auth -> cria o usuário + o documento em /admin
  if (!userRecord) {
    userRecord = await auth.createUser({
      email: defaultEmail,
      password: defaultPassword,
      emailVerified: true,
      disabled: false,
    });

    await db.collection("admin").doc(userRecord.uid).set({
      email: defaultEmail,
      role: defaultRole,
      establishment_id: null,
      active: true,
      deactivated_at: null,
      tentativas_login: 0,
      bloqueado: false,
      primeiro_login: true,
      created_at: FieldValue.serverTimestamp(),
    });

    console.log(`Superadmin padrão '${defaultEmail}' criado e ativado.`);
    return;
  }

  // Usuário existe no Auth, mas por algum motivo não tem o documento no Firestore
  const adminDoc = await db.collection("admin").doc(userRecord.uid).get();

  if (!adminDoc.exists) {
    await db.collection("admin").doc(userRecord.uid).set({
      email: defaultEmail,
      role: defaultRole,
      establishment_id: null,
      active: true,
      deactivated_at: null,
      tentativas_login: 0,
      bloqueado: false,
      primeiro_login: false,
      created_at: FieldValue.serverTimestamp(),
    });

    console.log(
      `Documento Firestore do superadmin padrão '${defaultEmail}' recriado.`,
    );
    return;
  }

  // Existe e está desativado -> reativa
  if (adminDoc.data().active !== true) {
    await db.collection("admin").doc(userRecord.uid).update({
      active: true,
      deactivated_at: null,
    });

    if (userRecord.disabled) {
      await auth.updateUser(userRecord.uid, { disabled: false });
    }

    console.log(`Superadmin padrão '${defaultEmail}' reativado.`);
  }
}

async function initConnection() {
  if (process.env.USE_FIREBASE_EMULATOR === "true") {
    await Promise.all([
      withTimeout(
        () => db.collection("_vendly_emulator_health").limit(1).get(),
        8000,
        "Firestore Emulator",
      ),
      withTimeout(() => auth.listUsers(1), 8000, "Authentication Emulator"),
    ]);
    console.log("[DEV] Firestore e Auth Emulators responderam localmente.");
  } else if (
    process.env.SEED_DEFAULT_SUPERADMIN === "true" ||
    process.env.NODE_ENV !== "production"
  ) {
    await seedDefaultSuperAdmin();
  }

  console.log(
    process.env.USE_FIREBASE_EMULATOR === "true"
      ? "[DEV] Firestore e Auth Emulators conectados com sucesso."
      : "Firebase (Firestore + Auth) conectado com sucesso!",
  );

  return { db, auth };
}

module.exports = initConnection();
