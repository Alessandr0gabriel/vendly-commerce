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

const logger = { info() {}, warn() {}, error() {}, debug() {} };

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
        const role = req.get("x-test-role") || "admin";
        req.user = {
          uid: `test-user-${req.get("x-test-estab") || "superadmin"}`,
          establishmentId: req.get("x-test-estab") || null,
          role,
          plan: "full",
          email: "admin@vendly.test",
        };
        next();
      },
      verificarCSRF(req, res, next) {
        if (req.get("x-csrf-token") !== "emulator-csrf") {
          return res
            .status(403)
            .json({ mensagem: "CSRF inválido.", code: "CSRF_INVALIDO" });
        }
        next();
      },
      verificarSuperAdmin(req, res, next) {
        if (req.user?.role !== "superadmin") {
          return res.status(403).json({ mensagem: "Acesso negado!" });
        }
        next();
      },
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
  return (path, { method = "PUT", body, estab, role, csrf = true } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(estab ? { "x-test-estab": estab } : {}),
        ...(role ? { "x-test-role": role } : {}),
        ...(csrf ? { "x-csrf-token": "emulator-csrf" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

async function criarLoja(context, extra = {}) {
  const id = `sec-sa-${randomUUID()}`;
  const ref = db.collection("estabelecimentos").doc(id);
  await ref.set({
    nome: `Loja ${id}`,
    slug: `menu-${id}`,
    status: "active",
    plano: "medio",
    ...extra,
  });
  context.after(() => ref.delete());
  return { id, ref };
}

test("admin comum não consegue alterar plano nem status da própria loja", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);

  for (const body of [{ plan: "full" }, { status: "active" }, { plan: "full", status: "active", telefone: "11999999999" }]) {
    const r = await chamar(`/estabelecimentos/${loja.id}/dados`, {
      estab: loja.id,
      body,
    });
    assert.equal(r.status, 403, JSON.stringify(body));
  }
  const dados = (await loja.ref.get()).data();
  assert.equal(dados.plano, "medio");
  assert.equal(dados.status, "active");
  assert.equal(dados.telefone, undefined);
});

test("admin comum continua salvando o telefone e não altera outra loja", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const outra = await criarLoja(context);

  const ok = await chamar(`/estabelecimentos/${loja.id}/dados`, {
    estab: loja.id,
    body: { telefone: "11999999999" },
  });
  assert.equal(ok.status, 200);

  const negado = await chamar(`/estabelecimentos/${outra.id}/dados`, {
    estab: loja.id,
    body: { telefone: "11888888888" },
  });
  assert.equal(negado.status, 403);
  assert.equal((await outra.ref.get()).data().telefone, undefined);
});

test("superadmin altera plano/status e valores inválidos retornam 400", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);

  const ok = await chamar(`/estabelecimentos/${loja.id}/dados`, {
    role: "superadmin",
    body: { plan: "full", status: "suspended" },
  });
  assert.equal(ok.status, 200);
  const dados = (await loja.ref.get()).data();
  assert.equal(dados.plano, "full");
  assert.equal(dados.status, "suspended");

  for (const body of [{ plan: "ouro" }, { status: "hackeado" }, { telefone: "1".repeat(40) }, { telefone: 123 }]) {
    const r = await chamar(`/estabelecimentos/${loja.id}/dados`, {
      role: "superadmin",
      body,
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test("CSRF inválido bloqueia a alteração", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const r = await chamar(`/estabelecimentos/${loja.id}/dados`, {
    role: "superadmin",
    csrf: false,
    body: { plan: "full" },
  });
  assert.equal(r.status, 403);
  assert.equal((await loja.ref.get()).data().plano, "medio");
});

test("campos extras, aninhados ou de tipo errado são rejeitados", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const maliciosos = [
    { plano: "full" },
    { plan: ["full"] },
    { plan: { $set: "full" } },
    { subscription: { plan: "full" } },
    { telefone: "1", establishment_id: "outra" },
    { __proto__: { plan: "full" }, extra: 1 },
    { mercadopago_access_token: { a: 1 } },
  ];
  for (const role of [undefined, "superadmin"]) {
    for (const body of maliciosos) {
      const r = await chamar(`/estabelecimentos/${loja.id}/dados`, {
        estab: loja.id,
        role,
        body,
      });
      assert.ok([400, 403].includes(r.status), `${role} ${JSON.stringify(body)} -> ${r.status}`);
    }
  }
  const dados = (await loja.ref.get()).data();
  assert.equal(dados.plano, "medio");
  assert.equal(dados.telefone, undefined);
});

test("falha interna devolve erro genérico sem objeto de exceção", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  await loja.ref.delete();
  const r = await chamar(`/estabelecimentos/${loja.id}/dados`, {
    estab: loja.id,
    body: { telefone: "11999999999" },
  });
  assert.equal(r.status, 500);
  const corpo = await r.json();
  assert.deepEqual(Object.keys(corpo), ["mensagem"]);
  assert.doesNotMatch(JSON.stringify(corpo), /NOT_FOUND|stack|code/i);
});

test("GET /admin/list não altera Firestore nem Auth; limpeza é rota separada", async (context) => {
  const chamar = await iniciar(context);
  const id = `inativo-${randomUUID()}`;
  const ref = db.collection("admin").doc(id);
  await ref.set({
    email: `${id}@vendly.test`,
    role: "admin",
    active: false,
    deactivated_at: Timestamp.fromMillis(Date.now() - 30 * 86400000),
  });
  context.after(() => ref.delete());

  const lista = await chamar("/admin/list", { method: "GET", role: "superadmin" });
  assert.equal(lista.status, 200);
  assert.equal((await ref.get()).exists, true);

  const comum = await chamar("/admin/inativos/limpeza", { method: "POST", body: {} });
  assert.equal(comum.status, 403);
  const semCsrf = await chamar("/admin/inativos/limpeza", {
    method: "POST", role: "superadmin", csrf: false, body: {},
  });
  assert.equal(semCsrf.status, 403);
  assert.equal((await ref.get()).exists, true);
});

test("admin comum recebe 403 nas rotas exclusivas do Superadmin", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvos = [
    ["PUT", "/admin/alvo/reset-password", { senha: "NovaSenha123!" }],
    ["PUT", "/admin/alvo/plan", { plan: "full" }],
    ["PATCH", "/admin/alvo/status", { active: false }],
    ["PUT", "/admin/desbloquear/alvo", {}],
    ["GET", "/admin/estabelecimentos", undefined],
    [
      "PUT",
      `/admin/estabelecimentos/${loja.id}/assinatura`,
      { dias: 30 },
    ],
  ];
  for (const [method, path, body] of alvos) {
    const r = await chamar(path, { method, body, estab: loja.id });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
});
