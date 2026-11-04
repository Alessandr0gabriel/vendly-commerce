const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { calcularValoresAssinatura } = require("../utils/precosAssinatura");

const modulo = pathToFileURL(
  path.join(__dirname, "../../frontend/js/modules/assinaturaResumo.js"),
).href;

const opcoes = calcularValoresAssinatura({ id: "full", nome: "Full", preco: 139.9 });
const ids = (linhas) => linhas.map((l) => l.id);
const total = (linhas) => linhas.find((l) => l.id === "total").valor;

test("Mensal não exibe desconto anual nem valor original anual", async () => {
  const { montarResumoAssinatura } = await import(modulo);
  const linhas = montarResumoAssinatura(opcoes, "mensal");
  assert.deepEqual(ids(linhas), ["plano", "periodicidade", "valor", "total"]);
  assert.ok(!linhas.some((l) => /desconto|original/i.test(l.rotulo)));
  assert.equal(linhas.find((l) => l.id === "valor").valor, opcoes.mensal.valorFormatado);
  assert.equal(total(linhas), opcoes.mensal.valorFormatado);
});

test("Anual exibe valor original + desconto e total anual", async () => {
  const { montarResumoAssinatura } = await import(modulo);
  const linhas = montarResumoAssinatura(opcoes, "anual");
  assert.deepEqual(ids(linhas), [
    "plano",
    "periodicidade",
    "valor-original",
    "desconto",
    "total",
  ]);
  assert.equal(
    linhas.find((l) => l.id === "valor-original").valor,
    opcoes.anual.valorSemDescontoFormatado,
  );
  assert.equal(
    linhas.find((l) => l.id === "desconto").valor,
    `- ${opcoes.anual.descontoFormatado}`,
  );
  assert.match(linhas.find((l) => l.id === "desconto").rotulo, /10%/);
  assert.equal(total(linhas), opcoes.anual.valorFinalFormatado);
});

test("Mensal -> Anual -> Mensal não mantém valores anteriores", async () => {
  const { montarResumoAssinatura } = await import(modulo);
  const a = montarResumoAssinatura(opcoes, "mensal");
  montarResumoAssinatura(opcoes, "anual");
  const b = montarResumoAssinatura(opcoes, "mensal");
  assert.deepEqual(b, a);
  assert.notEqual(total(b), opcoes.anual.valorFinalFormatado);
});
