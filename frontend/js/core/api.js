import { getCookie } from "./utils.js";
import { mostrarLoading, esconderLoading } from "../ui/loading.js";
import { disconnectSocket } from "./socket.js";

export function fetchComAuth(url, options = {}) {
  const isFormData = options.body instanceof FormData;

  const headers = {
    ...options.headers,
  };

  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  let csrfToken = localStorage.getItem("csrfToken");

  if (!csrfToken) {
    csrfToken = getCookie("csrf-token");
  }

  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: "include",
  }).then(async (res) => {
    if (res.status === 401) {
      console.warn("Sessão inválida detectada. Limpando credenciais locais...");

      localStorage.removeItem("role");
      localStorage.removeItem("csrfToken");
      localStorage.removeItem("establishmentId");
      localStorage.removeItem("establishmentName");

      if (typeof Swal !== "undefined") {
        Swal.fire({
          icon: "warning",
          title: "Sessão expirada",
          text: "Sua validação de segurança expirou. Por favor, faça login novamente.",
          confirmButtonText: "OK",
        }).then(() => {
          window.location.href = "login.html";
        });
      } else {
        alert("Sessão expirada. Faça login novamente.");
        window.location.href = "login.html";
      }

      return Promise.reject(new Error("Sessão inválida"));
    }

    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (res.status === 403) {
      if (data.code === "FORCAR_TROCA_SENHA") {
        localStorage.setItem("primeiroLogin", "true");

        window.location.replace("trocar-senha.html");

        throw new Error("Troca de senha obrigatória");
      }

      if (data.code === "ASSINATURA_SUSPENSA") {
        const erro = new Error(
          data.mensagem || "Sua assinatura está suspensa.",
        );
        erro.code = data.code;
        window.dispatchEvent(new CustomEvent("assinaturaSuspensa"));
        throw erro;
      }

      throw new Error(data.mensagem || "Acesso negado");
    }

    if (!res.ok) {
      throw new Error(data.mensagem || "Erro na requisição");
    }

    return data;
  });
}
