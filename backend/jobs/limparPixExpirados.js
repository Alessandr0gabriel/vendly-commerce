const cron = require("node-cron");

// Libera reservas de estoque (estoque_reservado) de pedidos Pix que não foram
// pagos dentro do prazo (campo expira_em), evitando estoque preso/negativo.
module.exports = ({ db, FieldValue, Timestamp, logger }) => {
  cron.schedule("* * * * *", async () => {
    try {
      const agora = Date.now();
      const agoraTs = Timestamp.fromMillis(agora);

      // Documentos com expira_em já vencido
      const snapComExpiracao = await db
        .collection("transacoes_pendentes_pix")
        .where("status", "==", "aguardando_pagamento")
        .where("expira_em", "<=", agoraTs)
        .get();

      // Fallback para transações antigas criadas antes do campo expira_em
      // existir: usamos created_at + uma folga de segurança
      const limiteFallback = Timestamp.fromMillis(agora - 15 * 60 * 1000);
      const snapSemExpiracao = await db
        .collection("transacoes_pendentes_pix")
        .where("status", "==", "aguardando_pagamento")
        .where("created_at", "<=", limiteFallback)
        .get();

      const docsPorId = new Map();
      for (const doc of [...snapComExpiracao.docs, ...snapSemExpiracao.docs]) {
        docsPorId.set(doc.id, doc);
      }

      if (docsPorId.size === 0) return;

      for (const doc of docsPorId.values()) {
        try {
          await db.runTransaction(async (tx) => {
            const transacaoAtual = await tx.get(doc.ref);

            if (
              !transacaoAtual.exists ||
              transacaoAtual.data().status !== "aguardando_pagamento"
            ) {
              return;
            }

            const itens = transacaoAtual.data().itens || [];
            const refs = itens.map((item) =>
              db.collection("produtos").doc(String(item.id)),
            );
            const docsProdutos = await Promise.all(
              refs.map((ref) => tx.get(ref)),
            );

            for (let i = 0; i < itens.length; i++) {
              const item = itens[i];
              const docProduto = docsProdutos[i];

              if (
                docProduto.exists &&
                docProduto.data().controla_estoque === true
              ) {
                tx.update(refs[i], {
                  estoque_reservado: FieldValue.increment(-item.quantidade),
                });
              }
            }

            tx.delete(doc.ref);
          });

          logger.info(
            `[PIX] Reserva expirada liberada e transação ${doc.id} removida`,
          );
        } catch (err) {
          logger.error(
            `Erro ao liberar reserva de estoque da transação Pix ${doc.id}`,
            err,
          );
        }
      }
    } catch (error) {
      logger.error("Erro ao verificar transações Pix expiradas", error);
    }
  });
};
