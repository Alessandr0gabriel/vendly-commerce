import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";

let graficoDashboardFull = null;
let graficoEvolucaoDashboard = null;
const ORIGEM_IMAGEM_PRODUTO = "https://res.cloudinary.com";

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatarNumero(valor) {
  return Number(valor || 0).toLocaleString("pt-BR");
}

function urlImagemProdutoSegura(valor) {
  if (typeof valor !== "string" || !valor.trim()) return null;

  try {
    const url = new URL(valor);
    return url.protocol === "https:" && url.origin === ORIGEM_IMAGEM_PRODUTO
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function criarPlaceholderImagem() {
  const placeholder = document.createElement("span");
  placeholder.className = "ranking-image-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = "•";
  return placeholder;
}

function criarImagemProduto(url) {
  const urlSegura = urlImagemProdutoSegura(url);
  if (!urlSegura) return criarPlaceholderImagem();

  const imagem = document.createElement("img");
  imagem.className = "ranking-image";
  imagem.alt = "";
  imagem.loading = "lazy";
  imagem.decoding = "async";

  const mostrarPlaceholder = () => {
    imagem.replaceWith(criarPlaceholderImagem());
  };

  imagem.addEventListener("error", mostrarPlaceholder, { once: true });
  imagem.src = urlSegura;
  return imagem;
}

function extrairData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === "function") return valor.toDate();
  if (typeof valor._seconds === "number")
    return new Date(valor._seconds * 1000);
  if (typeof valor.seconds === "number") return new Date(valor.seconds * 1000);
  const data = new Date(valor);
  return isNaN(data.getTime()) ? null : data;
}

