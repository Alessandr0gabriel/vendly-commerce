let modalHooks = {};

export function registerModalHooks(hooks) {
  modalHooks = hooks || {};
}

// Garante uma única view de formulário ativa por vez no painel.
function fecharOutrosModais(modalAtual) {
  document.querySelectorAll(".panel-form-view.active").forEach((aberto) => {
    if (aberto === modalAtual) return;
    aberto.classList.remove("active");
    executarHooksFechamento(aberto.id);
  });
}

function executarHooksFechamento(modalId) {
  if (
    modalId === "modalProduto" &&
    typeof modalHooks.afterCloseProduto === "function"
  ) {
    modalHooks.afterCloseProduto();
  }
  if (
    modalId === "modalAssinatura" &&
    typeof modalHooks.afterCloseAssinatura === "function"
  ) {
    modalHooks.afterCloseAssinatura();
  }
}

export async function abrirModal(modalName) {
  const panelLoading = document.getElementById("panelLoading");
  if (panelLoading) panelLoading.classList.add("active");

  try {
    if (typeof modalHooks.beforeOpenAnyModal === "function") {
      await modalHooks.beforeOpenAnyModal(modalName);
    }

    if (
      modalName === "produto" &&
      typeof modalHooks.beforeOpenProduto === "function"
    ) {
      modalHooks.beforeOpenProduto();
    }

    const modal = document.getElementById(
      `modal${modalName.charAt(0).toUpperCase() + modalName.slice(1)}`,
    );
    if (modal) {
      fecharOutrosModais(modal);
      document.getElementById("panelDefaultContent")?.classList.add("hidden");
      modal.classList.add("active");
    }
  } catch (err) {
    console.error("Erro ao preparar formulário no painel:", err);
  } finally {
    if (panelLoading) panelLoading.classList.remove("active");
  }
}

// Fecha qualquer formulário ativo (executando hooks) e restaura o conteúdo principal.
export function fecharTodosModais() {
  document.querySelectorAll(".panel-form-view.active").forEach((aberto) => {
    aberto.classList.remove("active");
    executarHooksFechamento(aberto.id);
  });
  document.getElementById("panelDefaultContent")?.classList.remove("hidden");
}

export function fecharModal(event, modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  if (event && event.target !== modal) return;
  modal.classList.remove("active");
  document.getElementById("panelDefaultContent")?.classList.remove("hidden");
  executarHooksFechamento(modalId);
}