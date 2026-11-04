import { API_URL } from "./config.js";
import { fetchComAuth } from "./api.js";
import { initSocket } from "./socket.js";

export function limparAvisosAssinatura() {
  ["proxima", "carencia", "suspensa", "teste", "teste_urgente"].forEach(
    (tipo) => {
      sessionStorage.removeItem(`avisoAssinatura:${tipo}`);
    },
  );
}

export async function verificarLogin({ onReady, onNewOrder }) {
  try {
    window.addEventListener(
      "sessaoEncerrada",
      () => {
        encerrarSessaoLocal(
          "Sua sessão foi encerrada porque houve um novo login.",
        );
      },
      { once: true },
    );

    // GARANTE QUE CHAMA O ENDPOINT CORRETO COM O FETCHCOMAUTH
    await fetchComAuth(`${API_URL}/admin/check-token`);

    const socket = initSocket();
    socket.off("novoPedido");

    if (typeof onNewOrder === "function") {
      socket.on("novoPedido", onNewOrder);
    }

    if (typeof onReady === "function") {
      onReady();
    }

    iniciarMonitoramentoSessao();
  } catch (error) {
    console.error("Sessão expirada:", error);
    limparAvisosAssinatura();
    localStorage.clear();
    window.location.href = "login.html?expirado=true";
  }
}

let monitoramentoSessaoAtivo = false;

export function iniciarMonitoramentoSessao() {
  if (monitoramentoSessaoAtivo) return;
  monitoramentoSessaoAtivo = true;

  setInterval(async () => {
    try {
      await fetchComAuth(`${API_URL}/admin/check-token`);
    } catch (error) {
      console.warn("A sessão atual deixou de ser válida.");
    }
  }, 15000);
}

export function encerrarSessaoLocal(mensagem) {
  limparAvisosAssinatura();
  localStorage.clear();

  if (typeof Swal !== "undefined") {
    Swal.fire({
      icon: "warning",
      title: "Sessão encerrada",
      text: mensagem,
      confirmButtonText: "OK",
    }).then(() => {
      window.location.href = "login.html";
    });
  } else {
    window.location.href = "login.html";
  }
}

export function checkRoleRedirect() {
  const role = localStorage.getItem("role");

  if (!role) {
    window.location.href = "login.html";
    return;
  }

  if (role === "superadmin") {
    window.location.href = "superadmin.html";
  }
}
