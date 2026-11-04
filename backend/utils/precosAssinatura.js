const { PERIODOS_ASSINATURA } = require("./assinatura");
const Joi = require("joi");

const SCHEMA_CRIACAO_PIX_ASSINATURA = Joi.object({
  periodicidade: Joi.string().valid("mensal", "anual").default("mensal"),
}).unknown(false);

function valorParaCentavos(valor) {
  const texto = String(valor);
  const correspondencia = texto.match(/^(\d+)(?:\.(\d+))?$/);
  if (!correspondencia) return null;

  const parteInteira = Number(correspondencia[1]);
  const decimais = correspondencia[2] || "";
  if (!Number.isSafeInteger(parteInteira)) return null;

  const centavosSemArredondar =
    parteInteira * 100 + Number((decimais + "00").slice(0, 2));
  const arredondar = Number(decimais[2] || "0") >= 5 ? 1 : 0;
  const centavos = centavosSemArredondar + arredondar;
  return Number.isSafeInteger(centavos) ? centavos : null;
}

function formatarCentavos(valorCentavos) {
  const reais = Math.floor(valorCentavos / 100);
  const centavos = String(valorCentavos % 100).padStart(2, "0");
  return `R$ ${reais.toLocaleString("pt-BR")},${centavos}`;
}

// Oferta anual valida: ativa, do mesmo plano e com preco final positivo e menor que o anual cheio.
function obterOfertaAnualValida(oferta, plano, anualBrutoCentavos) {
  if (!oferta || oferta.ativa !== true) return null;
  if (!plano?.id || String(oferta.planoId) !== String(plano.id)) return null;
  const finalCentavos = valorParaCentavos(oferta.precoComDesconto);
  if (
    !Number.isSafeInteger(finalCentavos) ||
    finalCentavos <= 0 ||
    finalCentavos >= anualBrutoCentavos
  ) {
    return null;
  }
  const descontoCentavos = anualBrutoCentavos - finalCentavos;
  const percentualInformado = Number(oferta.percentualDesconto);
  const descontoPercentual =
    Number.isFinite(percentualInformado) &&
    percentualInformado > 0 &&
    percentualInformado < 100
      ? percentualInformado
      : Math.round((descontoCentavos * 100) / anualBrutoCentavos);
  return { finalCentavos, descontoCentavos, descontoPercentual };
}

function calcularValoresAssinatura(plano, periodicidade = null, oferta = null) {
  if (
    periodicidade !== null &&
    !Object.prototype.hasOwnProperty.call(PERIODOS_ASSINATURA, periodicidade)
  ) {
    throw new Error("Periodicidade de assinatura inválida.");
  }

  const mensalCentavos = valorParaCentavos(plano?.preco);
  if (!Number.isSafeInteger(mensalCentavos) || mensalCentavos <= 0) {
    return null;
  }

  const anualBrutoCentavos = mensalCentavos * 12;
  if (!Number.isSafeInteger(anualBrutoCentavos)) return null;
  const ofertaAnual = obterOfertaAnualValida(oferta, plano, anualBrutoCentavos);
  const descontoCentavos = ofertaAnual
    ? ofertaAnual.descontoCentavos
    : Math.floor(anualBrutoCentavos / 10) +
      (anualBrutoCentavos % 10 >= 5 ? 1 : 0);
  const descontoPercentual = ofertaAnual ? ofertaAnual.descontoPercentual : 10;
  const anualFinalCentavos = anualBrutoCentavos - descontoCentavos;
  const equivalenteMensalCentavos =
    Math.floor(anualFinalCentavos / 12) +
    (anualFinalCentavos % 12 >= 6 ? 1 : 0);
  const nomePlano = String(plano.nome || plano.id || "Plano Vendly").replace(
    /^Plano\s+/i,
    "",
  );

  const valores = {
    plano: nomePlano,
    mensal: {
      valorCentavos: mensalCentavos,
      valorFormatado: formatarCentavos(mensalCentavos),
      dias: PERIODOS_ASSINATURA.mensal,
    },
    anual: {
      valorSemDescontoCentavos: anualBrutoCentavos,
      valorSemDescontoFormatado: formatarCentavos(anualBrutoCentavos),
      descontoPercentual,
      ofertaEspecial: Boolean(ofertaAnual),
      descontoCentavos,
      descontoFormatado: formatarCentavos(descontoCentavos),
      economiaCentavos: descontoCentavos,
      economiaFormatada: formatarCentavos(descontoCentavos),
      valorFinalCentavos: anualFinalCentavos,
      valorFinalFormatado: formatarCentavos(anualFinalCentavos),
      equivalenteMensalCentavos,
      equivalenteMensalFormatado: formatarCentavos(equivalenteMensalCentavos),
      dias: PERIODOS_ASSINATURA.anual,
    },
  };

  if (periodicidade) {
    const selecionado = valores[periodicidade];
    valores.periodicidade = periodicidade;
    valores.valorCentavos =
      periodicidade === "mensal"
        ? selecionado.valorCentavos
        : selecionado.valorFinalCentavos;
    valores.valorFormatado =
      periodicidade === "mensal"
        ? selecionado.valorFormatado
        : selecionado.valorFinalFormatado;
    valores.periodoDias = selecionado.dias;
  }

  return valores;
}

module.exports = {
  PERIODOS_ASSINATURA,
  SCHEMA_CRIACAO_PIX_ASSINATURA,
  valorParaCentavos,
  formatarCentavos,
  calcularValoresAssinatura,
};
