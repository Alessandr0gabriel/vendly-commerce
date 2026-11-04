const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

assert.equal(
  process.env.USE_FIREBASE_EMULATOR,
  "true",
  "Teste exige USE_FIREBASE_EMULATOR=true",
);

const { db: dbReal, FieldValue } = require("../../config/firebase");
const {
  executarMigracao,
} = require("../../scripts/migrate-establishment-name-index");
const {
  chaveNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
  COLECAO_RESERVAS,
} = require("../../utils/nomeEstabelecimento");

// Isola cada teste em coleções próprias para não interferir nos demais
// arquivos de integração, que usam as coleções reais do Emulator.
function criarAmbiente(context) {
  const prefixo = `mig_${randomUUID().slice(0, 8)}_`;
  const db = new Proxy(dbReal, {
    get(target, prop) {
      if (prop === "collection") {
        return (nome) => target.collection(prefixo + nome);
      }
      const valor = target[prop];
      return typeof valor === "function" ? valor.bind(target) : valor;
    },
  });
  context.after(async () => {
    for (const nome of ["estabelecimentos", COLECAO_RESERVAS]) {
      const snap = await dbReal.collection(prefixo + nome).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
  });
  return db;
}

async function criarLoja(db, nome, id = `loja-${randomUUID()}`) {
  const dados = { nome, slug: `menu-${id}`, plano: "medio", status: "active" };
  await db.collection("estabelecimentos").doc(id).set(dados);
  return { id, dados };
}

const migrar = (db, opcoes = {}) =>
  executarMigracao({ db, FieldValue, ...opcoes });

async function reservas(db) {
  const snap = await db.collection(COLECAO_RESERVAS).get();
  return snap.docs.filter((d) => d.id !== "_meta");
}

test("dry-run relata o que seria criado sem gravar nada", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Padaria Rita");
  await criarLoja(db, "Loja Café");

  const somenteLeitura = new Proxy(db, {
    get(target, prop) {
      if (prop === "runTransaction") {
        return () => {
          throw new Error("dry-run não pode iniciar transações");
        };
      }
      const valor = target[prop];
      return typeof valor === "function" ? valor.bind(target) : valor;
    },
  });
  const rel = await migrar(somenteLeitura, { apply: false });
  assert.equal(rel.aCriar.length, 2);
  assert.equal(rel.aplicado, false);
  assert.equal((await reservas(db)).length, 0);
  assert.equal((await referenciaStatusIndiceNomes(db).get()).exists, false);
});

test("migração cria reservas para três estabelecimentos e preserva reserva existente", async (context) => {
  const db = criarAmbiente(context);
  const lojas = [
    await criarLoja(db, "Loja Um"),
    await criarLoja(db, "Loja Dois"),
    await criarLoja(db, "Loja Três"),
  ];
  const chaveExistente = chaveNomeEstabelecimento(lojas[0].dados.nome);
  const reservaExistente = referenciaReservaNome(db, chaveExistente);
  const dadosExistentes = {
    establishment_id: lojas[0].id,
    nome_normalizado: chaveExistente,
    criado_em: "preservar-valor",
    campo_legado: "não sobrescrever",
  };
  await reservaExistente.set(dadosExistentes);

  const rel = await migrar(db, { apply: true });
  assert.equal(rel.reservasCriadas, 2);
  assert.equal((await reservas(db)).length, 3);
  assert.deepEqual((await reservaExistente.get()).data(), dadosExistentes);
  for (const loja of lojas) {
    assert.equal(
      (
        await referenciaReservaNome(
          db,
          chaveNomeEstabelecimento(loja.dados.nome),
        ).get()
      ).data().establishment_id,
      loja.id,
    );
  }
});

test("erro de permissão durante o diagnóstico não grava metadados nem reservas", async (context) => {
  const baseDb = criarAmbiente(context);
  await criarLoja(baseDb, "Loja Sem Permissão");
  const db = new Proxy(baseDb, {
    get(target, prop) {
      if (prop === "collection") {
        return (nome) => {
          const ref = target.collection(nome);
          if (nome !== "estabelecimentos") return ref;
          return new Proxy(ref, {
            get(collection, method) {
              if (method === "get") {
                return async () => {
                  throw Object.assign(new Error("detalhe interno"), { code: 7 });
                };
              }
              const valor = collection[method];
              return typeof valor === "function"
                ? valor.bind(collection)
                : valor;
            },
          });
        };
      }
      const valor = target[prop];
      return typeof valor === "function" ? valor.bind(target) : valor;
    },
  });

  await assert.rejects(migrar(db, { apply: false }), { code: 7 });
  assert.equal((await referenciaStatusIndiceNomes(baseDb).get()).exists, false);
  assert.equal((await reservas(baseDb)).length, 0);
});

