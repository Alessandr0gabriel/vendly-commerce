const assert = require("node:assert/strict");
const loadLocalEnv = require("./load-local-env");

try {
  loadLocalEnv();
} catch (err) {
  console.error(`[DEV] Fluxo local cancelado: ${err.message}`);
  process.exit(1);
}

const { db, auth } = require("../config/firebase");
const { signInWithPassword } = require("../utils/firebaseAuthRest");
const withTimeout = require("../utils/withTimeout");
const API_URL = "http://127.0.0.1:3000/api";
const ADMIN_EMAIL = "admin@vendly.local";
const ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD;
const ESTABLISHMENT_ID = "vendly-local-establishment";
const PRODUCT_ID = "produto-teste-estoque";

function cookieHeader(setCookies) {
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function requireJson(response, label) {
  const body = await response.json();
  assert.equal(
    response.ok,
    true,
    `${label}: ${response.status} ${JSON.stringify(body)}`,
  );
  return body;
}

async function runLocalFlow() {
  await Promise.all([
    withTimeout(
      () => db.collection("_vendly_emulator_health").limit(1).get(),
      8000,
      "Firestore Emulator",
    ),
    withTimeout(() => auth.listUsers(1), 8000, "Authentication Emulator"),
  ]);

  const localToken = await signInWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  const decodedToken = await auth.verifyIdToken(localToken.idToken, true);
  assert.equal(decodedToken.email, ADMIN_EMAIL);
  console.log("[DEV] ID token emitido e verificado pelo Auth Emulator.");

  const loginResponse = await fetch(`${API_URL}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, senha: ADMIN_PASSWORD }),
  });
  const loginData = await requireJson(loginResponse, "login local");
  const setCookies = loginResponse.headers.getSetCookie();
  const cookies = cookieHeader(setCookies);

  assert.equal(loginData.mensagem, "Login sucesso");
  assert.equal(loginData.role, "admin");
  assert.equal(loginData.establishmentId, ESTABLISHMENT_ID);
  assert.ok(loginData.csrfToken);
  assert.match(cookies, /token=/);
  assert.match(cookies, /session-id=/);
  assert.match(cookies, /csrf-token=/);
  assert.equal(
    setCookies.some((cookie) => /;\s*Secure/i.test(cookie)),
    false,
  );

  const adminHeaders = {
    Cookie: cookies,
    "Content-Type": "application/json",
    "x-csrf-token": loginData.csrfToken,
  };
  await requireJson(
    await fetch(`${API_URL}/admin/check-token`, { headers: adminHeaders }),
    "verificarToken",
  );

  const ordersResponse = await fetch(`${API_URL}/admin/pedidos`, {
    headers: adminHeaders,
  });
  await requireJson(ordersResponse, "GET admin/pedidos inicial");
  console.log(
    `[DEV] Session cookie aceita; role=${loginData.role}, establishmentId=${loginData.establishmentId}.`,
  );

  const productRef = db.collection("produtos").doc(PRODUCT_ID);
  const initialProduct = (await productRef.get()).data();
  assert.equal(initialProduct.estoque, 3);
  assert.equal(initialProduct.estoque_reservado, 0);

  const createOrderResponse = await fetch(`${API_URL}/pedidos/salvar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: "vendly-local",
      itens: [{ id: PRODUCT_ID, quantidade: 2 }],
      forma_pagamento: "dinheiro",
      tipo_entrega: "Entrega",
      nome_cliente: "Cliente Local",
      endereco: "Rua de Teste, 123",
      precisa_troco: false,
    }),
  });
  const orderData = await requireJson(
    createOrderResponse,
    "criar pedido local",
  );
  const orderId = orderData.pedido_id;
  assert.ok(orderId);

  const reservedProduct = (await productRef.get()).data();
  assert.equal(reservedProduct.estoque, 3);
  assert.equal(reservedProduct.estoque_reservado, 2);

  const publicProducts = await fetch(
    `${API_URL}/produtos?slug=vendly-local`,
  ).then((response) => response.json());
  const publicProduct = publicProducts.find(
    (product) => product.id === PRODUCT_ID,
  );
  assert.equal(publicProduct.estoque, 1);
  assert.equal(publicProduct.esgotado, false);
  assert.equal(Object.hasOwn(publicProduct, "estoque_reservado"), false);

  const adminOrders = await fetch(`${API_URL}/admin/pedidos`, {
    headers: adminHeaders,
  }).then((response) => response.json());
  assert.ok(adminOrders.some((order) => order.id === orderId));

  const statusResponse = await fetch(
    `${API_URL}/admin/pedidos/${orderId}/status`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "preparando" }),
    },
  );
  await requireJson(statusResponse, "alterar status do pedido");

  const finalizeResponse = await fetch(
    `${API_URL}/admin/pedidos/${orderId}/finalizar`,
    { method: "PUT", headers: adminHeaders },
  );
  await requireJson(finalizeResponse, "finalizar pedido");

  const finalizedProduct = (await productRef.get()).data();
  assert.equal(finalizedProduct.estoque, 1);
  assert.equal(finalizedProduct.estoque_reservado, 0);

  const history = await db
    .collection("historico_pedidos")
    .where("pedido_id", "==", orderId)
    .limit(1)
    .get();
  assert.equal(history.empty, false);

  const duplicateFinalize = await fetch(
    `${API_URL}/admin/pedidos/${orderId}/finalizar`,
    { method: "PUT", headers: adminHeaders },
  );
  assert.equal(duplicateFinalize.status, 404);
  const productAfterRetry = (await productRef.get()).data();
  assert.equal(productAfterRetry.estoque, 1);
  assert.equal(productAfterRetry.estoque_reservado, 0);

  const ordersAfterFinalize = await fetch(`${API_URL}/admin/pedidos`, {
    headers: adminHeaders,
  }).then((response) => response.json());
  assert.equal(
    ordersAfterFinalize.some((order) => order.id === orderId),
    false,
  );

  console.log(
    `[DEV] Fluxo completo passou: pedido=${orderId}, físico=1, reservado=0, disponível=1; retry não alterou estoque.`,
  );
}

runLocalFlow().catch((err) => {
  console.error(`[DEV] Falha no fluxo local: ${err.message}`);
  process.exit(1);
});
