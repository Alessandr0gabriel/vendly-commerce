import {
  carregarPedidos,
  carregarHistorico,
  carregarPedidosArquivados,
  mostrarBadgePedidos,
  esconderBadgePedidos,
} from "./pedidos.js";
import { carregarProdutos } from "./produtos.js";
import { carregarFaturamentoTela } from "./faturamento.js";
import { carregarDashboardFull } from "./dashboardFull.js";
import { exibirFromAjuda } from "./ajuda.js";
import { abrirModal, fecharTodosModais } from "../ui/modais.js";
import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";

let telaAtiva = "pedidos";

// Menus que abrem apenas um formulário; a seção permanece ativa após salvar/fechar.
const SECOES_FORMULARIO = {
  Horários: ["Horários", "Defina os horários de funcionamento da loja."],
  Banner: ["Banner", "Atualize o banner da sua loja."],
  "Dados da loja": ["Dados da loja", "Altere nome, telefone e chaves da loja."],
  Link: ["Link da loja", "Compartilhe o link da sua loja."],
};

// Substitui o conteúdo anterior (ex.: Pedidos) para que nunca apareça sob a seção escolhida.
function mostrarSecaoFormulario(menu) {
  const [nome, texto] = SECOES_FORMULARIO[menu];
  const titulo = document.getElementById("tituloSecao");
  const descricao = document.getElementById("card-head-p");
  const lista = document.getElementById("listarPedidos");
  if (titulo) titulo.textContent = nome;
  if (descricao) descricao.textContent = texto;
  if (lista) {
    lista.innerHTML =
      '<p class="empty-state">Use o formulário desta seção. Para abri-lo novamente, clique no item correspondente no menu.</p>';
  }
}

export function getTelaAtiva() {
  return telaAtiva;
}

export function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  sidebar.classList.toggle("active");
}

export function closeSidebar() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  sidebar.classList.remove("active");
}

export async function setActiveMenu(button) {
  if (!button) return;

  const panelLoading = document.getElementById("panelLoading");
  if (panelLoading) panelLoading.classList.add("active");

  fecharTodosModais();

  try {
    document.querySelectorAll(".sidebar-link").forEach((el) => {
      el.classList.remove("active");
    });

    button.classList.add("active");
    const menu = button.dataset.menu;
    const descricao = document.querySelector(".card-head p");
    const titulo = document.getElementById("tituloSecao");

    if (SECOES_FORMULARIO[menu]) mostrarSecaoFormulario(menu);

    if (menu === "Dashboard") {
      telaAtiva = "dashboardFull";
      if (titulo) {
        titulo.textContent = "Dashboard";
        if (descricao)
          descricao.textContent = "Visão geral completa da sua operação";
      }
      await carregarDashboardFull();
    }

    if (menu === "Pedidos") {
      telaAtiva = "pedidos";
      esconderBadgePedidos();
      if (titulo) titulo.textContent = "Pedidos pendentes";
      if (descricao)
        descricao.textContent =
          "Visualize e finalize pedidos feitos pelos clientes. Gerencie os pedidos em tempo real.";
      await carregarPedidos();
    }

    if (menu === "Produtos") {
      // Para lojas no plano 'barato' é obrigatório ter horários configurados
      const plan = localStorage.getItem("plan") || "barato";
      if (plan === "barato") {
        const establishmentId = localStorage.getItem("establishmentId");
        try {
          const data = await fetchComAuth(
            `${API_URL}/estabelecimentos/${establishmentId}/horarios`,
          );
          const hasHorarios =
            data && data.horarios && Object.keys(data.horarios).length > 0;
          if (!hasHorarios) {
            mostrarSecaoFormulario("Horários");
            // Avisar e abrir modal de horários ao invés de carregar produtos
            Swal.fire({
              icon: "warning",
              title: "Horários necessários",
              text: "Seu plano requer horários para o funcionamento do cardápio. Defina-os agora.",
              confirmButtonText: "Definir horários",
            }).then(() => {
              abrirModal("horarios");
            });
            return;
          }
        } catch (err) {
          console.error("Erro ao verificar horários:", err);
        }
      }

      telaAtiva = "produtos";
      if (titulo) {
        titulo.textContent = "Produtos";
        if (descricao)
          descricao.textContent = "Gerencie os produtos do seu cardápio";
      }
      await carregarProdutos();
    }

    if (menu === "Histórico") {
      telaAtiva = "historico";
      if (titulo) {
        titulo.textContent = "Histórico";
        if (descricao) descricao.textContent = "Gerencie seu histórico";
      }
      await carregarHistorico();
    }

    if (menu === "Pedidos Arquivados") {
      telaAtiva = "pedidosArquivados";
      await carregarPedidosArquivados();
    }

    if (menu === "Faturamento") {
      telaAtiva = "faturamento";
      if (titulo) {
        titulo.textContent = "Faturamento";
        if (descricao)
          descricao.textContent =
            "Visualize o desempenho financeiro da sua loja";
      }
      await carregarFaturamentoTela();
    }

    if (menu === "Ajuda") {
      telaAtiva = "ajuda";
      if (titulo) {
        titulo.textContent = "Ajuda";
        if (descricao)
          descricao.textContent =
            "Entre em contato com o suporte e nos explique seu problema!";
      }
      exibirFromAjuda();
    }

    closeSidebar();
  } finally {
    if (panelLoading) panelLoading.classList.remove("active");
  }
}

// FIX: Vincula as funções de navegação ao escopo global (window)
// Isso evita erros de "ReferenceError" se chamadas via onclick="..." direto no HTML da barra lateral.
window.setActiveMenu = setActiveMenu;
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
