module.exports = function deveConsumirEstoqueNaFinalizacao(pedido) {
  return pedido.forma_pagamento !== "pix" || pedido.estoque_baixado === false;
};
