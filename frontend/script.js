// Carrega os planos e a oferta especial direto do backend (fonte única de verdade,
// controlada exclusivamente pelo superadmin). Se a requisição falhar, o HTML
// estático já presente na página permanece visível como fallback.
(function () {
  const API_URL = `${(window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000").replace(/\/$/, "")}/api`;

  function formatarMoeda(valor) {
    return Number(valor || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function montarLinkWhatsapp(nomePlano, whatsappNumero) {
    if (!whatsappNumero) return "#contato";
    const texto = encodeURIComponent(`Olá! Quero conhecer o ${nomePlano}.`);
    return `https://wa.me/${whatsappNumero}?text=${texto}`;
  }

  // Um recurso pode ser marcado como indisponível prefixando a linha com ❌/✗;
  // o emoji manual é removido do texto pois o marcador vira o próprio ícone da lista.
  function montarRecursoItem(recurso) {
    const texto = String(recurso || "").trim();
    const indisponivel = /^(❌|✗|✕)/.test(texto);
    const textoLimpo = texto.replace(/^(❌|✗|✕|✅|✓)\s*/, "");
    const classe = indisponivel ? ' class="recurso-indisponivel"' : "";
    return `<li${classe}>${textoLimpo}</li>`;
  }

  function montarCardPlano(plano, whatsappNumero) {
    const destaque = plano.destaque ? " featured" : "";
    const badge = plano.destaque
      ? `<div class="pricing-badge">Melhor Custo-Benefício</div>`
      : "";
    const recursos = Array.isArray(plano.recursos)
      ? plano.recursos.map(montarRecursoItem).join("")
      : "";

    return `
      <article class="pricing-card${destaque}">
        ${badge}
        <h3>${plano.nome}</h3>
        <div class="pricing-price">R$ ${formatarMoeda(plano.preco)}<span class="price-period">/mês</span></div>
        <ul class="pricing-list">${recursos}</ul>
        <a
          class="pricing-btn"
          href="${montarLinkWhatsapp(plano.nome, whatsappNumero)}"
          target="_blank"
          rel="noopener noreferrer"
          >Escolher plano</a
        >
      </article>
    `;
  }

  function montarCardOfertaEspecial(oferta, planos, whatsappNumero) {
    if (!oferta || !oferta.ativa) return "";

    const planoBase =
      planos.find((p) => p.id === oferta.planoId) ||
      planos.find((p) => p.id === "full") ||
      planos[0];

    const nomePlanoBase = planoBase ? planoBase.nome : "Plano";
    const precoOriginal =
      Number(oferta.precoOriginal) || (Number(planoBase?.preco) || 0) * 12;
    const precoComDesconto = Number(oferta.precoComDesconto) || precoOriginal;
    const economia =
      oferta.economia !== undefined && oferta.economia !== null
        ? Number(oferta.economia)
        : Math.max(0, precoOriginal - precoComDesconto);

    const percentual = Number(oferta.percentualDesconto) || 0;
    const titulo = oferta.texto || "Oferta Anual";
    const nomeCard = `${titulo} (${nomePlanoBase})`;

    const recursos =
      planoBase && Array.isArray(planoBase.recursos)
        ? planoBase.recursos.map(montarRecursoItem).join("")
        : "";

    return `
      <article class="pricing-card featured offer-card">
        <div class="pricing-badge offer-badge">🔥 Oferta Especial Anual</div>
        <h3>${titulo} (${nomePlanoBase})</h3>
        <div class="pricing-price">R$ ${formatarMoeda(precoComDesconto)}<span class="price-period">/ano</span></div>
        <p class="pricing-annual-details">
          <s>De R$ ${formatarMoeda(precoOriginal)}</s><br>
          <span class="economy-tag">🎉 Economize R$ ${formatarMoeda(economia)}${percentual > 0 ? ` (${percentual}% OFF)` : ""}</span>
        </p>
        <ul class="pricing-list">${recursos}</ul>
        <a
          class="pricing-btn"
          href="${montarLinkWhatsapp(nomeCard, whatsappNumero)}"
          target="_blank"
          rel="noopener noreferrer"
          >Escolher plano</a
        >
      </article>
    `;
  }

  // Sem dados no banco ainda (superadmin não configurou): não some a seção,
  // apenas exibe um aviso até haver planos cadastrados.
  async function carregarPlanos() {
    const secaoPlanos = document.getElementById("planos");
    if (!secaoPlanos) return;

    try {
      const resp = await fetch(`${API_URL}/planos-landing`);
      if (!resp.ok) throw new Error("Falha ao buscar planos");

      const dados = await resp.json();
      if (!Array.isArray(dados.planos) || dados.planos.length === 0) {
        secaoPlanos.innerHTML =
          '<p class="pricing-loading">Nenhum plano cadastrado no momento.</p>';
        return;
      }

      const htmlPlanos = dados.planos
        .map((plano) => montarCardPlano(plano, dados.whatsappNumero))
        .join("");

      const htmlOferta = montarCardOfertaEspecial(
        dados.oferta,
        dados.planos,
        dados.whatsappNumero,
      );

      secaoPlanos.innerHTML = htmlPlanos + htmlOferta;
    } catch (err) {
      console.warn("Não foi possível carregar os planos do servidor.", err);
      secaoPlanos.innerHTML =
        '<p class="pricing-loading">Não foi possível carregar os planos agora.</p>';
    }
  }

  document.addEventListener("DOMContentLoaded", carregarPlanos);
})();

// Interações visuais da landing page (menu mobile, header sticky e
// animações de entrada). Não interfere na lógica de planos/WhatsApp acima.
(function () {
  function initMobileNav() {
    const toggle = document.getElementById("navToggle");
    const links = document.getElementById("navLinks");
    if (!toggle || !links) return;

    toggle.addEventListener("click", () => {
      const aberto = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", aberto ? "true" : "false");
    });

    links.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  function initHeaderScroll() {
    const header = document.getElementById("siteHeader");
    if (!header) return;

    const atualizar = () => {
      header.classList.toggle("is-scrolled", window.scrollY > 12);
    };
    atualizar();
    window.addEventListener("scroll", atualizar, { passive: true });
  }

  function initScrollReveal() {
    const alvos = document.querySelectorAll(".reveal");
    if (!alvos.length) return;

    if (!("IntersectionObserver" in window)) {
      alvos.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entradas) => {
        entradas.forEach((entrada) => {
          if (entrada.isIntersecting) {
            entrada.target.classList.add("is-visible");
            observer.unobserve(entrada.target);
          }
        });
      },
      { threshold: 0.15 },
    );

    alvos.forEach((el) => observer.observe(el));
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMobileNav();
    initHeaderScroll();
    initScrollReveal();
  });
})();
