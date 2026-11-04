const PLAN_RANK = {
  barato: 0,
  medio: 1,
  full: 2,
};

export function normalizarPlano(plano) {
  const valor = String(plano || "")
    .trim()
    .toLowerCase();

  if (
    [
      "gratis",
      "gratuito",
      "free",
      "barato",
      "basico",
      "basic",
      "starter",
    ].includes(valor)
  ) {
    return "barato";
  }

  if (
    [
      "medio",
      "médio",
      "medium",
      "pro",
      "intermediario",
      "intermediário",
    ].includes(valor)
  ) {
    return "medio";
  }

  if (
    ["full", "premium", "enterprise", "avancado", "avançado"].includes(valor)
  ) {
    return "full";
  }

  return "barato";
}

export function getPlanLabel(plano) {
  const valor = normalizarPlano(plano);
  const labels = {
    barato: "Barato",
    medio: "Médio",
    full: "Full",
  };

  return labels[valor] || "Barato";
}

export function canAccessPlan(plan, requiredPlan) {
  const planValue = normalizarPlano(plan);
  const requiredValue = normalizarPlano(requiredPlan);
  return (PLAN_RANK[planValue] || 0) >= (PLAN_RANK[requiredValue] || 0);
}

export function getMenuPlan(menu) {
  const menus = {
    Dashboard: "full",
    Pedidos: "barato",
    Produtos: "barato",
    Histórico: "barato",
    "Pedidos Arquivados": "medio",
    Faturamento: "medio",
    Horários: "barato",
    Banner: "barato",
    Link: "barato",
    Ajuda: "barato",
    "Dados da loja": "medio",
  };

  return menus[menu] || null;
}
