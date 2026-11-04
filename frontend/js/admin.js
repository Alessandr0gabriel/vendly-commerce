import { API_URL } from "./core/config.js";
import {
  verificarLogin,
  checkRoleRedirect,
  limparAvisosAssinatura,
} from "./core/auth.js";
import { fetchComAuth } from "./core/api.js";
import { abrirModal, fecharModal, registerModalHooks } from "./ui/modais.js";
import { setFaturamentoTab } from "./ui/tabs.js";
import { showToast } from "./ui/alerts.js";
import {
  carregarProdutos,
  salvarProdutoModal,
  editarProduto,
  alterarEstoque,
  deletarProduto,
  limparProdutoForm,
  atualizarEstadoEstoque,
  isEditingProduto,
} from "./modules/produtos.js";
import {
  carregarPedidos,
  carregarHistorico,
  carregarPedidosArquivados,
  finalizarPedido,
  atualizarStatusPedido,
  excluirPedido,
  mostrarBadgePedidos,
  esconderBadgePedidos,
} from "./modules/pedidos.js";
import { enviarBanner } from "./modules/banner.js";
import {
  carregarEstabelecimento,
  carregarDadosEstabelecimento,
  salvarDados,
  copiarWebhookPedidos,
} from "./modules/estabelecimento.js";
import {
  aplicarHorarios,
  marcarFechado,
  salvarHorarios,
  carregarHorarios,
} from "./modules/horarios.js";
import { carregarURLLoja, copiarURL } from "./modules/linkDALoja.js";
import {
  carregarFaturamento,
  carregarFaturamentoTela,
  filtrarFaturamento,
} from "./modules/faturamento.js";
import { exibirFromAjuda } from "./modules/ajuda.js";
import { montarResumoAssinatura } from "./modules/assinaturaResumo.js";
import {
  setActiveMenu,
  toggleSidebar,
  closeSidebar,
} from "./modules/sidebar.js";
import { disconnectSocket, initSocket } from "./core/socket.js";
import { normalizarPlano, getMenuPlan, canAccessPlan } from "./core/plan.js";
import { esconderLoading } from "./ui/loading.js";

let assinaturaPagamentoTimer = null;
let opcoesPagamentoAssinatura = null;
let periodicidadeAssinatura = "mensal";
let pixAssinaturaAtivo = false;

function formatarDataAssinatura(valor) {
  if (!valor) return "não configurado";
  return new Date(valor).toLocaleDateString("pt-BR");
}

function formatarPrazoAssinatura(dias) {
  if (dias <= 0) return "hoje";
  return `${dias} ${dias === 1 ? "dia" : "dias"}`;
}

function atualizarResumoAssinatura(status) {
  const resumo = document.getElementById("assinaturaResumo");
  const estado = document.getElementById("assinaturaEstado");
  const detalhes = document.getElementById("assinaturaDetalhes");
  if (!resumo || !estado || !detalhes) return;

  resumo.className = `assinatura-resumo status-${status.status || "nao-configurada"}`;
  if (status.status === "ativa") {
    estado.textContent = status.em_teste
      ? "Período de teste grátis"
      : "Assinatura ativa";
    detalhes.textContent = status.em_teste
      ? `Seu teste termina em ${formatarPrazoAssinatura(status.dias_restantes)}. Data final: ${formatarDataAssinatura(status.vence_em)}.`
      : `Faltam ${status.dias_restantes} dias. Vencimento: ${formatarDataAssinatura(status.vence_em)}.`;
  } else if (status.status === "carencia") {
    estado.textContent = "Período de carência";
    detalhes.textContent = `Restam ${status.dias_restantes_carencia} dias. Vencimento: ${formatarDataAssinatura(status.vence_em)}.`;
  } else if (status.status === "suspensa") {
    estado.textContent = "Assinatura expirada e suspensa";
    detalhes.textContent = `Vencimento: ${formatarDataAssinatura(status.vence_em)}. Carência encerrada em ${formatarDataAssinatura(status.carencia_ate)}.`;
  } else {
    estado.textContent = "Assinatura não configurada";
    detalhes.textContent =
      "Consulte o suporte para configurar o plano deste estabelecimento.";
  }
}

