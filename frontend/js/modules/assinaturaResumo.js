// Apenas apresentação: usa somente valores formatados retornados pelo backend.
export function montarResumoAssinatura(opcoes, periodicidade) {
  const mensal = opcoes.mensal;
  const anual = opcoes.anual;

  if (periodicidade === "mensal") {
    return [
      { id: "plano", rotulo: "Plano", valor: opcoes.plano },
      { id: "periodicidade", rotulo: "Periodicidade", valor: "Mensal" },
      { id: "valor", rotulo: "Valor", valor: mensal.valorFormatado },
      {
        id: "total",
        rotulo: "Total",
        valor: mensal.valorFormatado,
        destaque: true,
      },
    ];
  }

  return [
    { id: "plano", rotulo: "Plano", valor: opcoes.plano },
    { id: "periodicidade", rotulo: "Periodicidade", valor: "Anual" },
    {
      id: "valor-original",
      rotulo: "Valor original",
      valor: anual.valorSemDescontoFormatado,
    },
    {
      id: "desconto",
      rotulo: `Desconto anual (${anual.descontoPercentual}%)`,
      valor: `- ${anual.descontoFormatado}`,
    },
    {
      id: "total",
      rotulo: "Total",
      valor: anual.valorFinalFormatado,
      destaque: true,
    },
  ];
}
