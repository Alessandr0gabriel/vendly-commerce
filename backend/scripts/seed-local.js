const loadLocalEnv = require("./load-local-env");

try {
  loadLocalEnv();
} catch (err) {
  console.error(`[DEV] Seed cancelado: ${err.message}`);
  process.exit(1);
}

const { db, auth, FieldValue, Timestamp } = require("../config/firebase");
const withTimeout = require("../utils/withTimeout");
const {
  chaveNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
} = require("../utils/nomeEstabelecimento");

const ADMIN_EMAIL = "admin@vendly.local";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD;
const SUPERADMIN_EMAIL = "superadmin@vendly.local";
const ESTABLISHMENT_ID = "vendly-local-establishment";
const DEFAULT_NAME = "Estabelecimento Teste Local";

function assertEmulatorOnly() {
  const ok =
    process.env.USE_FIREBASE_EMULATOR === "true" &&
    process.env.FIREBASE_PROJECT_ID === "vendly-local" &&
    process.env.FIRESTORE_EMULATOR_HOST === "127.0.0.1:8080" &&
    process.env.FIREBASE_AUTH_EMULATOR_HOST === "127.0.0.1:9099";
  if (!ok) {
    throw new Error(
      "O seed só roda no Emulator vendly-local (Firestore 127.0.0.1:8080, Auth 127.0.0.1:9099).",
    );
  }
}

function getSuperadminPassword() {
  const senha = process.env.LOCAL_SUPERADMIN_PASSWORD || "";
  if (senha.length < 12) {
    throw new Error(
      "Defina LOCAL_SUPERADMIN_PASSWORD (mínimo 12 caracteres) em backend/.env.local.",
    );
  }
  return senha;
}

async function seedLocal() {
  assertEmulatorOnly();
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error("Defina LOCAL_ADMIN_PASSWORD (mínimo 12 caracteres) em backend/.env.local.");
  }
  const superadminPassword = getSuperadminPassword();

  await Promise.all([
    withTimeout(
      () => db.collection("_vendly_emulator_health").limit(1).get(),
      8000,
      "Firestore Emulator",
    ),
    withTimeout(() => auth.listUsers(1), 8000, "Authentication Emulator"),
  ]);

  const user = await findOrCreateUser(ADMIN_EMAIL, ADMIN_PASSWORD);
  const superUser = await findOrCreateUser(
    SUPERADMIN_EMAIL,
    superadminPassword,
  );

  const resultado = [];
  resultado.push(await seedEstabelecimento());
  resultado.push(await seedProduto());
  resultado.push(await seedAdmin(user.uid));
  resultado.push(await seedSuperadmin(superUser.uid));
  resultado.push(await seedIndiceNomes());

  console.log(
    `[DEV] Seed local concluído (idempotente): ${resultado.join("; ")}`,
  );
}

async function seedEstabelecimento() {
  const ref = db.collection("estabelecimentos").doc(ESTABLISHMENT_ID);
  const chave = chaveNomeEstabelecimento(DEFAULT_NAME);
  const reservaRef = referenciaReservaNome(db, chave);

  return db.runTransaction(async (tx) => {
    const [estab, reserva] = await Promise.all([
      tx.get(ref),
      tx.get(reservaRef),
    ]);
    if (estab.exists) return "estabelecimento preservado";
    if (reserva.exists) {
      throw new Error(
        "O nome padrão do seed já está reservado por outra loja; seed interrompido.",
      );
    }
    tx.create(ref, {
      nome: DEFAULT_NAME,
      slug: "vendly-local",
      banner: null,
      telefone: null,
      horarios: {},
      plano: "full",
      assinatura: {
        vence_em: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000),
        dias_carencia: 5,
        em_teste: true,
        atualizado_em: FieldValue.serverTimestamp(),
      },
      created_at: FieldValue.serverTimestamp(),
    });
    tx.create(reservaRef, {
      establishment_id: ESTABLISHMENT_ID,
      nome_normalizado: chave,
      criado_em: FieldValue.serverTimestamp(),
    });
    return "estabelecimento criado";
  });
}

async function seedProduto() {
  const ref = db.collection("produtos").doc("produto-teste-estoque");
  try {
    await ref.create({
      nome: "Produto Teste Estoque",
      descricao: "Produto fictício para validar disponibilidade local.",
      categoria: "Lanches",
      preco: 10,
      imagem: "https://placehold.co/640x480?text=Vendly+Local",
      establishment_id: ESTABLISHMENT_ID,
      controla_estoque: true,
      estoque: 3,
      estoque_reservado: 0,
      mercado_pago_taxa: "assumir",
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    return "produto criado";
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message)) {
      return "produto preservado";
    }
    throw err;
  }
}

async function seedAdmin(uid) {
  const ref = db.collection("admin").doc(uid);
  const estab = await db
    .collection("estabelecimentos")
    .doc(ESTABLISHMENT_ID)
    .get();
  try {
    await ref.create({
      email: ADMIN_EMAIL,
      role: "admin",
      establishment_id: ESTABLISHMENT_ID,
      establishment_name: estab.data()?.nome || DEFAULT_NAME,
      active: true,
      deactivated_at: null,
      tentativas_login: 0,
      bloqueado: false,
      primeiro_login: false,
      session_id: null,
      plan: "full",
    });
    return "admin criado";
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message)) {
      return "admin preservado";
    }
    throw err;
  }
}

async function seedSuperadmin(uid) {
  const ref = db.collection("admin").doc(uid);
  const dados = {
    email: SUPERADMIN_EMAIL,
    role: "superadmin",
    establishment_id: null,
    active: true,
    bloqueado: false,
  };
  const doc = await ref.get();
  if (doc.exists) {
    await ref.update(dados);
    return "superadmin preservado";
  }
  await ref.create({
    ...dados,
    deactivated_at: null,
    tentativas_login: 0,
    primeiro_login: false,
    session_id: null,
    plan: "full",
  });
  return "superadmin criado";
}

// Só marca o índice como pronto se ainda não existir status e todas as lojas
// já tiverem reserva consistente; nunca altera reservas existentes.
async function seedIndiceNomes() {
  const statusRef = referenciaStatusIndiceNomes(db);
  const status = await statusRef.get();
  if (status.exists) {
    return `índice de nomes preservado (ready=${status.data()?.ready})`;
  }

  const lojas = await db.collection("estabelecimentos").get();
  for (const loja of lojas.docs) {
    const nome = loja.data().nome;
    const reserva = await referenciaReservaNome(
      db,
      chaveNomeEstabelecimento(nome),
    ).get();
    if (!reserva.exists || reserva.data()?.establishment_id !== loja.id) {
      return "índice de nomes NÃO marcado como pronto (execute a migração)";
    }
  }
  await statusRef.create({
    ready: true,
    schema_version: 1,
    atualizado_em: FieldValue.serverTimestamp(),
  });
  return "índice de nomes marcado como pronto";
}

async function findOrCreateUser(email, password) {
  try {
    const user = await auth.getUserByEmail(email);
    return await auth.updateUser(user.uid, {
      password,
      emailVerified: true,
      disabled: false,
    });
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }

  return auth.createUser({
    email,
    password,
    emailVerified: true,
    disabled: false,
  });
}

seedLocal().catch((err) => {
  console.error(`[DEV] Falha no seed local: ${err.message}`);
  process.exit(1);
});