function abrirAvisoAssinatura(status) {
  if (status.status === "nao_configurada") return;

  const emTesteAtivo = status.status === "ativa" && status.em_teste === true;
  const aviso =
    status.status === "suspensa"
      ? "suspensa"
      : status.status === "carencia"
        ? "carencia"
        : emTesteAtivo
          ? status.dias_restantes <= 5
            ? "teste_urgente"
            : "teste"
          : status.dias_restantes <= 5
            ? "proxima"
            : null;
  if (!aviso || sessionStorage.getItem(`avisoAssinatura:${aviso}`) === "1")
    return;
  sessionStorage.setItem(`avisoAssinatura:${aviso}`, "1");

  if (aviso === "suspensa") {
    Swal.fire({
      icon: "warning",
      title: "Assinatura suspensa",
      text: "O período de carência terminou. Renove seu plano para recuperar as funcionalidades do Vendly.",
      showCancelButton: true,
      confirmButtonText: "Renovar com Pix",
      cancelButtonText: "Fechar",
    }).then((resultado) => {
      if (resultado.isConfirmed) abrirModalAssinatura();
    });
    return;
  }

  if (aviso === "teste" || aviso === "teste_urgente") {
    const urgente = aviso === "teste_urgente";
    const prazo = formatarPrazoAssinatura(status.dias_restantes);
    Swal.fire({
      icon: urgente ? "warning" : "success",
      title: urgente
        ? "Seu teste grátis está terminando"
        : "Você está no período de teste grátis!",
      text: urgente
        ? `Seu período de teste grátis termina ${prazo === "hoje" ? "hoje" : `em ${prazo}`}. Renove sua assinatura para continuar utilizando o sistema.`
        : `Aproveite os recursos disponíveis no seu plano. Seu período gratuito termina em ${prazo}, em ${formatarDataAssinatura(status.vence_em)}.`,
      showCancelButton: true,
      confirmButtonText: "Renovar agora",
      cancelButtonText: "Continuar",
    }).then((resultado) => {
      if (resultado.isConfirmed) abrirModalAssinatura();
    });
    return;
  }

  const emCarencia = aviso === "carencia";
  Swal.fire({
    icon: "warning",
    title: emCarencia
      ? "Sua assinatura venceu"
      : "Sua assinatura vence em breve",
    text: emCarencia
      ? `Você está no período de carência. Restam ${status.dias_restantes_carencia} dias para regularizar.`
      : `Seu plano Vendly vence em ${status.dias_restantes} dias.`,
    showCancelButton: true,
    confirmButtonText: "Renovar agora",
    cancelButtonText: emCarencia ? "Continuar" : "Lembrar depois",
  }).then((resultado) => {
    if (resultado.isConfirmed) abrirModalAssinatura();
  });
}

async function carregarStatusAssinatura(mostrarAviso = true) {
  try {
    const status = await fetchComAuth(`${API_URL}/assinatura/status`);
    if (mostrarAviso) abrirAvisoAssinatura(status);
    return status;
  } catch (err) {
    console.warn("Não foi possível carregar o status da assinatura:", err);
    return { status: "nao_configurada" };
  }
}

async function monitorarPagamentoAssinatura(pagamentoId) {
  if (assinaturaPagamentoTimer) clearInterval(assinaturaPagamentoTimer);
  assinaturaPagamentoTimer = setInterval(async () => {
    try {
      const pagamento = await fetchComAuth(
        `${API_URL}/pagamentos-assinatura/${pagamentoId}/status`,
      );
      if (["expirado", "rejected", "cancelled"].includes(pagamento.status)) {
        clearInterval(assinaturaPagamentoTimer);
        assinaturaPagamentoTimer = null;
        document.getElementById("assinaturaStatus").textContent =
          "Este Pix expirou. Gere uma nova cobrança.";
        pixAssinaturaAtivo = false;
        document
          .querySelectorAll(".assinatura-opcao")
          .forEach((opcao) => (opcao.disabled = false));
        const botao = document.getElementById("btnCriarPixAssinatura");
        if (botao) {
          botao.disabled = false;
          botao.textContent = textoBotaoPixAssinatura();
        }
        return;
      }
      if (!pagamento.assinatura_aplicada) return;
      clearInterval(assinaturaPagamentoTimer);
      assinaturaPagamentoTimer = null;
      limparAvisosAssinatura();
      const status = await carregarStatusAssinatura(false);
      atualizarResumoAssinatura(status);
      fecharModalAssinatura();
      Swal.fire(
        "Pagamento confirmado",
        `Sua assinatura foi renovada até ${formatarDataAssinatura(status.vence_em)}.`,
        "success",
      );
    } catch (err) {
      console.warn(
        "Não foi possível atualizar o pagamento da assinatura:",
        err,
      );
    }
  }, 10000);
}

