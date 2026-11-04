// SEGURANÇA IMEDIATA: Executa no primeiro milissegundo de carregamento de forma autônoma [cite: 642]
(() => {
  const csrfToken = localStorage.getItem("csrfToken");

  if (!csrfToken) {
    console.warn(
      "Nenhum token localizado na sessão. Expulsando para o login...",
    );
    localStorage.clear();
    window.location.href = "login.html";
    return;
  }

  // Se o token existir localmente, remove o bloqueio visual do CSS para exibir o formulário [cite: 642]
  document.body.classList.remove("restrito");
})();

// Constante global de URL base do seu servidor backend [cite: 642]
const API_URL = (window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000");

document.addEventListener("DOMContentLoaded", () => {
  const novaSenhaInput = document.getElementById("novaSenha");
  const confirmarSenhaInput = document.getElementById("confirmarSenha");
  const submitBtn = document.getElementById("submitBtn");

  // Itens de requisitos visuais da interface
  const reqLength = document.getElementById("reqLength");
  const reqUpper = document.getElementById("reqUpper");
  const reqLower = document.getElementById("reqLower");
  const reqNumber = document.getElementById("reqNumber");
  const feedback = document.getElementById("feedback");

  if (!novaSenhaInput || !confirmarSenhaInput) return;

  // Função para validar os requisitos da senha conforme o usuário digita
  function validarRequisitos() {
    const senha = novaSenhaInput.value;

    // 1. Mínimo 8 caracteres
    const temTamanhoCorreto = senha.length >= 8;
    atualizarStatusRequisito(reqLength, temTamanhoCorreto);

    // 2. Uma letra maiúscula
    const temMaiuscula = /[A-Z]/.test(senha);
    atualizarStatusRequisito(reqUpper, temMaiuscula);

    // 3. Uma letra minúscula
    const temMinuscula = /[a-z]/.test(senha);
    atualizarStatusRequisito(reqLower, temMinuscula);

    // 4. Um número
    const temNumero = /[0-9]/.test(senha);
    atualizarStatusRequisito(reqNumber, temNumero);

    // Retorna se a senha atende a todos os critérios de força
    return temTamanhoCorreto && temMaiuscula && temMinuscula && temNumero;
  }

  // Função auxiliar para mudar a cor e a classe visual dos itens da lista
  function atualizarStatusRequisito(elemento, valido) {
    if (!elemento) return;
    if (valido) {
      elemento.classList.add("pass");
      elemento.classList.remove("fail");
      elemento.style.color = "#28a745"; // Verde para sucesso
    } else {
      elemento.classList.add("fail");
      elemento.classList.remove("pass");
      elemento.style.color = "#dc3545"; // Vermelho para pendente
    }
  }

  // Função para checar a igualdade das duas senhas em tempo real
  function checarSenhasIguais() {
    const senha = novaSenhaInput.value;
    const confirmacao = confirmarSenhaInput.value;

    if (!confirmacao) {
      if (feedback) feedback.innerText = "";
      return false;
    }

    if (senha === confirmacao) {
      if (feedback) {
        feedback.innerText = "As senhas coincidem!";
        feedback.style.color = "#28a745";
      }
      return true;
    } else {
      if (feedback) {
        feedback.innerText = "As senhas não coincidem!";
        feedback.style.color = "#dc3545";
      }
      return false;
    }
  }

  // Monitora a digitação no campo de nova senha
  novaSenhaInput.addEventListener("input", () => {
    const senhaValida = validarRequisitos();
    const senhasIguais = checarSenhasIguais();

    // Habilita ou desativa o botão de envio baseado nas validações locais
    if (submitBtn) {
      submitBtn.disabled = !(senhaValida && senhasIguais);
    }
  });

  // Monitora a digitação no campo de confirmação de senha
  confirmarSenhaInput.addEventListener("input", () => {
    const senhaValida = validarRequisitos();
    const senhasIguais = checarSenhasIguais();

    if (submitBtn) {
      submitBtn.disabled = !(senhaValida && senhasIguais);
    }
  });

  // Inicializa o estado visual com os requisitos marcados negativamente por estarem vazios
  validarRequisitos();
});

function trocarSenha() {
  const novaSenha = document.getElementById("novaSenha").value;
  const confirmarSenha = document.getElementById("confirmarSenha").value;
  const feedback = document.getElementById("feedback");

  if (!novaSenha || !confirmarSenha) {
    Swal.fire("Aviso", "Preencha todos os campos de senha!", "warning");
    return;
  }

  if (novaSenha !== confirmarSenha) {
    if (feedback) {
      feedback.innerText = "As senhas não coincidem!";
      feedback.style.color = "#dc3545";
    }
    return;
  }
  // Ativa a barreira de carregamento visual contra cliques múltiplos [cite: 642]
  Swal.fire({
    title: "Atualizando senha...",
    text: "Por favor, aguarde o processamento do servidor.",
    allowOutsideClick: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  const csrfToken = localStorage.getItem("csrfToken");

  fetch(`${API_URL}/api/auth/primeiro-acesso`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ novaSenha: novaSenha }),
  })
    .then(async (res) => {
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.mensagem || "Erro ao atualizar senha.");
      }

      // A troca de senha invalida a sessão antiga: o backend já reautentica e
      // devolve um csrfToken novo, que precisa substituir o antigo salvo aqui.
      if (data.csrfToken) {
        localStorage.setItem("csrfToken", data.csrfToken);
      }

      Swal.fire({
        icon: "success",
        title: "Senha Alterada!",
        text: "Sua nova senha foi gravada com sucesso. Você será redirecionado para o painel.",
        confirmButtonText: "Acessar Sistema",
      }).then(() => {
        const role = localStorage.getItem("role");
        if (role === "superadmin") {
          window.location.href = "superadmin.html";
        } else {
          window.location.href = "admin.html";
        }
      });
    })
    .catch((err) => {
      console.error("Erro na requisição de alteração de senha:", err);
      Swal.fire(
        "Erro",
        err.message || "Falha interna na comunicação com o servidor.",
        "error",
      );

      if (feedback) {
        feedback.innerText = err.message || "Erro no servidor.";
        feedback.style.color = "#dc3545";
      }
    });
}

window.trocarSenha = trocarSenha;
