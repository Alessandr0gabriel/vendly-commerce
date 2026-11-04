const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");

assert.equal(
  process.env.USE_FIREBASE_EMULATOR,
  "true",
  "Teste exige USE_FIREBASE_EMULATOR=true",
);

const {
  db,
  auth,
  FieldValue,
  Timestamp,
  AggregateField,
} = require("../../config/firebase");
const createApi = require("../../api");
const {
  chaveNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
} = require("../../utils/nomeEstabelecimento");

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const csrf = (req, res, next) => {
  if (req.get("x-csrf-token") !== "emulator-csrf") {
    return res.status(403).json({ mensagem: "CSRF inválido." });
  }
  next();
};

function criarApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/",
    createApi({
      db,
      auth,
      FieldValue,
      Timestamp,
      AggregateField,
      verificarToken(req, res, next) {
        if (req.get("x-test-auth") === "false") {
          return res.status(401).json({ mensagem: "Sessão inválida." });
        }
        const role = req.get("x-test-role") || "admin";
        req.user = {
          uid: `test-user-${req.get("x-test-estab") || "superadmin"}`,
          establishmentId: req.get("x-test-estab") || null,
          role,
          plan: "full",
          email:
            role === "superadmin"
              ? process.env.DEFAULT_SUPERADMIN_EMAIL
              : "admin@vendly.test",
        };
        next();
      },
      verificarCSRF: csrf,
      verificarSuperAdmin: (req, res, next) => next(),
      upload: { single: () => (req, res, next) => next() },
      loginLimiter: (req, res, next) => next(),
      webhookLimiter: (req, res, next) => next(),
      subscriptionPaymentLimiter: (req, res, next) => next(),
      publicLimiter: (req, res, next) => next(),
      logger,
    }),
  );
  return app;
}

async function iniciar(context) {
  const server = criarApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (
    path,
    {
      method = "GET",
      body,
      estab,
      role,
      auth: authenticated,
      csrf: csrfEnabled = true,
    } = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(estab ? { "x-test-estab": estab } : {}),
        ...(role ? { "x-test-role": role } : {}),
        ...(authenticated === false ? { "x-test-auth": "false" } : {}),
        ...(csrfEnabled ? { "x-csrf-token": "emulator-csrf" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

async function criarLoja(context, nome) {
  const id = `rename-${randomUUID()}`;
  const slug = `menu-${id}`;
  const chave = chaveNomeEstabelecimento(nome);
  const ref = db.collection("estabelecimentos").doc(id);
  const reservaRef = referenciaReservaNome(db, chave);
  await ref.set({ nome, slug, status: "active" });
  await reservaRef.set({
    establishment_id: id,
    nome_normalizado: chave,
  });
  context.after(async () => {
    await Promise.all([ref.delete(), reservaRef.delete()]);
  });
  return { id, slug, nome };
}

async function prepararIndice() {
  await referenciaStatusIndiceNomes(db).set({
    ready: true,
    schema_version: 1,
  });
}

async function limparReserva(context, nome) {
  const ref = referenciaReservaNome(db, chaveNomeEstabelecimento(nome));
  context.after(() => ref.delete());
}

test("nome disponível persiste e não altera o ID ou slug do cardápio", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "Nome anterior");
  const novoNome = "  Café   Central  ";
  await limparReserva(context, novoNome);

  const resposta = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: loja.id,
    body: { nome: novoNome },
  });
  assert.equal(resposta.status, 200);
  assert.equal((await resposta.json()).nome, "Café Central");
  assert.equal(
    (
      await referenciaReservaNome(
        db,
        chaveNomeEstabelecimento(loja.nome),
      ).get()
    ).exists,
    false,
  );

  const recarregada = await chamar("/admin/me/estabelecimento", {
    estab: loja.id,
  });
  assert.equal((await recarregada.json()).nome, "Café Central");

  const menu = await chamar(`/estabelecimentos?slug=${loja.slug}`);
  const dadosMenu = await menu.json();
  assert.equal(menu.status, 200);
  assert.equal(dadosMenu.id, loja.id);
  assert.equal(dadosMenu.slug, loja.slug);
  assert.equal(dadosMenu.nome, "Café Central");
});

