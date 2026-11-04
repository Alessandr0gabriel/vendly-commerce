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
  reservarEstoqueDoEstabelecimento,
} = require("../../utils/reservaEstoque");

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
  return (path, { method = "POST", body, estab } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(estab ? { "x-test-estab": estab } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

async function criarLoja(context, sufixo) {
  const id = `sec-${sufixo}-${randomUUID()}`;
  const slug = `slug-${id}`;
  const ref = db.collection("estabelecimentos").doc(id);
  await ref.set({ slug, nome: id });
  context.after(() => ref.delete());
  return { id, slug };
}

async function criarProduto(context, loja, dados = {}) {
  const ref = db.collection("produtos").doc(`prod-${randomUUID()}`);
  await ref.set({
    establishment_id: loja.id,
    nome: "Produto",
    preco: 10,
    controla_estoque: true,
    estoque: 3,
    estoque_reservado: 0,
    ...dados,
  });
  context.after(() => ref.delete());
  return ref;
}

async function pedidosDaLoja(loja) {
  const snap = await db
    .collection("pedidos")
    .where("establishment_id", "==", loja.id)
    .get();
  return snap.docs;
}

const estoqueDe = async (ref) => {
  const { estoque, estoque_reservado } = (await ref.get()).data();
  return { estoque, estoque_reservado };
};

function pedido(loja, itens) {
  return {
    slug: loja.slug,
    itens,
    forma_pagamento: "dinheiro",
    tipo_entrega: "retirada",
  };
}

test("SEC-01: pedido da loja A com produto da loja B é rejeitado sem alterar nada", async (context) => {
  const chamar = await iniciar(context);
  const lojaA = await criarLoja(context, "a");
  const lojaB = await criarLoja(context, "b");
  const produtoA = await criarProduto(context, lojaA, { estoque: 5 });
  const produtoB = await criarProduto(context, lojaB, { estoque: 7 });

  const resposta = await chamar("/pedidos/salvar", {
    body: pedido(lojaA, [
      { id: produtoA.id, quantidade: 1 },
      { id: produtoB.id, quantidade: 2 },
    ]),
  });

  assert.equal(resposta.status, 400);
  assert.deepEqual(await estoqueDe(produtoB), {
    estoque: 7,
    estoque_reservado: 0,
  });
  assert.deepEqual(await estoqueDe(produtoA), {
    estoque: 5,
    estoque_reservado: 0,
  });
  assert.equal((await pedidosDaLoja(lojaA)).length, 0);
  assert.equal((await pedidosDaLoja(lojaB)).length, 0);
});

test("SEC-01: validação compartilhada (usada também pelo Pix) rejeita produto de outro tenant atomicamente", async (context) => {
  const lojaA = await criarLoja(context, "a");
  const lojaB = await criarLoja(context, "b");
  const produtoA = await criarProduto(context, lojaA);
  const produtoB = await criarProduto(context, lojaB);

  await assert.rejects(
    db.runTransaction(async (tx) => {
      const r = await reservarEstoqueDoEstabelecimento({
        db,
        tx,
        FieldValue,
        establishmentId: lojaA.id,
        itens: [
          { id: produtoA.id, quantidade: 1 },
          { id: produtoB.id, quantidade: 1 },
        ],
      });
      r.aplicarReservas();
    }),
    { statusCode: 400 },
  );

  assert.deepEqual(await estoqueDe(produtoA), {
    estoque: 3,
    estoque_reservado: 0,
  });
  assert.deepEqual(await estoqueDe(produtoB), {
    estoque: 3,
    estoque_reservado: 0,
  });
});

test("SEC-01: finalizar e excluir não alteram estoque de outro tenant", async (context) => {
  const chamar = await iniciar(context);
  const lojaA = await criarLoja(context, "a");
  const lojaB = await criarLoja(context, "b");
  const produtoB = await criarProduto(context, lojaB, {
    estoque: 4,
    estoque_reservado: 2,
  });

  const criarPedidoLegado = async () => {
    const ref = db.collection("pedidos").doc(`ped-${randomUUID()}`);
    await ref.set({
      establishment_id: lojaA.id,
      status: "pendente",
      forma_pagamento: "dinheiro",
      itens: [{ id: produtoB.id, nome: "x", preco: 1, quantidade: 2 }],
      total: 2,
    });
    context.after(() => ref.delete());
    return ref;
  };

  const p1 = await criarPedidoLegado();
  const fin = await chamar(`/admin/pedidos/${p1.id}/finalizar`, {
    method: "PUT",
    estab: lojaA.id,
  });
  assert.notEqual(fin.status, 200);
  assert.equal((await p1.get()).exists, true);
  assert.deepEqual(await estoqueDe(produtoB), {
    estoque: 4,
    estoque_reservado: 2,
  });

  const p2 = await criarPedidoLegado();
  const del = await chamar(`/admin/pedidos/${p2.id}`, {
    method: "DELETE",
    estab: lojaA.id,
  });
  assert.equal(del.status, 200);
  assert.deepEqual(await estoqueDe(produtoB), {
    estoque: 4,
    estoque_reservado: 2,
  });
});

test("SEC-02: mesmo produto duplicado acima do disponível é rejeitado", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "a");
  const produto = await criarProduto(context, loja);

  const resposta = await chamar("/pedidos/salvar", {
    body: pedido(loja, [
      { id: produto.id, quantidade: 3 },
      { id: produto.id, quantidade: 3 },
    ]),
  });

  assert.equal(resposta.status, 400);
  assert.deepEqual(await estoqueDe(produto), {
    estoque: 3,
    estoque_reservado: 0,
  });
  assert.equal((await pedidosDaLoja(loja)).length, 0);
});

test("SEC-02: duplicados são consolidados e reservam o total (1 + 2 = 3)", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "a");
  const produto = await criarProduto(context, loja);

  const resposta = await chamar("/pedidos/salvar", {
    body: pedido(loja, [
      { id: produto.id, quantidade: 1 },
      { id: produto.id, quantidade: 2 },
    ]),
  });

  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.itens.length, 1);
  assert.equal(corpo.itens[0].quantidade, 3);
  assert.deepEqual(await estoqueDe(produto), {
    estoque: 3,
    estoque_reservado: 3,
  });
  const docs = await pedidosDaLoja(loja);
  docs.forEach((d) => context.after(() => d.ref.delete()));
});

test("pedido normal (loja A + produto A) funciona e a concorrência reserva só a última unidade", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context, "a");
  const produto = await criarProduto(context, loja, { estoque: 1 });

  const respostas = await Promise.all([
    chamar("/pedidos/salvar", {
      body: pedido(loja, [{ id: produto.id, quantidade: 1 }]),
    }),
    chamar("/pedidos/salvar", {
      body: pedido(loja, [{ id: produto.id, quantidade: 1 }]),
    }),
  ]);
  const status = respostas.map((r) => r.status).sort();

  assert.deepEqual(status, [200, 400]);
  assert.deepEqual(await estoqueDe(produto), {
    estoque: 1,
    estoque_reservado: 1,
  });
  const docs = await pedidosDaLoja(loja);
  assert.equal(docs.length, 1);
  docs.forEach((d) => context.after(() => d.ref.delete()));
});
