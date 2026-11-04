import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showError, showSuccess } from "../ui/alerts.js";

let horarios = {};

export async function aplicarHorarios() {
  const abertura = document.getElementById("abertura-global")?.value;
  const fechamento = document.getElementById("fechamento-global")?.value;
  const diasSelecionados = document.querySelectorAll(
    ".dias-semana input:checked",
  );

  if (!abertura || !fechamento) {
    alert("Preencha os horários!");
    return;
  }

  if (diasSelecionados.length === 0) {
    alert("Selecione pelo menos um dia!");
    return;
  }

  horarios = {};
  diasSelecionados.forEach((cb) => {
    horarios[cb.value] = {
      abertura,
      fechamento,
    };
  });

  const id = localStorage.getItem("establishmentId");

  try {
    await fetchComAuth(`${API_URL}/estabelecimentos/${id}/horarios`, {
      method: "PUT",
      body: JSON.stringify({ horarios }),
    });

    if (typeof showSuccess === "function") {
      showSuccess("Horários aplicados e salvos com sucesso!", "", 1500);
    }
  } catch (err) {
    console.error(err);
    alert("Erro ao salvar horários ❌");
  }
}

export function marcarFechado() {
  const diasSelecionados = document.querySelectorAll(
    ".dias-semana input:checked",
  );
  diasSelecionados.forEach((cb) => {
    horarios[cb.value] = null;
  });
  alert("Dias marcados como fechados!");
}

export async function salvarHorarios() {
  const id = localStorage.getItem("establishmentId");
  try {
    await fetchComAuth(`${API_URL}/estabelecimentos/${id}/horarios`, {
      method: "PUT",
      body: JSON.stringify({ horarios }),
    });
    alert("Horários salvos!");
  } catch {
    alert("Erro!");
  }
}

export async function carregarHorarios() {
  const id = localStorage.getItem("establishmentId");
  try {
    const data = await fetchComAuth(
      `${API_URL}/estabelecimentos/${id}/horarios`,
    );

    document.querySelectorAll(".dias-semana input").forEach((cb) => {
      cb.checked = false;
    });

    const aberturaGlobal = document.getElementById("abertura-global");
    const fechamentoGlobal = document.getElementById("fechamento-global");

    if (aberturaGlobal) aberturaGlobal.value = "";
    if (fechamentoGlobal) fechamentoGlobal.value = "";

    if (!data.horarios) return;

    horarios = data.horarios;
    let horarioPadrao = null;

    Object.entries(horarios).forEach(([dia, valor]) => {
      if (valor) {
        const checkbox = document.querySelector(
          `.dias-semana input[value="${dia}"]`,
        );
        if (checkbox) checkbox.checked = true;
        if (!horarioPadrao) {
          horarioPadrao = valor;
        }
      }
    });

    if (horarioPadrao) {
      if (aberturaGlobal) aberturaGlobal.value = horarioPadrao.abertura;
      if (fechamentoGlobal) fechamentoGlobal.value = horarioPadrao.fechamento;
    }
  } catch (err) {
    console.error("Erro ao carregar horários:", err);
  }
}