test("unicidade ignora diferenças de caixa, acento e espaços", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const lojaA = await criarLoja(context, "Padaria Rita");
  const lojaB = await criarLoja(context, "Mercado Central");

  for (const nome of [
    "padaria rita",
    "  PADARIA   RITA  ",
    "Padaría Rita",
  ]) {
    const resposta = await chamar("/admin/me/estabelecimento/nome", {
      method: "PUT",
      estab: lojaB.id,
      body: { nome },
    });
    assert.equal(resposta.status, 409);
  }
  assert.equal(
    (await db.collection("estabelecimentos").doc(lojaA.id).get()).data().nome,
    lojaA.nome,
  );
});

test("nome duplicado retorna 409, mas salvar o nome atual é permitido", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const lojaA = await criarLoja(context, "Padaria Rita");
  const lojaB = await criarLoja(context, "Mercado do Bairro");

  const conflito = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: lojaB.id,
    body: { nome: "padaria   rita" },
  });
  assert.equal(conflito.status, 409);
  assert.match((await conflito.json()).mensagem, /já está em uso/i);

  const mesmoNome = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: lojaA.id,
    body: { nome: lojaA.nome },
  });
  assert.equal(mesmoNome.status, 200);
  assert.equal((await mesmoNome.json()).nome, "Padaria Rita");
});

test("nome inválido, sessão ausente, CSRF inválido e payload com ID são rejeitados", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "Loja protegida");

  for (const nome of ["", " \t ", "x".repeat(101), 123]) {
    const resposta = await chamar("/admin/me/estabelecimento/nome", {
      method: "PUT",
      estab: loja.id,
      body: { nome },
    });
    assert.equal(resposta.status, 400);
  }

  const semSessao = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: loja.id,
    auth: false,
    body: { nome: "Outro nome" },
  });
  assert.equal(semSessao.status, 401);

  const semCsrf = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: loja.id,
    csrf: false,
    body: { nome: "Outro nome" },
  });
  assert.equal(semCsrf.status, 403);

  const semPermissao = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: loja.id,
    role: "superadmin",
    body: { nome: "Outro nome" },
  });
  assert.equal(semPermissao.status, 403);

  const idArbitrario = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: loja.id,
    body: { nome: "Outro nome", establishmentId: "outro-tenant" },
  });
  assert.equal(idArbitrario.status, 400);

  const aposRequisicoes = await db
    .collection("estabelecimentos")
    .doc(loja.id)
    .get();
  assert.equal(aposRequisicoes.data().nome, loja.nome);
});

test("administrador não pode renomear estabelecimento de outro tenant", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "Loja A");
  const lojaB = await criarLoja(context, "Loja B");

  const resposta = await chamar(
    `/estabelecimentos/${lojaB.id}/dados`,
    {
      method: "PUT",
      estab: loja.id,
      body: { nome: "Tentativa de invasão" },
    },
  );
  assert.equal(resposta.status, 403);
  assert.equal(
    (await db.collection("estabelecimentos").doc(lojaB.id).get()).data().nome,
    lojaB.nome,
  );
});

test("duas lojas concorrentes não reservam o mesmo nome", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const lojaA = await criarLoja(context, "Loja concorrente A");
  const lojaB = await criarLoja(context, "Loja concorrente B");
  const nomeAlvo = `Nome compartilhado ${randomUUID()}`;
  await limparReserva(context, nomeAlvo);

  const respostas = await Promise.all([
    chamar("/admin/me/estabelecimento/nome", {
      method: "PUT",
      estab: lojaA.id,
      body: { nome: nomeAlvo },
    }),
    chamar("/admin/me/estabelecimento/nome", {
      method: "PUT",
      estab: lojaB.id,
      body: { nome: nomeAlvo },
    }),
  ]);
  assert.deepEqual(
    respostas.map((resposta) => resposta.status).sort(),
    [200, 409],
  );
});

