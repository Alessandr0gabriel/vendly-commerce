import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showToast } from "../ui/alerts.js";

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
      urlLojaInput.value = `${window.location.origin}/html/index.html?estab=${data.slug}`;
    } else if (urlLojaInput) {
      urlLojaInput.value = "";
    }
  } catch (err) {
    console.error("Erro ao carregar URL da loja do Firestore:", err);
    if (urlLojaInput) {
      urlLojaInput.value = "";
    }
  }
}

export async function copiarURL() {
  const input = document.getElementById("urlLoja");

  if (!input || !input.value.trim()) {
    showToast("error", "Link da loja não disponível para cópia.");
    return;
  }

  try {
    input.select();
    input.setSelectionRange(0, 99999);

    await navigator.clipboard.writeText(input.value.trim());
    showToast("success", "Link copiado com sucesso!");
  } catch (err) {
    console.error("Erro ao copiar link via Clipboard API:", err);
    showToast("error", "Não foi possível copiar o link automaticamente.");
  }
}

window.copiarURL = copiarURL;
