module.exports = function produtoPublico(id, data) {
  const controlaEstoque = data.controla_estoque === true;
  const estoque = controlaEstoque
    ? Math.max(
        0,
        (Number(data.estoque) || 0) - (Number(data.estoque_reservado) || 0),
      )
    : data.estoque;

  return {
    id,
    nome: data.nome,
    descricao: data.descricao,
    categoria: data.categoria,
    preco: data.preco,
    imagem: data.imagem,
    controla_estoque: data.controla_estoque,
    estoque,
    esgotado: controlaEstoque && Number(estoque) <= 0,
  };
};