function textoBotaoPixAssinatura() {
  const valores = opcoesPagamentoAssinatura?.[periodicidadeAssinatura];
  const valorFormatado =
    periodicidadeAssinatura === "mensal"
      ? valores?.valorFormatado
      : valores?.valorFinalFormatado;
  return valorFormatado
    ? `Pagar ${valorFormatado} via Pix`
    : "Pagar plano via Pix";
}

function renderizarOpcoesPagamentoAssinatura() {
  if (!opcoesPagamentoAssinatura) return;
  const mensal = opcoesPagamentoAssinatura.mensal;
  const anual = opcoesPagamentoAssinatura.anual;

  document.getElementById("assinaturaPlanoAtual").textContent =
    opcoesPagamentoAssinatura.plano;
  document.getElementById("assinaturaPrecoMensal").textContent =
    mensal.valorFormatado;
  document.getElementById("assinaturaDuracaoMensal").textContent =
    `Renovação por ${mensal.dias} dias`;
  document.getElementById("assinaturaPrecoAnualOriginal").textContent =
    anual.valorSemDescontoFormatado;
  document.getElementById("assinaturaPrecoAnual").textContent =
    anual.valorFinalFormatado;
  document.getElementById("assinaturaDescontoBadge").textContent =
    `${anual.descontoPercentual}% OFF`;
  document.getElementById("assinaturaEconomiaAnual").textContent =
    `Economize ${anual.economiaFormatada} no ano`;
  document.getElementById("assinaturaEquivalenteMensal").textContent =
    `Equivale a ${anual.equivalenteMensalFormatado}/mês`;

  const mensalSelecionado = periodicidadeAssinatura === "mensal";
  document
    .getElementById("assinaturaOpcaoMensal")
    .setAttribute("aria-checked", String(mensalSelecionado));
  document
    .getElementById("assinaturaOpcaoAnual")
    .setAttribute("aria-checked", String(!mensalSelecionado));

  const lista = document.getElementById("assinaturaResumoLista");
  lista.replaceChildren();
  montarResumoAssinatura(
    opcoesPagamentoAssinatura,
    mensalSelecionado ? "mensal" : "anual",
  ).forEach((linha) => {
    const div = document.createElement("div");
    div.dataset.linha = linha.id;
    if (linha.destaque) div.className = "assinatura-resumo-total";
    const dt = document.createElement("dt");
    dt.textContent = linha.rotulo;
    const dd = document.createElement("dd");
    dd.textContent = linha.valor;
    div.append(dt, dd);
    lista.appendChild(div);
  });

  const botao = document.getElementById("btnCriarPixAssinatura");
  if (botao && !pixAssinaturaAtivo) {
    botao.textContent = textoBotaoPixAssinatura();
    botao.disabled = false;
  }
}

function selecionarPeriodicidadeAssinatura(periodicidade) {
  if (
    !opcoesPagamentoAssinatura ||
    !["mensal", "anual"].includes(periodicidade) ||
    pixAssinaturaAtivo
  ) {
    return;
  }
  periodicidadeAssinatura = periodicidade;
  renderizarOpcoesPagamentoAssinatura();
}

async function carregarOpcoesPagamentoAssinatura() {
  const carregando = document.getElementById("assinaturaOpcoesCarregando");
  const erro = document.getElementById("assinaturaOpcoesErro");
  const conteudo = document.getElementById("assinaturaOpcoesConteudo");
  const botao = document.getElementById("btnCriarPixAssinatura");

  opcoesPagamentoAssinatura = null;
  pixAssinaturaAtivo = false;
  carregando.hidden = false;
  erro.hidden = true;
  conteudo.hidden = true;
  botao.disabled = true;
  botao.textContent = "Carregando valores...";

  try {
    const valores = await fetchComAuth(
      `${API_URL}/pagamentos-assinatura/opcoes`,
    );
    if (
      !valores?.plano ||
      !Number.isSafeInteger(valores.mensal?.valorCentavos) ||
      !Number.isSafeInteger(valores.anual?.valorFinalCentavos) ||
      !valores.mensal?.valorFormatado ||
      !valores.anual?.valorFinalFormatado
    ) {
      throw new Error("A resposta de valores da assinatura é inválida.");
    }

    opcoesPagamentoAssinatura = valores;
    periodicidadeAssinatura = "mensal";
    document.getElementById("assinaturaPixResultado").hidden = true;
    document
      .querySelectorAll(".assinatura-opcao")
      .forEach((opcao) => (opcao.disabled = false));
    renderizarOpcoesPagamentoAssinatura();
    conteudo.hidden = false;
  } catch (err) {
    console.error("Não foi possível carregar os valores da assinatura:", err);
    erro.hidden = false;
  } finally {
    carregando.hidden = true;
  }
}