test("nomes duplicados (caixa, acento, espaços) bloqueiam antes de tocar em _meta", async (context) => {
  const db = criarAmbiente(context);
  const a = await criarLoja(db, "Loja Café");
  const b = await criarLoja(db, "  loja   CAFE ");
  await criarLoja(db, "Outra Loja");

  await assert.rejects(
    migrar(db, { apply: true }),
    (err) => {
      assert.match(err.message, /colisões/);
      assert.equal(err.relatorio.colisoes.length, 1);
      assert.deepEqual(err.relatorio.colisoes[0].ids.sort(), [a.id, b.id].sort());
      return true;
    },
  );
  assert.equal((await referenciaStatusIndiceNomes(db).get()).exists, false);
  assert.equal((await reservas(db)).length, 0);
});

test("reserva pertencente a outro estabelecimento bloqueia e é preservada", async (context) => {
  const db = criarAmbiente(context);
  const loja = await criarLoja(db, "Padaria Rita");
  const chave = chaveNomeEstabelecimento("Padaria Rita");
  await referenciaReservaNome(db, chave).set({
    establishment_id: "outro-dono",
    nome_normalizado: chave,
  });
  await referenciaStatusIndiceNomes(db).set({ ready: true, schema_version: 1 });

  await assert.rejects(migrar(db, { apply: true }), (err) => {
    assert.equal(err.relatorio.reservasDeOutroDono.length, 1);
    return true;
  });
  const reserva = (await referenciaReservaNome(db, chave).get()).data();
  assert.equal(reserva.establishment_id, "outro-dono");
  // Índice que já estava pronto permanece pronto: nada foi fechado.
  assert.equal((await referenciaStatusIndiceNomes(db).get()).data().ready, true);
  assert.equal(
    (await db.collection("estabelecimentos").doc(loja.id).get()).data().nome,
    "Padaria Rita",
  );
});

test("reserva criada com normalização anterior (chave com acento) é detectada", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja Café");
  const chaveAntiga = "loja café";
  await referenciaReservaNome(db, chaveAntiga).set({
    establishment_id: "x",
    nome_normalizado: chaveAntiga,
  });

  await assert.rejects(migrar(db, { apply: true }), (err) => {
    assert.equal(err.relatorio.reservasChaveIncompativel.length, 1);
    return true;
  });
  assert.equal((await referenciaStatusIndiceNomes(db).get()).exists, false);
});

test("schema_version desconhecido bloqueia a migração", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja A");
  await referenciaStatusIndiceNomes(db).set({ ready: true, schema_version: 2 });

  await assert.rejects(migrar(db, { apply: true }), /schema_version/);
  assert.equal(
    (await referenciaStatusIndiceNomes(db).get()).data().schema_version,
    2,
  );
});

test("apply cria reservas, marca ready só ao final e preserva ID, nome e slug", async (context) => {
  const db = criarAmbiente(context);
  const lojas = [
    await criarLoja(db, "Padaria Rita"),
    await criarLoja(db, "Loja Café"),
  ];
  await criarLoja(db, "   ");

  let readyDuranteMigracao = null;
  const rel = await migrar(db, {
    apply: true,
    hooks: {
      async aposReserva() {
        readyDuranteMigracao = (
          await referenciaStatusIndiceNomes(db).get()
        ).data().ready;
      },
    },
  });

  assert.equal(readyDuranteMigracao, false);
  assert.equal(rel.aplicado, true);
  assert.equal((await referenciaStatusIndiceNomes(db).get()).data().ready, true);
  assert.equal((await reservas(db)).length, 2);
  for (const loja of lojas) {
    const atual = (
      await db.collection("estabelecimentos").doc(loja.id).get()
    ).data();
    assert.deepEqual(atual, loja.dados);
    const chave = chaveNomeEstabelecimento(loja.dados.nome);
    assert.equal(
      (await referenciaReservaNome(db, chave).get()).data().establishment_id,
      loja.id,
    );
  }

  const repetida = await migrar(db, { apply: true });
  assert.equal(repetida.aplicado, true);
  assert.equal((await reservas(db)).length, 2);
});

test("reserva órfã bloqueia a ativação e não é apagada", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja Viva");
  const chaveOrfa = chaveNomeEstabelecimento("Loja Fantasma");
  await referenciaReservaNome(db, chaveOrfa).set({
    establishment_id: "nao-existe",
    nome_normalizado: chaveOrfa,
  });

  await assert.rejects(migrar(db, { apply: true }), (err) => {
    assert.deepEqual(err.relatorio.reservasOrfas, [
      referenciaReservaNome(db, chaveOrfa).id,
    ]);
    assert.match(err.message, /órfãs/);
    return true;
  });
  assert.equal((await referenciaReservaNome(db, chaveOrfa).get()).exists, true);
  assert.equal((await referenciaStatusIndiceNomes(db).get()).exists, false);
  assert.equal((await reservas(db)).length, 1);
});