function renderizarGraficoDashboard(porFormaPagamento) {
  const canvas = document.getElementById("graficoDashboardFull");
  if (!canvas || typeof Chart === "undefined") return;

  const rotulos = ["Pix", "Cartão", "Dinheiro"];
  const valores = [
    Number(porFormaPagamento?.pix || 0),
    Number(porFormaPagamento?.cartao || 0),
    Number(porFormaPagamento?.dinheiro || 0),
  ];
  const semDados = valores.every((v) => v === 0);
  const legenda = document.getElementById("legendaDashboardFull");

  if (graficoDashboardFull) {
    graficoDashboardFull.destroy();
    graficoDashboardFull = null;
  }

  if (semDados) {
    canvas.style.display = "none";
    if (legenda) {
      legenda.innerHTML =
        "<p class='empty-state'>Ainda não há vendas finalizadas para exibir no gráfico.</p>";
    }
    return;
  }

  canvas.style.display = "block";
  const cores = ["#3ddc97", "#6e8cfe", "#f6b93b"];

  graficoDashboardFull = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: [
        {
          data: valores,
          backgroundColor: cores,
          borderRadius: 8,
          borderSkipped: false,
          barThickness: 26,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: "rgba(255, 255, 255, 0.07)" },
          ticks: {
            color: "rgba(238, 242, 255, 0.58)",
            callback: (value) => `R$ ${formatarMoeda(value)}`,
          },
        },
        y: {
          grid: { display: false },
          ticks: {
            color: "#eef2ff",
            font: { weight: "700" },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = valores.reduce((a, b) => a + b, 0) || 1;
              const pct = ((ctx.raw / total) * 100).toFixed(1);
              return ` R$ ${formatarMoeda(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  if (legenda) {
    const total = valores.reduce((a, b) => a + b, 0) || 1;
    legenda.innerHTML = rotulos
      .map((rotulo, i) => {
        const pct = ((valores[i] / total) * 100).toFixed(1);
        return `
          <div class="legenda-item">
            <span class="legenda-dot" style="background:${cores[i]}"></span>
            <span class="legenda-label">${rotulo}</span>
            <span class="legenda-valor">R$ ${formatarMoeda(valores[i])}</span>
            <span class="legenda-pct">${pct}%</span>
          </div>
        `;
      })
      .join("");
  }
}

function renderizarGraficoEvolucao(evolucao) {
  const canvas = document.getElementById("graficoEvolucaoVendas");
  const container = document.getElementById("graficoEvolucaoVendasWrap");
  if (!canvas || !container || typeof Chart === "undefined") return;

  if (graficoEvolucaoDashboard) {
    graficoEvolucaoDashboard.destroy();
    graficoEvolucaoDashboard = null;
  }

  const labels = Array.isArray(evolucao?.labels) ? evolucao.labels : [];
  const valores = Array.isArray(evolucao?.valores) ? evolucao.valores : [];

  let estado = document.getElementById("graficoEvolucaoVendasEstado");
  if (estado) estado.remove();

  if (
    !labels.length ||
    !valores.length ||
    valores.every((valor) => Number(valor || 0) === 0)
  ) {
    canvas.style.display = "none";
    estado = document.createElement("p");
    estado.id = "graficoEvolucaoVendasEstado";
    estado.className = "empty-state";
    estado.textContent = "Nenhuma venda encontrada neste período.";
    container.appendChild(estado);
    return;
  }

  canvas.style.display = "block";

  graficoEvolucaoDashboard = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Faturamento",
          data: valores.map((valor) => Number(valor || 0)),
          borderColor: "#63d2ff",
          backgroundColor: "rgba(99, 210, 255, 0.18)",
          borderWidth: 3,
          tension: 0.35,
          fill: true,
          pointBackgroundColor: "#63d2ff",
          pointRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "rgba(238,242,255,0.75)" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: {
            color: "rgba(238,242,255,0.75)",
            callback: (value) => `R$ ${formatarMoeda(value)}`,
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `R$ ${formatarMoeda(context.raw)}`,
          },
        },
      },
    },
  });
}

function renderizarProdutosVendidos(produtos) {
  const container = document.getElementById("listaProdutosMaisVendidos");
  if (!container) return;

  container.replaceChildren();

  if (!Array.isArray(produtos) || !produtos.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Nenhum produto vendido no período.";
    container.appendChild(emptyState);
    return;
  }

  produtos.forEach((produto, index) => {
    const item = document.createElement("div");
    item.className = "ranking-item";

    const posicao = document.createElement("div");
    posicao.className = "ranking-spot";
    posicao.textContent = String(index + 1);

    const imagem = criarImagemProduto(produto.imagem);

    const informacoes = document.createElement("div");
    informacoes.className = "ranking-info";

    const nome = document.createElement("strong");
    nome.textContent = produto.nome || "Produto";

    const quantidade = document.createElement("small");
    quantidade.textContent = `${formatarNumero(produto.quantidade || 0)} vendidos`;

    const faturamento = document.createElement("span");
    faturamento.textContent = `R$ ${formatarMoeda(produto.faturamento || 0)}`;

    informacoes.append(nome, quantidade);
    item.append(posicao, imagem, informacoes, faturamento);
    container.appendChild(item);
  });
}

function renderizarStatusEstoque(estoque) {
  const container = document.getElementById("statusEstoqueDashboard");
  if (!container) return;

  const esgotados = Number(estoque?.esgotados || 0);
  const baixo = Number(estoque?.baixo_estoque || 0);
  const disponiveis = Number(estoque?.disponiveis || 0);

  container.innerHTML = `
    <div class="estoque-status-item estoque-red">
      <span class="status-dot">🔴</span>
      <span>${esgotados} produtos esgotados</span>
    </div>
    <div class="estoque-status-item estoque-orange">
      <span class="status-dot">🟠</span>
      <span>${baixo} produtos com estoque baixo</span>
    </div>
    <div class="estoque-status-item estoque-green">
      <span class="status-dot">🟢</span>
      <span>${disponiveis} produtos disponíveis</span>
    </div>
  `;
}

function renderizarUltimosPedidos(pedidos) {
  const container = document.getElementById("listaUltimosPedidosDashboard");
  if (!container) return;

  if (!Array.isArray(pedidos) || !pedidos.length) {
    container.innerHTML =
      "<p class='empty-state'>Nenhum pedido recente encontrado.</p>";
    return;
  }

  container.innerHTML = pedidos
    .map((pedido) => {
      const numero = pedido.numero || `#${String(pedido.id || "").slice(0, 6)}`;
      const dataObj = extrairData(
        pedido.finalizado_at || pedido.criado_em || pedido.created_at,
      );
      const dataFormatada = dataObj
        ? dataObj.toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";

      return `
          <div class="pedido-row">
            <div class="pedido-main">
              <span class="pedido-numero">${numero}</span>
              <span class="pedido-valor">R$ ${formatarMoeda(pedido.total || 0)}</span>
            </div>
            <div class="pedido-meta">
              <span class="pedido-pagamento">${String(pedido.forma_pagamento || "pix").toUpperCase()}</span>
              <span class="pedido-status status-${String(pedido.status || "finalizado").toLowerCase()}">${String(pedido.status || "finalizado").replace(/_/g, " ")}</span>
            </div>
            ${dataFormatada ? `<small>${dataFormatada}</small>` : ""}
          </div>
        `;
    })
    .join("");
}

