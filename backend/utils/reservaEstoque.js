function erroRequisicao(mensagem) {
  const err = new Error(mensagem);
  err.statusCode = 400;
  return err;
}

// Soma as quantidades de itens repetidos para validar o estoque pelo total.
function consolidarItensPorProduto(itens) {
  const porId = new Map();
  for (const item of itens) {
    const id = String(item.id);
    const existente = porId.get(id);
    if (existente) {
      existente.quantidade += item.quantidade;
    } else {
      porId.set(id, { id, quantidade: item.quantidade });
    }
  }
  return [...porId.values()];
}

// Deve rodar dentro de db.runTransaction: todas as leituras precedem os updates.
async function reservarEstoqueDoEstabelecimento({
  db,
  tx,
  FieldValue,
  itens,
  establishmentId,
  mensagemProdutoInvalido = "Produto inválido",
}) {
  const itensConsolidados = consolidarItensPorProduto(itens);
  const refs = itensConsolidados.map((item) =>
    db.collection("produtos").doc(item.id),
  );
  const docs = await Promise.all(refs.map((ref) => tx.get(ref)));

  let total = 0;
  const itensFinal = [];
  const reservas = [];

  for (let i = 0; i < itensConsolidados.length; i++) {
    const item = itensConsolidados[i];
    const doc = docs[i];

    // Mesma resposta para inexistente e de outro tenant, sem vazar informação.
    if (
      !doc.exists ||
      String(doc.data().establishment_id) !== String(establishmentId)
    ) {
      throw erroRequisicao(mensagemProdutoInvalido);
    }

    const produto = doc.data();
    const subtotal = produto.preco * item.quantidade;
    total += subtotal;

    itensFinal.push({
      id: doc.id,
      nome: produto.nome,
      preco: produto.preco,
      quantidade: item.quantidade,
      subtotal,
    });

    if (produto.controla_estoque === true) {
      const disponivel = Math.max(
        0,
        (Number(produto.estoque) || 0) -
          (Number(produto.estoque_reservado) || 0),
      );

      if (disponivel < item.quantidade) {
        throw erroRequisicao(`Estoque insuficiente para ${produto.nome}`);
      }

      reservas.push({ ref: refs[i], quantidade: item.quantidade });
    }
  }

  return {
    total,
    itensFinal,
    aplicarReservas() {
      for (const reserva of reservas) {
        tx.update(reserva.ref, {
          estoque_reservado: FieldValue.increment(reserva.quantidade),
        });
      }
    },
  };
}

module.exports = {
  consolidarItensPorProduto,
  reservarEstoqueDoEstabelecimento,
};