test("reserva divergente bloqueia a ativação e não é corrigida", async (context) => {
  const db = criarAmbiente(context);
  const loja = await criarLoja(db, "Nome Atual");
  const chaveAntiga = chaveNomeEstabelecimento("Nome Antigo");
  const refAntiga = referenciaReservaNome(db, chaveAntiga);
  await refAntiga.set({
    establishment_id: loja.id,
    nome_normalizado: chaveAntiga,
  });

  await assert.rejects(migrar(db, { apply: true }), (err) => {
    assert.equal(err.relatorio.reservasDivergentes.length, 1);
    assert.equal(err.relatorio.reservasDivergentes[0].reserva, refAntiga.id);
    assert.match(err.message, /divergentes/);
    return true;
  });
  const dados = (await refAntiga.get()).data();
  assert.equal(dados.establishment_id, loja.id);
  assert.equal(dados.nome_normalizado, chaveAntiga);
  assert.equal((await reservas(db)).length, 1);
  assert.equal((await referenciaStatusIndiceNomes(db).get()).exists, false);
});

test("dry-run também reporta órfãs e divergentes como bloqueios", async (context) => {
  const db = criarAmbiente(context);
  const chave = chaveNomeEstabelecimento("Sem Dono");
  await referenciaReservaNome(db, chave).set({
    establishment_id: "x",
    nome_normalizado: chave,
  });
  await assert.rejects(migrar(db, { apply: false }), (err) => {
    assert.equal(err.relatorio.reservasOrfas.length, 1);
    return true;
  });
});

test("duas migrações simultâneas não corrompem o índice", async (context) => {
  const db = criarAmbiente(context);
  for (let i = 1; i <= 6; i++) await criarLoja(db, `Loja Concorrente ${i}`);

  const resultados = await Promise.allSettled([
    migrar(db, { apply: true }),
    migrar(db, { apply: true }),
  ]);
  assert.ok(resultados.some((r) => r.status === "fulfilled"));
  for (const r of resultados) {
    if (r.status === "rejected") {
      assert.ok(
        ["MIGRACAO_EM_ANDAMENTO", "LEASE_PERDIDO"].includes(r.reason.codigo) ||
          /Conflito|Verificação final/.test(r.reason.message),
        r.reason.message,
      );
    }
  }
  // Se alguma perdeu a disputa, uma nova execução converge.
  await migrar(db, { apply: true });
  const status = (await referenciaStatusIndiceNomes(db).get()).data();
  assert.equal(status.ready, true);
  assert.equal(status.migracao_dono, undefined);
  assert.equal((await reservas(db)).length, 6);
});

test("lease ativo bloqueia outra execução; lease expirado permite retomar", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja Um");
  await criarLoja(db, "Loja Dois");

  // Simula processo que morreu: lease gravado e nunca liberado.
  await referenciaStatusIndiceNomes(db).set({
    ready: false,
    migrando: true,
    schema_version: 1,
    migracao_dono: "processo-morto",
    migracao_expira_em: Date.now() + 60_000,
  });
  await assert.rejects(
    migrar(db, { apply: true }),
    (err) => err.codigo === "MIGRACAO_EM_ANDAMENTO",
  );
  assert.equal((await reservas(db)).length, 0);
  assert.equal(
    (await referenciaStatusIndiceNomes(db).get()).data().migracao_dono,
    "processo-morto",
  );

  await referenciaStatusIndiceNomes(db).update({
    migracao_expira_em: Date.now() - 1,
  });
  const rel = await migrar(db, { apply: true });
  assert.equal(rel.aplicado, true);
  const status = (await referenciaStatusIndiceNomes(db).get()).data();
  assert.equal(status.ready, true);
  assert.equal(status.migracao_dono, undefined);
  assert.equal((await reservas(db)).length, 2);
});

test("execução que perde o lease aborta sem liberar ready", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja Um");
  await criarLoja(db, "Loja Dois");

  await assert.rejects(
    migrar(db, {
      apply: true,
      hooks: {
        async aposReserva() {
          await referenciaStatusIndiceNomes(db).update({
            migracao_dono: "outro",
          });
        },
      },
    }),
    (err) => err.codigo === "LEASE_PERDIDO",
  );
  const status = (await referenciaStatusIndiceNomes(db).get()).data();
  assert.equal(status.ready, false);
  assert.equal(status.migracao_dono, "outro");
});

test("falha simulada no meio mantém ready=false e a reexecução retoma", async (context) => {
  const db = criarAmbiente(context);
  await criarLoja(db, "Loja Um");
  await criarLoja(db, "Loja Dois");
  await criarLoja(db, "Loja Três");

  let chamadas = 0;
  await assert.rejects(
    migrar(db, {
      apply: true,
      hooks: {
        async aposReserva() {
          if (++chamadas === 1) throw new Error("falha simulada");
        },
      },
    }),
    /falha simulada/,
  );
  const status = (await referenciaStatusIndiceNomes(db).get()).data();
  assert.equal(status.ready, false);
  assert.equal((await reservas(db)).length, 1);

  const rel = await migrar(db, { apply: true });
  assert.equal(rel.aplicado, true);
  assert.equal((await reservas(db)).length, 3);
  assert.equal((await referenciaStatusIndiceNomes(db).get()).data().ready, true);
});