async function criarPixAssinatura() {
  const botao = document.getElementById("btnCriarPixAssinatura");
  if (!opcoesPagamentoAssinatura || pixAssinaturaAtivo || botao?.disabled)
    return;

  try {
    if (botao) {
      botao.disabled = true;
      botao.classList.add("is-loading");
      botao.setAttribute("aria-busy", "true");
      botao.innerHTML =
        '<span class="button-spinner" aria-hidden="true"></span>Gerando Pix...';
    }
    document.getElementById("assinaturaPixResultado").hidden = true;
    const pagamento = await fetchComAuth(
      `${API_URL}/pagamentos-assinatura/criar-pix`,
      {
        method: "POST",
        body: JSON.stringify({
          periodicidade: periodicidadeAssinatura,
        }),
      },
    );
    if (
      !Number.isSafeInteger(pagamento.valor_centavos) ||
      !pagamento.valor_formatado ||
      !pagamento.pagamento_id
    ) {
      throw new Error("O Pix retornou dados de cobrança inválidos.");
    }

    const qrCode = document.getElementById("assinaturaQrCode");
    qrCode.src = pagamento.qr_code_base64
      ? `data:image/png;base64,${pagamento.qr_code_base64}`
      : "";
    qrCode.hidden = !pagamento.qr_code_base64;
    document.getElementById("assinaturaPixDetalhes").textContent =
      `${pagamento.plano} · ${pagamento.periodicidade === "anual" ? "Anual" : "Mensal"} · ${pagamento.valor_formatado}`;
    document.getElementById("assinaturaCopiaCola").value =
      pagamento.copia_e_cola || "";
    document.getElementById("assinaturaPixResultado").hidden = false;
    document.getElementById("assinaturaStatus").textContent =
      "Aguardando pagamento...";
    pixAssinaturaAtivo = true;
    document
      .querySelectorAll(".assinatura-opcao")
      .forEach((opcao) => (opcao.disabled = true));
    if (botao) botao.textContent = "Pix gerado · aguardando pagamento";
    monitorarPagamentoAssinatura(pagamento.pagamento_id);
  } catch (err) {
    Swal.fire("Erro", err.message || "Não foi possível gerar o Pix.", "error");
  } finally {
    if (botao) {
      botao.classList.remove("is-loading");
      botao.removeAttribute("aria-busy");
      if (!pixAssinaturaAtivo) {
        botao.disabled = !opcoesPagamentoAssinatura;
        botao.textContent = opcoesPagamentoAssinatura
          ? textoBotaoPixAssinatura()
          : "Pagar plano via Pix";
      }
    }
  }
}

let aberturaAssinaturaEmAndamento = null;

function abrirModalAssinatura() {
  if (aberturaAssinaturaEmAndamento) return aberturaAssinaturaEmAndamento;
  aberturaAssinaturaEmAndamento = (async () => {
    try {
      await abrirModal("assinatura");
      await Promise.all([
        carregarStatusAssinatura(false).then(atualizarResumoAssinatura),
        carregarOpcoesPagamentoAssinatura(),
      ]);
    } finally {
      aberturaAssinaturaEmAndamento = null;
    }
  })();
  return aberturaAssinaturaEmAndamento;
}

function limparEstadoAssinatura() {
  if (assinaturaPagamentoTimer) {
    clearInterval(assinaturaPagamentoTimer);
    assinaturaPagamentoTimer = null;
  }
  pixAssinaturaAtivo = false;
  opcoesPagamentoAssinatura = null;
  const pix = document.getElementById("assinaturaPixResultado");
  if (pix) pix.hidden = true;
  document.body.style.overflow = "";
}

