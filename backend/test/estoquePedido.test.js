const test = require("node:test");
const assert = require("node:assert/strict");
const deveConsumirEstoqueNaFinalizacao = require("../utils/estoquePedido");

test("pedido comum consome estoque ao finalizar", () => {
  assert.equal(
    deveConsumirEstoqueNaFinalizacao({ forma_pagamento: "dinheiro" }),
    true,
  );
});

test("novo pedido Pix mantém consumo para a finalização", () => {
  assert.equal(
    deveConsumirEstoqueNaFinalizacao({
      forma_pagamento: "pix",
      estoque_baixado: false,
    }),
    true,
  );
});

test("pedido Pix legado é considerado já consumido", () => {
  assert.equal(
    deveConsumirEstoqueNaFinalizacao({ forma_pagamento: "pix" }),
    false,
  );
});
