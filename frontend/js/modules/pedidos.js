import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showError, showSuccess } from "../ui/alerts.js";
import { escapeHTML } from "../core/utils.js";
import { carregarFaturamento } from "./faturamento.js";

// Monta o HTML do bloco de troco: quanto o cliente vai pagar e quanto o
// estabelecimento precisa levar de troco (troco_para - total do pedido)
function montarInfoTroco(pedido) {
  if (pedido.forma_pagamento !== "dinheiro") return "";

  if (!pedido.precisa_troco) {
    return `<small class="troco-info troco-sem">Sem troco</small>`;
  }

  const trocoPara = Number(pedido.troco_para) || 0;
  const total = Number(pedido.total) || 0;
  const valorTroco = Math.max(trocoPara - total, 0);

  return `<small class="troco-info troco-com">Troco para R$ ${trocoPara.toFixed(2)} &rarr; levar R$ ${valorTroco.toFixed(2)} de troco</small>`;
}

export async function carregarPedidos() {
  const lista = document.getElementById("listarPedidos");
  if (!lista) return;

  lista.innerHTML = '<p class="empty-state">Carregando pedidos...</p>';

  try {
    const pedidos = await fetchComAuth(`${API_URL}/admin/pedidos`);
    lista.innerHTML = "";

    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      lista.innerHTML = '<p class="empty-state">Nenhum pedido pendente.</p>';
      return;
    }

    pedidos.forEach((pedido) => {
      const itens =
        typeof pedido.itens === "string"
          ? JSON.parse(pedido.itens)
          : pedido.itens;
      const itensHtml = itens
        .map((item) => `${Number(item.quantidade)}x ${escapeHTML(item.nome)}`)
        .join(", ");

      // O Firestore retorna objetos Timestamp. Tratamos de forma segura.
      const data =
        pedido.created_at && typeof pedido.created_at.toDate === "function"
          ? pedido.created_at.toDate().toLocaleString("pt-BR")
          : new Date(pedido.created_at).toLocaleString("pt-BR");

      const isPixPago =
        pedido.status === "pago" ||
        pedido.status === "aprovado" ||
        (pedido.mercado_pago && pedido.mercado_pago.status === "approved");

      const statusPix = isPixPago
        ? '<span class="badge-pago" style="background:#28a745; color:#fff; padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px; display:inline-block; margin-left:6px;">PAGO VIA PIX</span>'
        : '<span class="badge-pendente" style="background:#ffc107; color:#000; padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px; display:inline-block; margin-left:6px;">AGUARDANDO / COBRAR</span>';
      const statusSelecionado = ["preparando", "a_caminho"].includes(
        pedido.status,
      )
        ? pedido.status
        : "aguardando";
      const statusLabel = {
        aguardando: "Aguardando estabelecimento",
        preparando: "Preparando",
        a_caminho: "A caminho",
      }[statusSelecionado];

      lista.innerHTML += `
        <div class="produto-card">
          <div class="produto-meta">
            <strong>Pedido #${pedido.id}</strong> ${statusPix}
            <span class="pedido-status-label status-${statusSelecionado}">${statusLabel}</span>
            <br>
            <span>R$ ${Number(pedido.total).toFixed(2)}</span>
            <small>${pedido.tipo_entrega}${pedido.mesa ? ` - Mesa ${pedido.mesa}` : ""}</small>
            <small>${pedido.forma_pagamento} - ${data}</small>
            ${montarInfoTroco(pedido)}
            <small>Cliente: ${escapeHTML(pedido.nome_cliente) || "---"}</small>
            ${pedido.endereco ? `<small>Endereço: ${escapeHTML(pedido.endereco)}</small>` : ""}
            <small>Itens: ${itensHtml}</small>
          </div>
          <div class="acoes">
            <button class="status-action status-preparando ${statusSelecionado === "preparando" ? "selected" : ""}" onclick="atualizarStatusPedido('${pedido.id}', 'preparando')">Preparando</button>
            <button class="status-action status-a-caminho ${statusSelecionado === "a_caminho" ? "selected" : ""}" onclick="atualizarStatusPedido('${pedido.id}', 'a_caminho')">A caminho</button>
            <button onclick="excluirPedido('${pedido.id}')">Excluir</button>
            <button onclick="finalizarPedido('${pedido.id}')">Finalizar</button>
          </div>
        </div>
      `;
    });
  } catch (err) {
    console.error("Erro ao carregar pedidos:", err);
    lista.innerHTML =
      '<p class="empty-state">Falha ao carregar pedidos. Atualize a página ou tente novamente.</p>';
  }
}

