document.addEventListener("DOMContentLoaded", () => {
  // Verifica se a URL contém ?expirado=true
  const urlParams = new URLSearchParams(window.location.search);

  if (urlParams.get("expirado") === "true") {
    // Exibe a mensagem/alerta para o usuário (usando SweetAlert2 ou seu sistema de Toast)
    if (typeof Swal !== "undefined") {
      Swal.fire({
        icon: "warning",
        title: "Sessão Expirada",
        text: "Sua sessão expirou por tempo de inatividade. Por favor, faça login novamente.",
        confirmButtonColor: "#3085d6",
        confirmButtonText: "Entender",
      });
    } else {
      alert("Sua sessão expirou. Faça login novamente.");
    }

    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

const loginApiUrl = `${(window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000").replace(/\/$/, "")}/api`;

function login() {
  const email = document.getElementById("email")?.value;
  const senha = document.getElementById("senha")?.value;
  const erroEl = document.getElementById("erro");
  const btnEntrar = document.getElementById("btnEntrar");

  if (!email || !senha) {
    if (erroEl) erroEl.innerText = "Preencha todos os campos!";
    return;
  }

  if (erroEl) erroEl.innerText = "";

  if (btnEntrar) {
    btnEntrar.disabled = true;
    btnEntrar.innerText = "Carregando...";
  }

  if (typeof Swal !== "undefined") {
    Swal.fire({
      title: "Autenticando...",
      text: "Por favor, aguarde enquanto validamos suas credenciais.",
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });
  }

  fetch(`${loginApiUrl}/admin/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, senha }),
  })
    .then(async (res) => {
      let data = {};

      try {
        data = await res.json();
      } catch {
        data = { mensagem: "Erro inesperado no servidor" };
      }

      if (!res.ok) {
        throw new Error(data.mensagem || "Erro no login");
      }

      return data;
    })
    .then((data) => {
      if (data.mensagem === "Login sucesso") {
        ["proxima", "carencia", "suspensa", "teste", "teste_urgente"].forEach(
          (tipo) => {
            sessionStorage.removeItem(`avisoAssinatura:${tipo}`);
          },
        );

        if (data.csrfToken) {
          localStorage.setItem("csrfToken", data.csrfToken);
        }

        localStorage.setItem("role", data.role);
        localStorage.setItem(
          "establishmentId",
          data.establishmentId ? String(data.establishmentId) : "",
        );
        localStorage.setItem("establishmentName", data.establishmentName || "");
        localStorage.setItem("plan", data.plan || "barato");

        if (typeof Swal !== "undefined") Swal.close();

        if (data.primeiroLogin) {
          window.location.href = "trocar-senha.html";
        } else {
          window.location.href =
            data.role === "superadmin" ? "superadmin.html" : "admin.html";
        }
      }
    })
    .catch((err) => {
      if (btnEntrar) {
        btnEntrar.disabled = false;
        btnEntrar.innerText = "Entrar";
      }

      if (erroEl) erroEl.innerText = "";

      if (typeof Swal !== "undefined") {
        Swal.fire({
          icon: "error",
          title: "Falha no Login",
          text: err.message || "E-mail ou senha incorretos.",
          confirmButtonText: "Tentar novamente",
        });
      } else if (erroEl) {
        erroEl.innerText = err.message || "Erro ao fazer login";
      }
    });
}

const inputs = document.querySelectorAll("#email, #senha");

inputs.forEach((input, index) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();

      const proximo = inputs[index + 1];

      if (proximo) {
        proximo.focus();
      } else {
        login();
      }
    }
  });
});

function getCookie(name) {
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(name + "="))
    ?.split("=")[1];
}

function toggleSenha() {
  const input = document.getElementById("senha");
  const icon = document.querySelector(".toggle-password");

  if (!input || !icon) return;

  if (input.type === "password") {
    input.type = "text";
    icon.innerHTML = '<i data-feather="eye-off"></i>';
  } else {
    input.type = "password";
    icon.innerHTML = '<i data-feather="eye"></i>';
  }

  if (typeof feather !== "undefined") {
    feather.replace();
  }
}

window.onload = () => {
  if (typeof feather !== "undefined") {
    feather.replace();
  }
};

// GARANTE A EXPOSIÇÃO GLOBAL COMPLETA PARA EVENTOS INLINE ONCLICK DO HTML
window.login = login;
window.toggleSenha = toggleSenha;
window.getCookie = getCookie;
