const cron = require("node-cron");

module.exports = (connection) => {
  // Executa todo dia às 03:00
  cron.schedule("0 3 * * *", async () => {
    try {
      console.log("📦 Arquivando histórico antigo...");

      // 1. Move pedidos antigos para tabela de arquivados
      await connection.query(`
        INSERT INTO historico_pedidos_arquivados (
          pedido_id,
          establishment_id,
          itens,
          total,
          forma_pagamento,
          tipo_entrega,
          mesa,
          nome_cliente,
          endereco,
          finalizado_at
        )
        SELECT
          pedido_id,
          establishment_id,
          itens,
          total,
          forma_pagamento,
          tipo_entrega,
          mesa,
          nome_cliente,
          endereco,
          finalizado_at
        FROM historico_pedidos
        WHERE finalizado_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      // 2. Remove da tabela principal
      const [result] = await connection.query(`
        DELETE FROM historico_pedidos
        WHERE finalizado_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      console.log(`✅ ${result.affectedRows} pedidos arquivados com sucesso.`);
    } catch (error) {
      console.error("Erro ao arquivar histórico:", error);
    }
  });
};
