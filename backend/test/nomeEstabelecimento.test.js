const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chaveNomeEstabelecimento,
  classificarErroCadastro,
  erroNomeDuplicado,
  exigirIndiceNomesPronto,
  normalizarNomeEstabelecimento,
} = require("../utils/nomeEstabelecimento");

const snap = (dados) => ({ exists: dados !== null, data: () => dados });

test("índice ausente, pendente e pronto são tratados distintamente, sem 503", () => {
  for (const [dados, motivo] of [
    [null, "ausente"],
    [{ ready: false }, "pendente"],
    [{ migrando: true }, "pendente"],
  ]) {
    assert.throws(() => exigirIndiceNomesPronto(snap(dados)), (err) => {
      assert.equal(err.code, "INDICE_NOMES_PENDENTE");
      assert.equal(err.motivoIndice, motivo);
      assert.equal(classificarErroCadastro(err).status, 409);
      return true;
    });
  }
  assert.doesNotThrow(() => exigirIndiceNomesPronto(snap({ ready: true })));
});

test("classificação de erros: duplicado, transitório e inesperado", () => {
  assert.equal(classificarErroCadastro(erroNomeDuplicado()).status, 409);
  const transitorio = classificarErroCadastro(
    Object.assign(new Error("detalhe interno"), { code: 14 }),
  );
  assert.equal(transitorio.status, 503);
  assert.doesNotMatch(JSON.stringify(transitorio.corpo), /interno/);
  const inesperado = classificarErroCadastro(new Error("segredo"));
  assert.equal(inesperado.status, 500);
  assert.doesNotMatch(JSON.stringify(inesperado.corpo), /segredo/);
});

test("unicidade ignora caixa, espaços extras e acentos", () => {
  assert.equal(
    chaveNomeEstabelecimento("  Padaria   RITA "),
    chaveNomeEstabelecimento("padaria rita"),
  );
  assert.equal(
    chaveNomeEstabelecimento("Café São João"),
    chaveNomeEstabelecimento("Cafe Sao Joao"),
  );
});

test("nomes Unicode canonicamente equivalentes geram a mesma chave", () => {
  assert.equal(
    chaveNomeEstabelecimento("Café"),
    chaveNomeEstabelecimento("Cafe\u0301"),
  );
});

test("nome de exibição é aparado, compactado e limitado", () => {
  assert.equal(normalizarNomeEstabelecimento("  Loja   Central  "), "Loja Central");
  assert.equal(normalizarNomeEstabelecimento(" \t "), null);
  assert.equal(normalizarNomeEstabelecimento("x".repeat(101)), null);
  assert.equal(normalizarNomeEstabelecimento(42), null);
  assert.equal(normalizarNomeEstabelecimento("loja\u0000central"), null);
  assert.equal(normalizarNomeEstabelecimento("<script>alert(1)</script>"), null);
});
