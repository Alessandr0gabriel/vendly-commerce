import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showError, showSuccess, showToast } from "../ui/alerts.js";

function atualizarNomeEstabelecimento(nome) {
  const establishmentNameEl = document.getElementById("establishmentName");
  const sidebarName = document.getElementById("sidebarEstablishmentName");
  const brandIcon = document.getElementById("brandIcon");

  if (establishmentNameEl) establishmentNameEl.textContent = nome;
  if (sidebarName) sidebarName.textContent = nome;
  if (brandIcon) brandIcon.textContent = [...nome][0]?.toUpperCase() || "";
  localStorage.setItem("establishmentName", nome);
}

export async function carregarEstabelecimento() {
  const establishmentName = localStorage.getItem("establishmentName");
  const establishmentNameEl = document.getElementById("establishmentName");
  const sidebarName = document.getElementById("sidebarEstablishmentName");
  const brandIcon = document.getElementById("brandIcon");

  if (establishmentName) {
    atualizarNomeEstabelecimento(establishmentName);
  }

  try {
    const json = await fetchComAuth(`${API_URL}/admin/me/estabelecimento`);

    if (json && json.nome) {
      atualizarNomeEstabelecimento(json.nome);
    } else {
      throw new Error("Dados do estabelecimento incompletos");
    }
  } catch (err) {
    console.error("Erro ao carregar estabelecimento:", err);
    if (!establishmentName && establishmentNameEl)
      establishmentNameEl.textContent = "Estabelecimento: erro ao carregar";
    if (!establishmentName && sidebarName)
      sidebarName.textContent = "Erro ao carregar";
    if (!establishmentName && brandIcon) brandIcon.textContent = "?";
  }
}

export async function carregarURLLoja() {
  const establishmentId = localStorage.getItem("establishmentId");
  const urlLojaInput = document.getElementById("urlLoja");

  if (!establishmentId) {
    if (urlLojaInput) urlLojaInput.value = "";
    return;
  }

  try {
    const data = await fetchComAuth(
      `${API_URL}/estabelecimentos/${establishmentId}`,
    );
    if (urlLojaInput && data && data.slug) {
      urlLojaInput.value = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, "index.html")}?estab=${encodeURIComponent(data.slug)}`;
    }
  } catch (err) {
    console.error("Erro ao carregar URL da loja:", err);
    if (urlLojaInput) urlLojaInput.value = "";
  }
}

export function copiarURL() {
  const input = document.getElementById("urlLoja");
  if (!input) return;

  input.select();
  navigator.clipboard.writeText(input.value);

  showToast("success", "Link copiado!");
}

export function copiarWebhookPedidos() {
  const input = document.getElementById("inputWebhookPedidosUrl");
  if (!input?.value) return;

  navigator.clipboard.writeText(input.value);
  showToast("success", "URL do webhook copiada!");
}

export async function salvarDados() {
  const inputNome = document.getElementById("inputNomeEstabelecimento");
  const nome = inputNome?.value?.trim();
  if (!nome) {
    showError(
      "Nome inválido",
      "Informe um nome de estabelecimento que não esteja vazio.",
    );
    return;
  }

  const telefone = document.getElementById("inputTelefone")?.value;
  const mercadopago_access_token = document.getElementById(
    "inputMercadoPagoToken",
  )?.value;
  const mercadopago_secret_key = document.getElementById(
    "inputMercadoPagoSecretKey",
  )?.value;
  const establishmentId = localStorage.getItem("establishmentId");

  // Trava visual durante a atualização cadastral
  Swal.fire({
    title: "Atualizando dados...",
    text: "Salvando novas informações do estabelecimento.",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  try {
    if (nome !== inputNome.dataset.persistedName) {
      const resultadoNome = await fetchComAuth(
        `${API_URL}/admin/me/estabelecimento/nome`,
        {
          method: "PUT",
          body: JSON.stringify({ nome }),
        },
      );
      inputNome.dataset.persistedName = resultadoNome.nome;
      inputNome.value = resultadoNome.nome;
      atualizarNomeEstabelecimento(resultadoNome.nome);
    }

    await fetchComAuth(`${API_URL}/estabelecimentos/${establishmentId}/dados`, {
      method: "PUT",
      body: JSON.stringify({
        telefone,
        mercadopago_access_token,
        mercadopago_secret_key,
      }),
    });

    showSuccess("Dados atualizados com sucesso!", "");

    // Limpa os campos sensíveis e atualiza os indicadores de "chave configurada"
    const inputMp = document.getElementById("inputMercadoPagoToken");
    const inputMpSecret = document.getElementById("inputMercadoPagoSecretKey");
    if (inputMp) inputMp.value = "";
    if (inputMpSecret) inputMpSecret.value = "";
    carregarDadosEstabelecimento();
  } catch (err) {
    console.error(err);
    showError("Erro ao salvar dados", err.message || "");
  }
}

export async function carregarDadosEstabelecimento() {
  try {
    const estab = await fetchComAuth(`${API_URL}/admin/me/estabelecimento`);
    const inputNome = document.getElementById("inputNomeEstabelecimento");
    const inputTelefone = document.getElementById("inputTelefone");
    const statusMp = document.getElementById("statusMercadoPagoToken");
    const statusMpSecret = document.getElementById(
      "statusMercadoPagoSecretKey",
    );
    const inputWebhookPedidosUrl = document.getElementById(
      "inputWebhookPedidosUrl",
    );

    if (inputWebhookPedidosUrl) {
      inputWebhookPedidosUrl.value = `${API_URL}/pagamentos/webhook`;
    }

    if (inputTelefone && estab) {
      inputTelefone.value = estab.telefone || "";
    }
    if (inputNome && estab?.nome) {
      inputNome.value = estab.nome;
      inputNome.dataset.persistedName = estab.nome;
      atualizarNomeEstabelecimento(estab.nome);
    }

    if (statusMp) {
      statusMp.textContent = estab?.mercadopago_token_configurado
        ? "🔒 Chave configurada"
        : "⚠️ Nenhuma chave configurada";
      statusMp.style.color = estab?.mercadopago_token_configurado
        ? "#28a745"
        : "#dc3545";
    }

    if (statusMpSecret) {
      statusMpSecret.textContent = estab?.mercadopago_secret_key_configurado
        ? "🔒 Chave configurada"
        : "⚠️ Nenhuma chave configurada";
      statusMpSecret.style.color = estab?.mercadopago_secret_key_configurado
        ? "#28a745"
        : "#dc3545";
    }
  } catch (err) {
    console.error("Erro ao buscar dados do estabelecimento:", err);
  }
}