export async function carregarDashboardFull(periodo = 30) {
  const lista = document.getElementById("listarPedidos");
  if (!lista) return;

  lista.innerHTML = "<p class='empty-state'>Carregando dashboard...</p>";

  try {
    const data = await fetchComAuth(
      `${API_URL}/admin/dashboard-full?periodo=${periodo}`,
    );

    const nomeLoja = data.estabelecimento?.nome || "Sua loja";
    const statusLoja = data.estabelecimento?.ativo ? "Ativa" : "Inativa";
    const statusClasse = data.estabelecimento?.ativo
      ? "badge-active"
      : "badge-inactive";
    const periodos = [
      { valor: 7, label: "7 dias" },
      { valor: 30, label: "30 dias" },
      { valor: 90, label: "3 meses" },
      { valor: 365, label: "Este ano" },
    ];

    lista.innerHTML = `
      <div class="dashboard-full-head">
        <div>
          <h3>${nomeLoja}</h3>
          <span class="saas-badge ${statusClasse}">${statusLoja}</span>
        </div>
        <p>Visão geral completa da sua operação, exclusiva do plano Full.</p>
      </div>

      <div class="dashboard-full-grid">
        <div class="dashboard-stat-card">
          <span class="stat-icon">💰</span>
          <div>
            <p class="stat-label">Faturamento</p>
            <strong class="stat-value">R$ ${formatarMoeda(data.faturamento?.total)}</strong>
          </div>
        </div>
        <div class="dashboard-stat-card">
          <span class="stat-icon">📦</span>
          <div>
            <p class="stat-label">Pedidos</p>
            <strong class="stat-value">${formatarNumero(data.pedidos?.ativos ?? 0)}</strong>
          </div>
        </div>
        <div class="dashboard-stat-card">
          <span class="stat-icon">🧾</span>
          <div>
            <p class="stat-label">Ticket médio</p>
            <strong class="stat-value">R$ ${formatarMoeda(data.pedidos?.ticketMedio)}</strong>
          </div>
        </div>
        <div class="dashboard-stat-card">
          <span class="stat-icon">🛒</span>
          <div>
            <p class="stat-label">Produtos</p>
            <strong class="stat-value">${formatarNumero(data.produtos?.total ?? 0)}</strong>
          </div>
        </div>
      </div>

      <div class="dashboard-main-grid">
        <div class="dashboard-panel dashboard-panel-large">
          <div class="mini-panel-head">
            <h3>Evolução das vendas</h3>
            <div class="chart-period-selector">
              ${periodos
                .map(
                  (periodoItem) => `
                    <button
                      type="button"
                      class="period-button ${Number(periodoItem.valor) === Number(data.periodo_selecionado || periodo) ? "active" : ""}"
                      data-dashboard-periodo="${periodoItem.valor}"
                    >
                      ${periodoItem.label}
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>
          <div id="graficoEvolucaoVendasWrap" class="chart-canvas-wrapper evolution-wrapper">
            <canvas id="graficoEvolucaoVendas"></canvas>
          </div>
        </div>

        <div class="dashboard-side-stack">
          <div class="dashboard-panel dashboard-mini-panel">
            <div class="mini-panel-head">
              <h3>Produtos mais vendidos</h3>
              <button type="button" class="text-link-btn" id="btnVerProdutosDashboard">Ver todos</button>
            </div>
            <div id="listaProdutosMaisVendidos" class="dashboard-list"></div>
          </div>

          <div class="dashboard-panel dashboard-mini-panel">
            <div class="mini-panel-head">
              <h3>Status do estoque</h3>
              <button type="button" class="text-link-btn" id="btnVerEstoqueDashboard">Ver estoque</button>
            </div>
            <div id="statusEstoqueDashboard" class="estoque-status-list"></div>
          </div>
        </div>
      </div>

      <div class="dashboard-panel dashboard-chart-panel">
        <div class="chart-panel-head">
          <h3>Comparativo por forma de pagamento</h3>
          <p>Veja quanto cada canal representa no faturamento da sua loja.</p>
        </div>
        <div class="chart-panel-body">
          <div class="chart-canvas-wrapper">
            <canvas id="graficoDashboardFull"></canvas>
          </div>
          <div id="legendaDashboardFull" class="chart-legend"></div>
        </div>
      </div>

      <div class="dashboard-panel dashboard-orders-panel">
        <div class="mini-panel-head">
          <h3>Últimos pedidos</h3>
          <button type="button" class="text-link-btn" id="btnVerHistoricoDashboard">Ver todos os pedidos</button>
        </div>
        <div id="listaUltimosPedidosDashboard" class="dashboard-list pedidos-list"></div>
      </div>
    `;

    renderizarProdutosVendidos(data.produtos?.mais_vendidos || []);
    renderizarStatusEstoque(data.produtos || {});
    renderizarUltimosPedidos(data.pedidos?.ultimos || []);
    renderizarGraficoEvolucao(data.evolucao_vendas || {});
    renderizarGraficoDashboard(data.por_forma_pagamento);

    document
      .getElementById("btnVerHistoricoDashboard")
      ?.addEventListener("click", () => {
        document.querySelector('.sidebar-link[data-menu="Histórico"]')?.click();
      });
    document
      .getElementById("btnVerProdutosDashboard")
      ?.addEventListener("click", () => {
        document.querySelector('.sidebar-link[data-menu="Produtos"]')?.click();
      });
    document
      .getElementById("btnVerEstoqueDashboard")
      ?.addEventListener("click", () => {
        document.querySelector('.sidebar-link[data-menu="Produtos"]')?.click();
      });

    document.querySelectorAll("[data-dashboard-periodo]").forEach((button) => {
      button.addEventListener("click", () => {
        const proximoPeriodo = Number(button.dataset.dashboardPeriodo || 30);
        carregarDashboardFull(proximoPeriodo);
      });
    });
  } catch (err) {
    console.error("Erro ao carregar dashboard full:", err);
    lista.innerHTML =
      "<p class='empty-state'>Não foi possível carregar o dashboard. Verifique se seu plano é Full.</p>";
  }
}