export async function carregarHistorico() {
  const lista = document.getElementById("listarPedidos");
  if (!lista) return;

  lista.innerHTML = '<p class="empty-state">Carregando histórico...</p>';

  try {
    const pedidos = await fetchComAuth(`${API_URL}/admin/historico`);
    lista.innerHTML = "";

    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      lista.innerHTML =
        '<p class="empty-state">Nenhum pedido no histórico.</p>';
      return;
    }

    pedidos.forEach((pedido) => {
      const itens =
        typeof pedido.itens === "string"
          ? JSON.parse(pedido.itens)
          : pedido.itens;
      const itensHtml = itens
        .map((item) => `${Number(item.quantidade)}x ${escapeHTML(item.nome)}`)
        .join(", ");

      const data =
        pedido.finalizado_at &&
        typeof pedido.finalizado_at.toDate === "function"
          ? pedido.finalizado_at.toDate().toLocaleString("pt-BR")
          : new Date(pedido.finalizado_at).toLocaleString("pt-BR");

      lista.innerHTML += `
        <div class="produto-card">
          <div class="produto-meta">
            <strong>Pedido #${pedido.id}</strong>
            <span>R$ ${Number(pedido.total).toFixed(2)}</span>
            <small>${pedido.tipo_entrega}${pedido.mesa ? ` - Mesa ${pedido.mesa}` : ""}</small>
            <small>${pedido.forma_pagamento} - ${data}</small>
            ${montarInfoTroco(pedido)}
            <small>Cliente: ${escapeHTML(pedido.nome_cliente) || "---"}</small>
            ${pedido.endereco ? `<small>Endereço: ${escapeHTML(pedido.endereco)}</small>` : ""}
            <small>Itens: ${itensHtml}</small>
          </div>
        </div>
      `;
    });
  } catch (err) {
    console.error("Erro ao carregar histórico:", err);
    lista.innerHTML =
      '<p class="empty-state">Falha ao carregar histórico. Atualize a página ou tente novamente.</p>';
  }
}

export async function carregarPedidosArquivados() {
  const tituloSecao = document.getElementById("tituloSecao");
  const lista = document.getElementById("listarPedidos");

  if (!lista || !tituloSecao) return;

  try {
    lista.innerHTML =
      '<p class="empty-state">Carregando pedidos arquivados...</p>';
    tituloSecao.innerText = "Pedidos Arquivados";

    const cardHeadP = document.getElementById("card-head-p");
    if (cardHeadP) {
      cardHeadP.innerText = "Pedidos antigos arquivados automaticamente.";
    }

    const pedidos = await fetchComAuth(`${API_URL}/admin/pedidos-arquivados`);

    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      lista.innerHTML =
        '<div class="empty-state">Nenhum pedido arquivado encontrado.</div>';
      return;
    }

    lista.innerHTML = pedidos
      .map((pedido) => {
        const dataFinalizado =
          pedido.finalizado_at &&
          typeof pedido.finalizado_at.toDate === "function"
            ? pedido.finalizado_at.toDate().toLocaleString("pt-BR")
            : new Date(pedido.finalizado_at).toLocaleString("pt-BR");

        const dataArquivado =
          pedido.arquivado_em &&
          typeof pedido.arquivado_em.toDate === "function"
            ? pedido.arquivado_em.toDate().toLocaleString("pt-BR")
            : new Date(pedido.arquivado_em).toLocaleString("pt-BR");

        return `
          <div class="pedido-card arquivado">
            <div class="pedido-topo">
              <h3>Pedido #${pedido.pedido_id || pedido.id}</h3>
              <span class="status-arquivado">Arquivado</span>
            </div>
            <div class="pedido-info">
              <p><strong>Cliente:</strong> ${pedido.nome_cliente || "-"}</p>
              <p><strong>Total:</strong> R$ ${Number(pedido.total).toFixed(2)}</p>
              <p><strong>Pagamento:</strong> ${pedido.forma_pagamento || "-"}</p>
              <p><strong>Entrega:</strong> ${pedido.tipo_entrega || "-"}</p>
              <p><strong>Finalizado em:</strong> ${dataFinalizado}</p>
              <p><strong>Arquivado em:</strong> ${dataArquivado}</p>
            </div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error(error);
    lista.innerHTML =
      '<p class="empty-state">Erro ao carregar pedidos arquivados</p>';
  }
}

export function mostrarBadgePedidos() {
  const badge = document.getElementById("badgePedidos");
  if (badge) {
    badge.classList.remove("hidden");
  }
}

export function esconderBadgePedidos() {
  const badge = document.getElementById("badgePedidos");
  if (badge) {
    badge.classList.add("hidden");
  }
}

export function finalizarPedido(id) {
  Swal.fire({
    title: "Finalizar pedido?",
    text: "Esse pedido será movido para o histórico.",
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Sim, finalizar!",
    cancelButtonText: "Cancelar",
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Finalizando...",
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    fetchComAuth(`${API_URL}/admin/pedidos/${id}/finalizar`, {
      method: "PUT",
    })
      .then(() => {
        showSuccess("Finalizado!", "Pedido concluído com sucesso.");
        carregarPedidos();
        carregarFaturamento();
      })
      .catch((err) => {
        console.error(err);
        showError("Erro ao finalizar", err.message || "Erro no servidor");
      });
  });
}

export function atualizarStatusPedido(id, status) {
  fetchComAuth(`${API_URL}/admin/pedidos/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })
    .then(() => {
      showSuccess(
        "Status atualizado",
        "O cliente já poderá ver a atualização.",
      );
      carregarPedidos();
    })
    .catch((err) => showError("Erro ao atualizar", err.message));
}

export function excluirPedido(id) {
  Swal.fire({
    title: "Tem certeza?",
    text: "Esse pedido será removido!",
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#3085d6",
    cancelButtonColor: "#d33",
    confirmButtonText: "Sim, excluir!",
    cancelButtonText: "Cancelar",
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Excluindo...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    fetchComAuth(`${API_URL}/admin/pedidos/${id}`, {
      method: "DELETE",
    })
      .then(() => {
        showSuccess("Excluído!", "O pedido foi removido com sucesso.");
        carregarPedidos();
      })
      .catch((err) => {
        console.error(err);
        showError("Erro!", "Não foi possível excluir o pedido.");
      });
  });
}

// Exporta as ações para o contexto global (window)
window.finalizarPedido = finalizarPedido;
window.excluirPedido = excluirPedido;
window.atualizarStatusPedido = atualizarStatusPedido;