function fecharModalAssinatura(event) {
  if (event && event.target?.id !== "modalAssinatura") return;
  fecharModal(event, "modalAssinatura");
}

async function copiarPixAssinatura() {
  const valor = document.getElementById("assinaturaCopiaCola")?.value || "";
  if (!valor) return;
  await navigator.clipboard.writeText(valor);
  if (typeof showToast === "function") showToast("success", "Pix copiado!");
}

const somNotificacao = new Audio("../assets/sounds/notificacao.mp3");
let audioLiberado = false;

function moverFormulariosParaPainel() {
  const panelCard = document.querySelector(".panel-card.full-card");
  if (!panelCard) return;

  [
    "modalProduto",
    "modalHorarios",
    "modalBanner",
    "modalDados",
    "modalLinkDaLoja",
    "modalAssinatura",
  ].forEach((modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add("panel-form-view");
    panelCard.appendChild(modal);
  });
}

moverFormulariosParaPainel();

function habilitarAudio() {
  if (audioLiberado) return;
  audioLiberado = true;
  somNotificacao.load();
}

document.addEventListener("pointerdown", habilitarAudio, { once: true });
document.addEventListener("keydown", habilitarAudio, { once: true });

// Hooks de modais sincronizados com o estado do produto e do estabelecimento
registerModalHooks({
  afterCloseAssinatura: limparEstadoAssinatura,
  afterCloseProduto: () => {
    limparProdutoForm();
    atualizarEstadoEstoque();
  },
  beforeOpenProduto: () => {
    if (!isEditingProduto()) {
      limparProdutoForm();
      atualizarEstadoEstoque();
      const title = document.getElementById("produtoModalTitle");
      if (title) title.textContent = "Cadastrar Produto";
    }
  },
  beforeOpenAnyModal: async (modalName) => {
    if (modalName === "dados") {
      await carregarDadosEstabelecimento();
    }

    if (modalName === "horarios") {
      await carregarHorarios();
    }

    if (modalName === "linkDaLoja") {
      await carregarURLLoja();
    }
  },
});

// Manipulador de notificações de tempo real via WebSockets mapeado pelo Express
function handleNovoPedido(pedido) {
  const activeMenu = document.querySelector(".sidebar-link.active")?.dataset
    ?.menu;

  if (activeMenu === "Pedidos") {
    esconderBadgePedidos();
    carregarPedidos();
    return;
  }

  mostrarBadgePedidos();

  if (audioLiberado) {
    somNotificacao.currentTime = 0;
    somNotificacao.play().catch((err) => {
      console.log("Erro ao reproduzir áudio de notificação:", err);
    });
  }

  Swal.fire({
    toast: true,
    position: "top-end",
    icon: "info",
    title: "Novo pedido recebido!",
    showConfirmButton: false,
    timer: 3000,
  });
}

async function startApp() {
  if (localStorage.getItem("primeiroLogin") === "true") {
    window.location.replace("trocar-senha.html");
    return;
  }

  const carregamentosIniciais = [];
  document.body.classList.remove("restrito");
  const statusAssinatura = await carregarStatusAssinatura();
  const assinaturaSuspensa = statusAssinatura.status === "suspensa";
  let plan = normalizarPlano(localStorage.getItem("plan"));

  try {
    const estab = await fetchComAuth(`${API_URL}/admin/me/estabelecimento`);
    if (estab?.plano) {
      plan = normalizarPlano(estab.plano);
      localStorage.setItem("plan", plan);
    }
  } catch (err) {
    console.warn("Não foi possível sincronizar o plano do administrador:", err);
  }

  const menuPlanLabel = document.getElementById("planLabel");
  if (menuPlanLabel) {
    menuPlanLabel.textContent = `Plano ${plan === "full" ? "Full" : plan === "medio" ? "Médio" : "Barato"}`;
  }

  document.querySelectorAll(".sidebar-link[data-menu]").forEach((btn) => {
    const requiredPlan = getMenuPlan(btn.dataset.menu);
    if (!requiredPlan) return;

    const allowed = plan === "superadmin" || canAccessPlan(plan, requiredPlan);
    btn.style.display = allowed ? "flex" : "none";
  });

  if (!assinaturaSuspensa) {
    const activeButton = document.querySelector(".sidebar-link.active");
    if (activeButton && activeButton.style.display !== "none") {
      await setActiveMenu(activeButton);
    } else {
      const firstVisible = document.querySelector(
        '.sidebar-link[data-menu]:not([style*="display: none"])',
      );
      if (firstVisible) {
        await setActiveMenu(firstVisible);
      } else {
        await carregarPedidos();
      }
    }
  }

  if (!assinaturaSuspensa) initSocket();
  carregamentosIniciais.push(
    carregarURLLoja(),
    carregarEstabelecimento(),
    carregarDadosEstabelecimento(),
  );
  if (!assinaturaSuspensa) carregamentosIniciais.push(carregarFaturamento());
  await Promise.allSettled(carregamentosIniciais);
  esconderLoading();
}

