import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { definirDatasPadrao } from "../ui/tabs.js";
import { showError } from "../ui/alerts.js";

// Mantém a instância única do gráfico para destruir antes de recriar (evita vazamento de memória)
let graficoFormaPagamento = null;

export async function carregarFaturamento() {
  try {
    const data = await fetchComAuth(`${API_URL}/admin/faturamento`);
    const total = Number(data.faturamento_hoje || 0).toFixed(2);
    const faturamentoEl = document.getElementById("mediaFaturamento");
    if (faturamentoEl) {
      faturamentoEl.textContent = `R$ ${total}`;
    }
  } catch (err) {
    console.error("Erro ao carregar faturamento:", err);
    const faturamentoEl = document.getElementById("mediaFaturamento");
    if (faturamentoEl) {
      faturamentoEl.textContent = "R$ 0,00";
    }
  }
}

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function renderizarGraficoFormaPagamento(porFormaPagamento) {
  const canvas = document.getElementById("graficoFormaPagamento");
  if (!canvas || typeof Chart === "undefined") return;

  const rotulos = ["Pix", "Cartão", "Dinheiro"];
  const valores = [
    Number(porFormaPagamento?.pix || 0),
    Number(porFormaPagamento?.cartao || 0),
    Number(porFormaPagamento?.dinheiro || 0),
  ];
  const semDados = valores.every((v) => v === 0);

  const legenda = document.getElementById("legendaFormaPagamento");

  if (graficoFormaPagamento) {
    graficoFormaPagamento.destroy();
    graficoFormaPagamento = null;
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

  graficoFormaPagamento = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: rotulos,
      datasets: [
        {
          data: valores,
          backgroundColor: cores,
          borderColor: "rgba(15, 23, 42, 0.9)",
          borderWidth: 3,
          hoverOffset: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
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

export async function carregarFaturamentoTela() {
  const lista = document.getElementById("listarPedidos");
  if (!lista) return;

  lista.innerHTML = "<p class='empty-state'>Carregando faturamento...</p>";

  try {
    const data = await fetchComAuth(`${API_URL}/admin/faturamento`);
    const total = Number(data.faturamento_total || 0).toFixed(2);
    const semana = Number(data.faturamento_semana || 0).toFixed(2);
    const mes = Number(data.faturamento_mes || 0).toFixed(2);

    lista.innerHTML = `
      <div class="filtro-data">
        <div class="input-group">
          <label>Data inicial</label>
          <input type="date" id="dataInicio" />
        </div>

        <div class="input-group">
          <label>Data final</label>
          <input type="date" id="dataFim" />
        </div>

        <button class="primary-btn" id="btnFiltrarFaturamento">Filtrar</button>
      </div>

      <div class="faturamento-summary-grid">
        <div class="faturamento-stat-card">
          <span class="stat-icon">💰</span>
          <div>
            <p class="stat-label">Total acumulado</p>
            <strong class="stat-value">R$ ${total}</strong>
          </div>
        </div>
        <div class="faturamento-stat-card">
          <span class="stat-icon">📅</span>
          <div>
            <p class="stat-label">Últimos 7 dias</p>
            <strong class="stat-value">R$ ${semana}</strong>
          </div>
        </div>
        <div class="faturamento-stat-card">
          <span class="stat-icon">🗓️</span>
          <div>
            <p class="stat-label">Últimos 30 dias</p>
            <strong class="stat-value">R$ ${mes}</strong>
          </div>
        </div>
      </div>

      <div class="faturamento-chart-panel">
        <div class="chart-panel-head">
          <h3>Distribuição por forma de pagamento</h3>
          <p>Percentual do faturamento total por meio de pagamento.</p>
        </div>
        <div class="chart-panel-body">
          <div class="chart-canvas-wrapper">
            <canvas id="graficoFormaPagamento"></canvas>
          </div>
          <div id="legendaFormaPagamento" class="chart-legend"></div>
        </div>
      </div>

      <div id="resultadoFaturamento" class="resultado-faturamento">
        <p>💰 Faturamento no período</p>
        <h1 id="valorPeriodoTotal">R$ ${total}</h1>
      </div>
    `;

    definirDatasPadrao();
    vincularEventosFaturamento();
    renderizarGraficoFormaPagamento(data.por_forma_pagamento);
  } catch (err) {
    console.error(err);
    lista.innerHTML = "<p class='empty-state'>Erro ao carregar faturamento</p>";
  }
}

export async function filtrarFaturamento() {
  const inicio = document.getElementById("dataInicio")?.value;
  const fim = document.getElementById("dataFim")?.value;
  const container = document.getElementById("resultadoFaturamento");

  if (!inicio || !fim) {
    alert("Selecione as datas!");
    return;
  }

  if (!container) return;
  container.innerHTML = "Carregando...";

  try {
    const data = await fetchComAuth(
      `${API_URL}/admin/faturamento?inicio=${inicio}&fim=${fim}`,
    );
    const total = Number(data.faturamento_total || 0).toFixed(2);

    container.innerHTML = `
      <div class="faturamento-card">
        <h3>💰 Período selecionado</h3>
        <strong>R$ ${total}</strong>
      </div>
    `;
  } catch (err) {
    console.error(err);
    container.innerHTML = "Erro ao buscar faturamento";
  }
}

function vincularEventosFaturamento() {
  const btnFiltrar = document.getElementById("btnFiltrarFaturamento");
  if (btnFiltrar) {
    btnFiltrar.addEventListener("click", filtrarFaturamento);
  }
}

window.filtrarFaturamento = filtrarFaturamento;
