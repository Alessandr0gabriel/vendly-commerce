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

const passthrough = (req, res, next) => next();
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
        req.user = { establishmentId: req.get("x-test-estab"), role: "admin" };
        next();
      },
      verificarCSRF: passthrough,
      verificarSuperAdmin: passthrough,
      upload: { single: () => passthrough },
      loginLimiter: passthrough,
      webhookLimiter: passthrough,
      subscriptionPaymentLimiter: passthrough,
      publicLimiter: passthrough,
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
  return (path, establishmentId) =>
    fetch(base + path, {
      headers: establishmentId
        ? { "x-test-estab": establishmentId }
        : {},
    });
}

test("opções de cobrança usam o plano autenticado e rejeitam IDs enviados pelo cliente", async (context) => {
  const sufixo = randomUUID();
  const establishmentId = `assinatura-${sufixo}`;
  const estabelecimentoRef = db
    .collection("estabelecimentos")
    .doc(establishmentId);
  const planosRef = db.collection("configuracoes").doc("planos_landing");
  const planosOriginais = await planosRef.get();
  const dadosPlanosOriginais = planosOriginais.exists
    ? planosOriginais.data()
    : null;
  context.after(async () => {
    await estabelecimentoRef.delete();
    if (dadosPlanosOriginais) await planosRef.set(dadosPlanosOriginais);
    else await planosRef.delete();
  });

  await planosRef.set({
    planos: [{ id: "basico", nome: "Plano Básico", preco: 99.99 }],
  });
  await estabelecimentoRef.set({ plano: "basico" });

  const request = await iniciar(context);
  const response = await request(
    "/pagamentos-assinatura/opcoes",
    establishmentId,
  );
  assert.equal(response.status, 200);
  const valores = await response.json();
  assert.equal(valores.plano, "Básico");
  assert.equal(valores.mensal.valorCentavos, 9999);
  assert.equal(valores.anual.valorSemDescontoCentavos, 119988);
  assert.equal(valores.anual.valorFinalCentavos, 107989);

  const comIdArbitrario = await request(
    `/pagamentos-assinatura/opcoes?establishmentId=${encodeURIComponent(establishmentId)}`,
    `outro-${sufixo}`,
  );
  assert.equal(comIdArbitrario.status, 400);
});

test("opcoes usam a oferta anual ativa de configuracoes/planos_landing", async (context) => {
  const establishmentId = `assinatura-oferta-${randomUUID()}`;
  const estabelecimentoRef = db.collection("estabelecimentos").doc(establishmentId);
  const planosRef = db.collection("configuracoes").doc("planos_landing");
  const original = await planosRef.get();
  context.after(async () => {
    await estabelecimentoRef.delete();
    if (original.exists) await planosRef.set(original.data());
    else await planosRef.delete();
  });
  await planosRef.set({
    planos: [{ id: "full", nome: "Plano Full", preco: 129.99 }],
    oferta: {
      ativa: true,
      planoId: "full",
      precoOriginal: 1559.88,
      precoComDesconto: 1169.91,
      percentualDesconto: 25,
      economia: 389.97,
    },
  });
  await estabelecimentoRef.set({ plano: "full" });
  const request = await iniciar(context);
  const valores = await (await request("/pagamentos-assinatura/opcoes", establishmentId)).json();
  assert.equal(valores.anual.valorFinalCentavos, 116991);
  assert.equal(valores.anual.descontoPercentual, 25);
  assert.equal(valores.anual.economiaCentavos, 38997);

  await planosRef.update({ "oferta.ativa": false });
  const sem = await (await request("/pagamentos-assinatura/opcoes", establishmentId)).json();
  assert.equal(sem.anual.descontoPercentual, 10);
});