window.addEventListener("assinaturaSuspensa", () => {
  abrirAvisoAssinatura({ status: "suspensa" });
});

// Inicializadores globais de contexto de modais adicionais
function abrirModalLinkDaLoja() {
  carregarURLLoja();
  abrirModal("linkDaLoja");
}

function logout() {
  Swal.fire({
    title: "Sair do sistema?",
    text: "Você precisará fazer login novamente.",
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Sim, sair",
    cancelButtonText: "Cancelar",
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Saindo...",
      text: "Por favor, aguarde.",
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    const csrfToken = localStorage.getItem("csrfToken");

    const headers = {};
    if (csrfToken) headers["x-csrf-token"] = csrfToken;

    fetch(`${API_URL}/api/admin/logout`, {
      method: "POST",
      credentials: "include",
      headers: headers,
    }).finally(() => {
      limparAvisosAssinatura();
      localStorage.clear();

      setTimeout(() => {
        window.location.href = "login.html";
      }, 800);
    });
  });
}

// Vinculação unificada e higienizada de eventos de alteração de estado de estoque do DOM
document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("controlaEstoque");
  if (checkbox) {
    checkbox.addEventListener("change", atualizarEstadoEstoque);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  await carregarURLLoja();
  document.getElementById("btnCopiarURL")?.addEventListener("click", copiarURL);
});

checkRoleRedirect();

// EXPOSIÇÃO GLOBAL COMPLETA
window.toggleSidebar = toggleSidebar;
window.setActiveMenu = setActiveMenu;
window.abrirModal = abrirModal;
window.abrirModalLinkDaLoja = abrirModalLinkDaLoja;
window.fecharModal = fecharModal;
window.salvarProdutoModal = salvarProdutoModal;
window.alterarEstoque = alterarEstoque;
window.editarProduto = editarProduto;
window.deletarProduto = deletarProduto;
window.finalizarPedido = finalizarPedido;
window.atualizarStatusPedido = atualizarStatusPedido;
window.excluirPedido = excluirPedido;
window.enviarBanner = enviarBanner;
window.salvarDados = salvarDados;
window.aplicarHorarios = aplicarHorarios;
window.marcarFechado = marcarFechado;
window.salvarHorarios = salvarHorarios;
window.carregarHorarios = carregarHorarios;
window.copiarURL = copiarURL;
window.copiarWebhookPedidos = copiarWebhookPedidos;
window.logout = logout;
window.setFaturamentoTab = setFaturamentoTab;
window.filtrarFaturamento = filtrarFaturamento;
window.exibirFromAjuda = exibirFromAjuda;
window.closeSidebar = closeSidebar;
window.carregarPedidosArquivados = carregarPedidosArquivados;
window.mostrarBadgePedidos = mostrarBadgePedidos;
window.esconderBadgePedidos = esconderBadgePedidos;
window.criarPixAssinatura = criarPixAssinatura;
window.carregarOpcoesPagamentoAssinatura = carregarOpcoesPagamentoAssinatura;
window.selecionarPeriodicidadeAssinatura = selecionarPeriodicidadeAssinatura;
window.abrirModalAssinatura = abrirModalAssinatura;
window.fecharModalAssinatura = fecharModalAssinatura;
window.copiarPixAssinatura = copiarPixAssinatura;

// Garante o ciclo de vida de validação de autenticação ativa baseado no Session Cookie do Firebase
verificarLogin({
  onReady: startApp,
  onNewOrder: handleNovoPedido,
});
