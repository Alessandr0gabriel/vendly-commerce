// Mesma lógica de validação/fallback das miniaturas do Dashboard (dashboardFull.js).
const ORIGEM_IMAGEM_PRODUTO = "https://res.cloudinary.com";

function urlImagemProdutoSegura(valor) {
  if (typeof valor !== "string" || !valor.trim()) return null;

  try {
    const url = new URL(valor);
    return url.protocol === "https:" && url.origin === ORIGEM_IMAGEM_PRODUTO
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function criarPlaceholderImagem() {
  const placeholder = document.createElement("span");
  placeholder.className = "produto-thumb-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = "•";
  return placeholder;
}

export function criarImagemProduto(url) {
  const urlSegura = urlImagemProdutoSegura(url);
  if (!urlSegura) return criarPlaceholderImagem();

  const imagem = document.createElement("img");
  imagem.className = "produto-thumb";
  imagem.alt = "";
  imagem.loading = "lazy";
  imagem.decoding = "async";

  imagem.addEventListener(
    "error",
    () => imagem.replaceWith(criarPlaceholderImagem()),
    { once: true },
  );
  imagem.src = urlSegura;
  return imagem;
}
