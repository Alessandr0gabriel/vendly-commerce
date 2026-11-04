const PERIODOS_ASSINATURA = Object.freeze({
  mensal: 30,
  anual: 365,
});

function timestampParaMillis(valor) {
  if (!valor) return null;
  if (typeof valor.toMillis === "function") return valor.toMillis();
  if (typeof valor._seconds === "number") {
    return (
      valor._seconds * 1000 + Math.floor((valor._nanoseconds || 0) / 1000000)
    );
  }
  const millis = new Date(valor).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function calcularStatusAssinatura(assinatura, agora = Date.now()) {
  if (!assinatura || !timestampParaMillis(assinatura.vence_em)) {
    return { status: "nao_configurada", em_teste: false };
  }

  const venceEm = timestampParaMillis(assinatura.vence_em);
  const diasCarencia =
    Number.isInteger(assinatura.dias_carencia) && assinatura.dias_carencia >= 0
      ? assinatura.dias_carencia
      : 5;
  const carenciaAte = venceEm + diasCarencia * 24 * 60 * 60 * 1000;
  const status =
    agora <= venceEm ? "ativa" : agora <= carenciaAte ? "carencia" : "suspensa";

  return {
    status,
    em_teste: assinatura.em_teste === true,
    vence_em: new Date(venceEm).toISOString(),
    carencia_ate: new Date(carenciaAte).toISOString(),
    dias_restantes:
      status === "ativa"
        ? Math.max(0, Math.ceil((venceEm - agora) / 86400000))
        : 0,
    dias_restantes_carencia:
      status === "carencia"
        ? Math.max(0, Math.ceil((carenciaAte - agora) / 86400000))
        : 0,
  };
}

function calcularNovoVencimento(venceAtual, periodoDias, agora = Date.now()) {
  if (!Object.values(PERIODOS_ASSINATURA).includes(Number(periodoDias))) {
    throw new Error("Período de assinatura inválido.");
  }
  const vencimentoMillis = timestampParaMillis(venceAtual);
  const inicio =
    vencimentoMillis && vencimentoMillis >= agora ? vencimentoMillis : agora;
  return inicio + Number(periodoDias) * 86400000;
}

async function aplicarAssinaturaPagamento({
  db,
  FieldValue,
  Timestamp,
  pagamentoRef,
  agora = Date.now(),
}) {
  return db.runTransaction(async (tx) => {
    const pagamentoDoc = await tx.get(pagamentoRef);
    if (!pagamentoDoc.exists) return false;

    const pagamento = pagamentoDoc.data();
    const establishmentId = String(pagamento.establishment_id || "");
    if (!establishmentId) return false;

    const estabelecimentoRef = db
      .collection("estabelecimentos")
      .doc(establishmentId);
    const estabelecimentoDoc = await tx.get(estabelecimentoRef);
    if (
      !estabelecimentoDoc.exists ||
      pagamento.assinatura_aplicada === true
    ) {
      return false;
    }

    const estabelecimento = estabelecimentoDoc.data();
    const assinaturaAtual = estabelecimento.assinatura || null;
    const periodoDias = Number(pagamento.periodo_dias);
    if (!Object.values(PERIODOS_ASSINATURA).includes(periodoDias)) {
      throw new Error("Período de assinatura inválido.");
    }
    const novoVencimento = Timestamp.fromMillis(
      calcularNovoVencimento(assinaturaAtual?.vence_em, periodoDias, agora),
    );

    tx.update(estabelecimentoRef, {
      assinatura: {
        vence_em: novoVencimento,
        dias_carencia: Number.isInteger(assinaturaAtual?.dias_carencia)
          ? assinaturaAtual.dias_carencia
          : 5,
        em_teste: false,
        atualizado_em: FieldValue.serverTimestamp(),
        ultimo_pagamento_id: pagamentoRef.id,
      },
    });

    tx.update(pagamentoRef, {
      status: "aprovado",
      processado: true,
      assinatura_aplicada: true,
      aprovado_em: FieldValue.serverTimestamp(),
      assinatura_aplicada_em: FieldValue.serverTimestamp(),
      vencimento_anterior: assinaturaAtual?.vence_em || null,
      vencimento_novo: novoVencimento,
    });
    return true;
  });
}

module.exports = {
  PERIODOS_ASSINATURA,
  timestampParaMillis,
  calcularStatusAssinatura,
  calcularNovoVencimento,
  aplicarAssinaturaPagamento,
};