test("legado sem reserva não é alterado até o índice ser regularizado", async (context) => {
  await prepararIndice();
  const chamar = await iniciar(context);
  const id = `legacy-${randomUUID()}`;
  const ref = db.collection("estabelecimentos").doc(id);
  await ref.set({ nome: "Loja legada sem reserva", slug: id });
  context.after(() => ref.delete());

  const resposta = await chamar("/admin/me/estabelecimento/nome", {
    method: "PUT",
    estab: id,
    body: { nome: "Nome novo" },
  });
  assert.equal(resposta.status, 409);
  assert.equal((await resposta.json()).code, "INDICE_NOMES_PENDENTE");
  assert.equal((await ref.get()).data().nome, "Loja legada sem reserva");
});

test("cadastro com índice ausente ou pendente retorna 409 INDICE_NOMES_PENDENTE sem criar dados", async (context) => {
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const statusRef = referenciaStatusIndiceNomes(db);
  const original = await statusRef.get();
  context.after(async () => {
    if (original.exists) await statusRef.set(original.data());
    else await statusRef.delete();
  });

  for (const preparar of [
    () => statusRef.delete(),
    () => statusRef.set({ ready: false, migrando: true, schema_version: 1 }),
  ]) {
    await preparar();
    const nome = `Pendente ${randomUUID().slice(0, 8)}`;
    const email = `pend-${randomUUID()}@vendly.test`;
    const resposta = await cadastrar(chamar, email, nome);
    assert.equal(resposta.status, 409);
    const corpo = await resposta.json();
    assert.equal(corpo.code, "INDICE_NOMES_PENDENTE");
    assert.doesNotMatch(JSON.stringify(corpo), /firestore|transaction|stack/i);
    assert.equal(
      (await referenciaReservaNome(db, chaveNomeEstabelecimento(nome)).get())
        .exists,
      false,
    );
    assert.equal((await adminsPorEmail(email)).size, 0);
  }
});

test("cadastros simultâneos com nomes equivalentes: um sucesso e um 409", async (context) => {
  await prepararIndice();
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const base = `Concorrente ${randomUUID().slice(0, 8)}`;
  const emails = [0, 1].map(() => `conc-${randomUUID()}@vendly.test`);
  const reservaRef = referenciaReservaNome(db, chaveNomeEstabelecimento(base));
  context.after(async () => {
    const reserva = await reservaRef.get();
    const idLoja = reserva.data()?.establishment_id;
    for (const email of emails) {
      const usuario = await auth.getUserByEmail(email).catch(() => null);
      if (!usuario) continue;
      await auth.deleteUser(usuario.uid);
      await db.collection("admin").doc(usuario.uid).delete();
    }
    if (idLoja) await db.collection("estabelecimentos").doc(idLoja).delete();
    await reservaRef.delete();
  });

  const respostas = await Promise.all([
    cadastrar(chamar, emails[0], base),
    cadastrar(chamar, emails[1], base.toUpperCase()),
  ]);
  assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 409]);
  const lojas = await db
    .collection("estabelecimentos")
    .where("nome", "in", [base, base.toUpperCase()])
    .get();
  assert.equal(lojas.size, 1);
});


function configurarSuperadmin(context) {
  const anterior = process.env.DEFAULT_SUPERADMIN_EMAIL;
  process.env.DEFAULT_SUPERADMIN_EMAIL = "superadmin@vendly.test";
  context.after(() => {
    if (anterior === undefined) delete process.env.DEFAULT_SUPERADMIN_EMAIL;
    else process.env.DEFAULT_SUPERADMIN_EMAIL = anterior;
  });
}

function cadastrar(chamar, email, nome) {
  return chamar("/admin/register", {
    method: "POST",
    role: "superadmin",
    body: {
      email,
      senha: `Test-${randomUUID()}!`,
      role: "admin",
      establishmentName: nome,
      plan: "full",
    },
  });
}

async function adminsPorEmail(email) {
  return db.collection("admin").where("email", "==", email).get();
}

