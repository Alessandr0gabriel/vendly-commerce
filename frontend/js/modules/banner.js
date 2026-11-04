import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showError, showSuccess } from "../ui/alerts.js";

export async function enviarBanner() {
  const file = document.getElementById("inputBanner")?.files?.[0];
  const id = localStorage.getItem("establishmentId");

  if (!file) {
    return showError(
      "Selecione uma imagem",
      "Escolha um arquivo para o banner.",
    );
  }

  const formData = new FormData();
  formData.append("banner", file);

  // Trava a tela com loading até que o upload no Cloudinary seja finalizado pelo backend
  Swal.fire({
    title: "Enviando banner...",
    text: "Processando e otimizando a imagem na nuvem.",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  try {
    await fetchComAuth(`${API_URL}/estabelecimentos/${id}/banner`, {
      method: "PUT",
      body: formData,
    });

    showSuccess(
      "Banner atualizado!",
      "Seu banner foi enviado com sucesso",
      2000,
    );
    const inputBanner = document.getElementById("inputBanner");
    if (inputBanner) inputBanner.value = "";
  } catch (err) {
    showError("Erro ao atualizar", err.message);
  }
}
