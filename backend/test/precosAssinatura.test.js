const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calcularValoresAssinatura,
  valorParaCentavos,
  SCHEMA_CRIACAO_PIX_ASSINATURA,
} = require("../utils/precosAssinatura");

test("valor mensal é expresso em centavos sem erro de ponto flutuante", () => {
  const valores = calcularValoresAssinatura({
    id: "premium",
    nome: "Plano Premium",
    preco: 99.99,
  });

  assert.equal(valorParaCentavos(99.99), 9999);
  assert.equal(valores.mensal.valorCentavos, 9999);
  assert.equal(valores.mensal.valorFormatado, "R$ 99,99");
});

test("anual corresponde a doze mensalidades e aplica exatamente 10% OFF", () => {
  const valores = calcularValoresAssinatura({
    id: "premium",
    nome: "Plano Premium",
    preco: 99.99,
  });

  assert.equal(valores.anual.valorSemDescontoCentavos, 119988);
  assert.equal(valores.anual.descontoCentavos, 11999);
  assert.equal(valores.anual.valorFinalCentavos, 107989);
  assert.equal(valores.anual.valorFinalFormatado, "R$ 1.079,89");
  assert.equal(valores.anual.economiaCentavos, 11999);
});

test("valores calculados para cobrança usam o período e total oficial", () => {
  const mensal = calcularValoresAssinatura(
    { id: "basico", nome: "Plano Básico", preco: 49.9 },
    "mensal",
  );
  const anual = calcularValoresAssinatura(
    { id: "basico", nome: "Plano Básico", preco: 49.9 },
    "anual",
  );

  assert.equal(mensal.periodicidade, "mensal");
  assert.equal(mensal.valorCentavos, mensal.mensal.valorCentavos);
  assert.equal(mensal.periodoDias, 30);
  assert.equal(anual.periodicidade, "anual");
  assert.equal(anual.valorCentavos, anual.anual.valorFinalCentavos);
  assert.equal(anual.periodoDias, 365);
});

test("equivalente mensal também é arredondado em centavos", () => {
  const valores = calcularValoresAssinatura({
    id: "premium",
    nome: "Plano Premium",
    preco: 99.99,
  });

  assert.equal(valores.anual.equivalenteMensalCentavos, 8999);
  assert.equal(valores.anual.equivalenteMensalFormatado, "R$ 89,99");
});

test("preço inválido ou fora de faixa segura não gera valores", () => {
  assert.equal(
    calcularValoresAssinatura({ id: "premium", preco: "inválido" }),
    null,
  );
  assert.equal(
    calcularValoresAssinatura({
      id: "premium",
      preco: Number.MAX_SAFE_INTEGER,
    }),
    null,
  );
});

test("periodicidade inválida é rejeitada", () => {
  assert.throws(
    () =>
      calcularValoresAssinatura(
        { id: "premium", nome: "Premium", preco: 99.99 },
        "semestral",
      ),
    /Periodicidade de assinatura inválida/,
  );
});

test("criação do Pix aceita apenas a periodicidade e não recebe preço do cliente", () => {
  const mensal = SCHEMA_CRIACAO_PIX_ASSINATURA.validate({
    periodicidade: "mensal",
  });
  const comPrecoDoCliente = SCHEMA_CRIACAO_PIX_ASSINATURA.validate({
    periodicidade: "mensal",
    valor: 1,
    desconto: 99,
  });

  assert.equal(mensal.error, undefined);
  assert.equal(mensal.value.periodicidade, "mensal");
  assert.ok(comPrecoDoCliente.error);
});

test("solicitação sem periodicidade mantém o padrão mensal compatível", () => {
  const validacao = SCHEMA_CRIACAO_PIX_ASSINATURA.validate({});
  assert.equal(validacao.error, undefined);
  assert.equal(validacao.value.periodicidade, "mensal");
});

// ---- Oferta anual especifica ----
const planoFull = { id: "full", nome: "Plano Full", preco: 129.99 };
const ofertaFull = {
  ativa: true,
  planoId: "full",
  precoOriginal: 1559.88,
  precoComDesconto: 1169.91,
  percentualDesconto: 25,
  economia: 389.97,
};

test("sem oferta anual usa mensal x 12 com 10% OFF", () => {
  const v = calcularValoresAssinatura(planoFull, "anual", null);
  assert.equal(v.anual.valorSemDescontoCentavos, 155988);
  assert.equal(v.anual.descontoPercentual, 10);
  assert.equal(v.anual.ofertaEspecial, false);
  assert.equal(v.valorCentavos, 155988 - 15599);
});

test("oferta anual ativa tem prioridade e nao soma com os 10%", () => {
  const v = calcularValoresAssinatura(planoFull, "anual", ofertaFull);
  assert.equal(v.mensal.valorCentavos, 12999);
  assert.equal(v.anual.valorSemDescontoCentavos, 155988);
  assert.equal(v.anual.valorFinalCentavos, 116991);
  assert.equal(v.valorCentavos, 116991);
  assert.equal(v.anual.descontoPercentual, 25);
  assert.equal(v.anual.ofertaEspecial, true);
  assert.equal(v.anual.economiaCentavos, 38997);
  assert.equal(v.anual.economiaFormatada, "R$ 389,97");
  assert.equal(
    v.anual.economiaCentavos,
    v.anual.valorSemDescontoCentavos - v.anual.valorFinalCentavos,
  );
  assert.notEqual(v.valorCentavos, 155988 - 15599);
});

test("oferta nao altera a cobranca mensal", () => {
  const v = calcularValoresAssinatura(planoFull, "mensal", ofertaFull);
  assert.equal(v.valorCentavos, 12999);
});

test("oferta inativa, de outro plano ou invalida cai no fallback de 10%", () => {
  const invalidas = [
    { ...ofertaFull, ativa: false },
    { ...ofertaFull, planoId: "premium" },
    { ...ofertaFull, precoComDesconto: 0 },
    { ...ofertaFull, precoComDesconto: "abc" },
    { ...ofertaFull, precoComDesconto: 2000 },
    { ...ofertaFull, ativa: "true" },
  ];
  for (const oferta of invalidas) {
    const v = calcularValoresAssinatura(planoFull, "anual", oferta);
    assert.equal(v.anual.descontoPercentual, 10);
    assert.equal(v.valorCentavos, 155988 - 15599);
  }
});

test("rotas de opcoes e criar-pix usam a mesma funcao central e ignoram valores do cliente", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const fonte = fs.readFileSync(path.join(__dirname, "../api.js"), "utf8");
  assert.equal(fonte.match(/await obterValoresAssinatura\(/g).length, 2);
  assert.equal(fonte.match(/calcularValoresAssinatura\(/g).length, 1);
  assert.ok(
    SCHEMA_CRIACAO_PIX_ASSINATURA.validate({ periodicidade: "anual", valor: 1 }).error,
  );
  assert.ok(
    SCHEMA_CRIACAO_PIX_ASSINATURA.validate({ periodicidade: "anual", oferta: {} }).error,
  );
  assert.match(fonte, /transaction_amount: plano\.valor/);
  assert.match(fonte, /valor: valores\.valorCentavos \/ 100/);
});