test("regressão: cadastro com nome de loja existente retorna 409 sem criar usuário nem reutilizar a loja", async (context) => {
  await prepararIndice();
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "Café do Centro");

  for (const nome of ["Café do Centro", "  CAFE   do centro "]) {
    const email = `test-${randomUUID()}@vendly.test`;
    const resposta = await cadastrar(chamar, email, nome);
    assert.equal(resposta.status, 409);
    assert.equal(
      (await resposta.json()).mensagem,
      "Este nome de estabelecimento já está em uso. Escolha outro nome.",
    );
    await assert.rejects(auth.getUserByEmail(email), {
      code: "auth/user-not-found",
    });
    assert.equal((await adminsPorEmail(email)).size, 0);
  }

  const reserva = await referenciaReservaNome(
    db,
    chaveNomeEstabelecimento(loja.nome),
  ).get();
  assert.equal(reserva.data().establishment_id, loja.id);
  assert.equal(
    (await db.collection("estabelecimentos").doc(loja.id).get()).data().nome,
    loja.nome,
  );
});

test("cadastro com nome novo cria loja, reserva e admin; mesmo nome depois retorna 409", async (context) => {
  await prepararIndice();
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const nome = `Padaria ${randomUUID().slice(0, 8)}`;
  const email = `new-${randomUUID()}@vendly.test`;

  const resposta = await cadastrar(chamar, email, nome);
  assert.equal(resposta.status, 200, JSON.stringify(await resposta.json()));
  const usuario = await auth.getUserByEmail(email);
  const adminRef = db.collection("admin").doc(usuario.uid);
  const idLoja = (await adminRef.get()).data().establishment_id;
  const reservaRef = referenciaReservaNome(db, chaveNomeEstabelecimento(nome));
  context.after(async () => {
    await Promise.all([
      auth.deleteUser(usuario.uid),
      adminRef.delete(),
      db.collection("estabelecimentos").doc(idLoja).delete(),
      reservaRef.delete(),
    ]);
  });
  assert.equal((await reservaRef.get()).data().establishment_id, idLoja);

  const segundo = await cadastrar(
    chamar,
    `new-${randomUUID()}@vendly.test`,
    nome.toUpperCase(),
  );
  assert.equal(segundo.status, 409);
});

test("e-mail duplicado retorna 400 e não deixa loja ou reserva órfãs", async (context) => {
  await prepararIndice();
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const email = `dup-${randomUUID()}@vendly.test`;
  const usuario = await auth.createUser({
    email,
    password: `Test-${randomUUID()}!`,
  });
  context.after(() => auth.deleteUser(usuario.uid));

  const nome = `Orfa ${randomUUID().slice(0, 8)}`;
  const chave = chaveNomeEstabelecimento(nome);
  const resposta = await cadastrar(chamar, email, nome);
  assert.equal(resposta.status, 400);
  assert.equal((await referenciaReservaNome(db, chave).get()).exists, false);
  const lojas = await db
    .collection("estabelecimentos")
    .where("nome", "==", nome)
    .get();
  assert.equal(lojas.size, 0);
});

test("cadastros concorrentes com o mesmo nome: um 200 e um 409", async (context) => {
  await prepararIndice();
  configurarSuperadmin(context);
  const chamar = await iniciar(context);
  const nome = `Concorrente ${randomUUID().slice(0, 8)}`;
  const emails = [0, 1].map(() => `conc-${randomUUID()}@vendly.test`);
  const reservaRef = referenciaReservaNome(db, chaveNomeEstabelecimento(nome));

  const respostas = await Promise.all(
    emails.map((e, i) => cadastrar(chamar, e, i ? nome.toUpperCase() : nome)),
  );
  assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 409]);

  const idLoja = (await reservaRef.get()).data().establishment_id;
  context.after(async () => {
    await db.collection("estabelecimentos").doc(idLoja).delete();
    await reservaRef.delete();
    for (const e of emails) {
      const snap = await adminsPorEmail(e);
      for (const d of snap.docs) {
        await auth.deleteUser(d.id).catch(() => {});
        await d.ref.delete();
      }
    }
  });
  const criados = (await Promise.all(emails.map(adminsPorEmail))).flatMap(
    (s) => s.docs,
  );
  assert.equal(criados.length, 1);
  assert.equal(criados[0].data().establishment_id, idLoja);
});
