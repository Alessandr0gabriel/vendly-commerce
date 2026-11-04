const test = require("node:test");
const assert = require("node:assert/strict");
const produtoPublico = require("../utils/produtoPublico");

function produtoComEstoque(estoque, estoqueReservado) {
  return {
    nome: "Produto",
    controla_estoque: true,
    estoque,
    estoque_reservado: estoqueReservado,
  };
}

test("produto público expõe estoque físico sem reservas", () => {
  const produto = produtoPublico("produto-1", produtoComEstoque(3, 0));
  assert.equal(produto.estoque, 3);
  assert.equal(produto.esgotado, false);
  assert.equal("estoque_reservado" in produto, false);
});

test("produto público subtrai reservas do estoque disponível", () => {
  const dados = produtoComEstoque(3, 2);
  const produto = produtoPublico("produto-1", dados);
  assert.equal(produto.estoque, 1);
  assert.equal(produto.esgotado, false);
  assert.equal(dados.estoque, 3);
  assert.equal(dados.estoque_reservado, 2);
});

test("produto público fica esgotado quando a reserva consome todo estoque", () => {
  const produto = produtoPublico("produto-1", produtoComEstoque(3, 3));
  assert.equal(produto.estoque, 0);
  assert.equal(produto.esgotado, true);
});

test("produto público nunca expõe estoque disponível negativo", () => {
  const produto = produtoPublico("produto-1", produtoComEstoque(3, 5));
  assert.equal(produto.estoque, 0);
  assert.equal(produto.esgotado, true);
});

test("produto sem controle preserva o estoque atual e não fica esgotado", () => {
  const produto = produtoPublico("produto-1", {
    ...produtoComEstoque(3, 2),
    controla_estoque: false,
  });
  assert.equal(produto.estoque, 3);
  assert.equal(produto.esgotado, false);
  assert.equal("estoque_reservado" in produto, false);
});
