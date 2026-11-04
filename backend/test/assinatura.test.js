const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PERIODOS_ASSINATURA,
  calcularStatusAssinatura,
  calcularNovoVencimento,
  aplicarAssinaturaPagamento,
} = require("../utils/assinatura");

const agora = Date.parse("2026-09-30T12:00:00.000Z");

function assinaturaComVencimento(venceEm) {
  return { vence_em: new Date(venceEm).toISOString(), dias_carencia: 5 };
}

test("assinatura ativa permite acesso", () => {
  const status = calcularStatusAssinatura(
    assinaturaComVencimento("2026-10-20T12:00:00.000Z"),
    agora,
  );
  assert.equal(status.status, "ativa");
  assert.equal(status.em_teste, false);
  assert.equal(status.dias_restantes, 20);
});

test("assinatura ativa pode ser identificada como trial", () => {
  const status = calcularStatusAssinatura(
    { ...assinaturaComVencimento("2026-10-20T12:00:00.000Z"), em_teste: true },
    agora,
  );
  assert.equal(status.status, "ativa");
  assert.equal(status.em_teste, true);
});

test("assinatura vencida dentro da carencia permanece em carencia", () => {
  const status = calcularStatusAssinatura(
    assinaturaComVencimento("2026-09-29T12:00:00.000Z"),
    agora,
  );
  assert.equal(status.status, "carencia");
  assert.equal(status.dias_restantes_carencia, 4);
});

test("assinatura fora da carencia fica suspensa", () => {
  const status = calcularStatusAssinatura(
    assinaturaComVencimento("2026-09-20T12:00:00.000Z"),
    agora,
  );
  assert.equal(status.status, "suspensa");
});

test("estabelecimento legado sem assinatura nao e bloqueado por status", () => {
  assert.deepEqual(calcularStatusAssinatura(undefined, agora), {
    status: "nao_configurada",
    em_teste: false,
  });
});

test("periodos comerciais aceitos sao mensal e anual", () => {
  assert.deepEqual(PERIODOS_ASSINATURA, { mensal: 30, anual: 365 });
});

test("renovacao ativa preserva o vencimento atual e soma o periodo", () => {
  const agora = Date.parse("2026-09-30T12:00:00.000Z");
  const vencimento = calcularNovoVencimento(
    "2026-10-10T12:00:00.000Z",
    30,
    agora,
  );
  assert.equal(vencimento, Date.parse("2026-11-09T12:00:00.000Z"));
});

test("renovacao vencida com periodo anual comeca agora", () => {
  const agora = Date.parse("2026-09-30T12:00:00.000Z");
  const vencimento = calcularNovoVencimento(
    "2026-09-01T12:00:00.000Z",
    365,
    agora,
  );
  assert.equal(vencimento, Date.parse("2027-09-30T12:00:00.000Z"));
});

test("webhook reaplicado não estende a assinatura novamente", async () => {
  const pagamentoRef = { id: "pagamento-1" };
  const estabelecimentoRef = { id: "estabelecimento-1" };
  const documentos = new Map([
    [
      pagamentoRef,
      {
        establishment_id: estabelecimentoRef.id,
        periodo_dias: 30,
        assinatura_aplicada: false,
      },
    ],
    [
      estabelecimentoRef,
      {
        assinatura: {
          vence_em: "2026-10-10T12:00:00.000Z",
          dias_carencia: 5,
        },
      },
    ],
  ]);
  let atualizacoes = 0;
  const db = {
    collection: () => ({ doc: () => estabelecimentoRef }),
    runTransaction: (executar) =>
      executar({
        get: async (ref) => ({
          exists: documentos.has(ref),
          data: () => documentos.get(ref),
        }),
        update: (ref, dados) => {
          documentos.set(ref, { ...documentos.get(ref), ...dados });
          atualizacoes += 1;
        },
      }),
  };
  const Timestamp = {
    fromMillis: (millis) => new Date(millis).toISOString(),
  };
  const FieldValue = { serverTimestamp: () => "server-timestamp" };
  const options = {
    db,
    FieldValue,
    Timestamp,
    pagamentoRef,
    agora,
  };

  assert.equal(await aplicarAssinaturaPagamento(options), true);
  const vencimentoAposPrimeiroProcessamento =
    documentos.get(estabelecimentoRef).assinatura.vence_em;
  assert.equal(await aplicarAssinaturaPagamento(options), false);
  assert.equal(atualizacoes, 2);
  assert.equal(
    documentos.get(estabelecimentoRef).assinatura.vence_em,
    vencimentoAposPrimeiroProcessamento,
  );
});
