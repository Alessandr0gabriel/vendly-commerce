const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

assert.equal(
  process.env.USE_FIREBASE_EMULATOR,
  "true",
  "Teste exige USE_FIREBASE_EMULATOR=true",
);

const { db, FieldValue } = require("../../config/firebase");

test(
  "transações simultâneas no Emulator não reservam a mesma última unidade",
  { timeout: 15000 },
  async (context) => {
    const productRef = db
      .collection("produtos")
      .doc(`integration-${randomUUID()}`);

    await productRef.set({
      controla_estoque: true,
      estoque: 1,
      estoque_reservado: 0,
    });
    context.after(() => productRef.delete());

    async function reservarUmaUnidade() {
      return db.runTransaction(async (transaction) => {
        const productSnapshot = await transaction.get(productRef);
        const product = productSnapshot.data();
        const disponivel =
          (Number(product.estoque) || 0) -
          (Number(product.estoque_reservado) || 0);

        if (disponivel < 1) {
          throw new Error("Estoque insuficiente");
        }

        transaction.update(productRef, {
          estoque_reservado: FieldValue.increment(1),
        });
      });
    }

    const resultados = await Promise.allSettled([
      reservarUmaUnidade(),
      reservarUmaUnidade(),
    ]);
    const aceitas = resultados.filter(
      (resultado) => resultado.status === "fulfilled",
    );
    const rejeitadas = resultados.filter(
      (resultado) => resultado.status === "rejected",
    );
    const produtoFinal = (await productRef.get()).data();

    assert.equal(aceitas.length, 1);
    assert.equal(rejeitadas.length, 1);
    assert.equal(produtoFinal.estoque, 1);
    assert.equal(produtoFinal.estoque_reservado, 1);
  },
);
