export function setFaturamentoTab(tab) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tab}`);
  });
}

export function definirDatasPadrao() {
  const hoje = new Date();
  const dataFim = document.getElementById("dataFim");
  const dataInicio = document.getElementById("dataInicio");

  if (dataFim) {
    dataFim.value = hoje.toISOString().slice(0, 10);
  }

  if (dataInicio) {
    const semanaPassada = new Date(hoje);
    semanaPassada.setDate(hoje.getDate() - 7);
    dataInicio.value = semanaPassada.toISOString().slice(0, 10);
  }
}
