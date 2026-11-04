const API_URL = `${(window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000").replace(/\/$/, "")}/api`;

let horariosEstabelecimento = null;
let establishmentId = null;
let pedidoEnviado = false;
let carregou = false;
let produtosGlobais = [];
let intervaloStatusPedido = null;
let pedidosDisponiveis = true;

function atualizarDisponibilidadePedidos(disponivel) {
  pedidosDisponiveis = disponivel !== false;
  const aviso = document.getElementById("pedidos-indisponiveis");
  if (aviso) aviso.hidden = pedidosDisponiveis;

  if (pedidosDisponiveis) {
    atualizarEstoqueVisual();
  } else {
    document.querySelectorAll(".btn-adicionar").forEach((btn) => {
      btn.disabled = true;
      btn.textContent = "Pedidos indisponíveis";
      btn.style.opacity = "0.6";
      btn.style.cursor = "not-allowed";
    });
  }
  atualizarBotaoFinalizar();
}

// Pix só fica disponível para lojas em planos que suportam Mercado Pago (medio/full)
function normalizarPlanoLoja(plano) {
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

  return valor || "barato";
}

function atualizarDisponibilidadePix(plano) {
  const btnPix = document.getElementById("btnPagamentoPix");
  if (!btnPix) return;

  const disponivel = normalizarPlanoLoja(plano) !== "barato";
  btnPix.style.display = disponivel ? "" : "none";
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function mostrarTituloEstabelecimento(establishmentId) {
  if (!establishmentId) return;

  fetch(`${API_URL}/estabelecimentos/${establishmentId}`)
    .then((res) => {
      if (!res.ok) throw new Error("Estabelecimento não encontrado");
      return res.json();
    })
    .then((estabelecimento) => {
      const titleEl = document.getElementById("establishment-title");
      if (titleEl) {
        titleEl.textContent = estabelecimento.nome;
      }
    })
    .catch(() => {
      const titleEl = document.getElementById("establishment-title");
      if (titleEl) {
        titleEl.textContent = "Cardápio";
      }
    });
}

function normalizarCategoriaCardapio(categoria) {
  const nome = String(categoria || "Outros").trim();
  const chave = removerAcentos(nome.toLowerCase());

  const categoriasCanonicas = {
    bebida: "Bebidas",
    bebidas: "Bebidas",
    lanche: "Lanches",
    lanches: "Lanches",
    porcao: "Porções",
    porcoes: "Porções",
    sobremesa: "Sobremesas",
    sobremesas: "Sobremesas",
  };

  return categoriasCanonicas[chave] || nome;
}

function mostrarToast(mensagem, tipo = "sucesso") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  const title = toast.querySelector(".toast-title");
  const message = toast.querySelector(".toast-message");
  const icon = toast.querySelector(".toast-icon i");
  const progress = toast.querySelector(".toast-progress");

  toast.classList.remove("erro");

  title.textContent = tipo === "erro" ? "Erro" : "Sucesso";
  message.textContent = mensagem;

  if (tipo === "erro") {
    toast.classList.add("erro");
    icon.className = "fas fa-times";
  } else {
    icon.className = "fas fa-check";
  }

  progress.style.animation = "none";
  progress.offsetHeight;
  progress.style.animation = null;

  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

function mostrarToastSucesso(msg) {
  mostrarToast(msg, "sucesso");
}

function copiarIdPedido(pedidoId) {
  navigator.clipboard
    .writeText(pedidoId)
    .then(() => mostrarToast("ID do pedido copiado!"))
    .catch(() => mostrarToast("Não foi possível copiar o ID.", "erro"));
}

function exibirPedidoCriado(pedidoId) {
  const id = String(pedidoId || "");
  Swal.fire({
    icon: "success",
    title: "Pedido realizado!",
    html: `<p>Guarde este ID para acompanhar seu pedido:</p><strong class="pedido-id-destaque">${id}</strong><br><button type="button" class="swal2-confirm swal2-styled" onclick="copiarIdPedido('${id}')"><i class="fas fa-copy"></i> Copiar ID</button>`,
    confirmButtonText: "Acompanhar pedido",
    confirmButtonColor: "#28a745",
    showCancelButton: true,
    cancelButtonText: "Fechar",
  }).then((result) => {
    if (result.isConfirmed) abrirAcompanhamentoPedido(id);
  });
}

function abrirAcompanhamentoPedido(pedidoId = "") {
  const modal = document.getElementById("modalAcompanhamento");
  const input = document.getElementById("inputPedidoId");
  if (!modal || !input) return;
  input.value = pedidoId;
  modal.style.display = "flex";
  if (pedidoId) consultarStatusPedido();
}

function fecharAcompanhamentoPedido() {
  const modal = document.getElementById("modalAcompanhamento");
  if (modal) modal.style.display = "none";
  if (intervaloStatusPedido) {
    clearInterval(intervaloStatusPedido);
    intervaloStatusPedido = null;
  }
}

function consultarStatusPedido() {
  const input = document.getElementById("inputPedidoId");
  const resultado = document.getElementById("resultadoAcompanhamento");
  const pedidoId = input?.value.trim();
  if (!pedidoId || !resultado) {
    if (resultado) resultado.textContent = "Informe o ID do pedido.";
    return;
  }

  resultado.textContent = "Consultando status...";
  fetch(`${API_URL}/pedidos/${encodeURIComponent(pedidoId)}/status`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.mensagem || "Pedido não encontrado");
      return data;
    })
    .then((data) => {
      const labels = {
        preparando: "Preparando",
        a_caminho: "A caminho",
        finalizado: "Finalizado",
      };
      // Monte os dados recebidos como nós de texto, não como HTML executável.
      const titulo = document.createElement("strong");
      titulo.textContent = `Pedido #${data.pedido_id}`;
      const status = document.createElement("div");
      const statusPermitidos = ["preparando", "a_caminho", "finalizado"];
      status.className = `tracking-status ${statusPermitidos.includes(data.status) ? data.status : ""}`;
      status.textContent = labels[data.status] || "Aguardando atualização";
      const copiar = document.createElement("button");
      copiar.type = "button";
      copiar.className = "secondary-btn";
      copiar.textContent = "Copiar ID";
      copiar.addEventListener("click", () => copiarIdPedido(data.pedido_id));
      resultado.replaceChildren(titulo, status, copiar);

      if (intervaloStatusPedido) clearInterval(intervaloStatusPedido);
      if (data.status !== "finalizado") {
        intervaloStatusPedido = setInterval(consultarStatusPedido, 15000);
      }
    })
    .catch((err) => {
      const erro = document.createElement("span");
      erro.className = "tracking-error";
      erro.textContent = err.message;
      resultado.replaceChildren(erro);
    });
}

async function carregarProdutos() {
  if (carregou) return;
  carregou = true;

  const container = document.getElementById("lista-produtos");
  const establishmentSlug = getQueryParam("estab");

  if (!establishmentSlug) {
    alert("Estabelecimento não informado ❌");
    return;
  }

  container.innerHTML =
    "<p style='text-align:center'>Carregando produtos...</p>";

  try {
    const resEstab = await fetch(
      `${API_URL}/estabelecimentos?slug=${encodeURIComponent(establishmentSlug)}`,
    );

    if (!resEstab.ok) throw new Error("Estabelecimento não encontrado");

    const estabelecimento = await resEstab.json();
    horariosEstabelecimento = estabelecimento.horarios;
    atualizarDisponibilidadePedidos(estabelecimento.pedidos_disponiveis);

    atualizarDisponibilidadePix(estabelecimento.plano);

    verificarStatusLoja();
    setInterval(verificarStatusLoja, 60000);

    const bannerEl = document.getElementById("banner-estabelecimento");

    const DEFAULT_BANNER =
      "https://res.cloudinary.com/doxnf3mtt/image/upload/v1782692828/logotipovendly-commerce_n0nipi.png";

    if (bannerEl) {
      const banner = estabelecimento.banner;

      if (
        !banner ||
        banner === "null" ||
        banner === "undefined" ||
        banner.trim() === ""
      ) {
        bannerEl.src = DEFAULT_BANNER;
      } else {
        bannerEl.src = banner.startsWith("http")
          ? banner
          : `${API_URL}/uploads/${banner}`;
      }

      bannerEl.onerror = () => {
        bannerEl.src = DEFAULT_BANNER;
      };
    }
    const logoEl = document.getElementById("logo-estabelecimento");
    const logoCopy = document.querySelector(".marquee-copy");

    if (logoEl) logoEl.textContent = estabelecimento.nome;
    if (logoCopy) logoCopy.textContent = estabelecimento.nome;

    const titleEl = document.getElementById("establishment-title");
    if (titleEl) titleEl.textContent = estabelecimento.nome;

    atualizarFooterComEstabelecimento(estabelecimento);

    const url = `${API_URL}/produtos?slug=${encodeURIComponent(establishmentSlug)}`;
    const res = await fetch(url);

    if (!res.ok) throw new Error("Erro ao buscar produtos");

    const produtos = await res.json();
    produtosGlobais = produtos;

    const produtosPorCategoria = {};

    produtos.forEach((produto) => {
      const categoria = normalizarCategoriaCardapio(produto.categoria);
      if (!produtosPorCategoria[categoria]) {
        produtosPorCategoria[categoria] = [];
      }
      produtosPorCategoria[categoria].push(produto);
    });

    container.innerHTML = "";

    const grid = document.createElement("div");
    grid.classList.add("card-grid");

    Object.keys(produtosPorCategoria).forEach((categoria) => {
      const categoriaBox = document.createElement("div");
      categoriaBox.classList.add("categoria-box");

      const header = document.createElement("div");
      header.classList.add("categoria-header");

      const icon = document.createElement("span");
      icon.classList.add("categoria-icon");
      icon.textContent = getIcon(categoria);

      const titulo = document.createElement("h2");
      titulo.textContent = categoria;

      header.appendChild(icon);
      header.appendChild(titulo);

      const linha = document.createElement("div");
      linha.classList.add("categoria-linha");

      const gridCategoria = document.createElement("div");
      gridCategoria.classList.add("card-grid");

      categoriaBox.appendChild(header);
      categoriaBox.appendChild(linha);
      categoriaBox.appendChild(gridCategoria);

      container.appendChild(categoriaBox);

      produtosPorCategoria[categoria].forEach((produto) => {
        const card = document.createElement("div");
        card.classList.add("card");
        card.dataset.categoria = categoria;

        const semEstoque = produto.esgotado === true;
        const img = document.createElement("img");
        img.src = produto.imagem;
        img.classList.add("card-img");

        const content = document.createElement("div");
        content.classList.add("card-content");

        const tituloProduto = document.createElement("h3");
        tituloProduto.textContent = produto.nome;
        tituloProduto.classList.add("card-title");

        const desc = document.createElement("p");
        desc.textContent = produto.descricao;
        desc.classList.add("card-desc");

        const preco = document.createElement("span");
        preco.textContent = `R$ ${Number(produto.preco).toFixed(2)}`;
        preco.classList.add("card-preco");

        const estoque = document.createElement("small");
        estoque.classList.add("estoque-texto");
        estoque.dataset.id = produto.id;

        const estoqueDisponivel = calcularEstoqueRestanteNoCarrinho(produto);

        if (
          produto.controla_estoque === true ||
          Number(produto.controla_estoque) === 1
        ) {
          estoque.textContent = semEstoque
            ? "Esgotado"
            : `Estoque: ${estoqueDisponivel}`;
        }

        const btn = document.createElement("button");
        btn.classList.add("btn-adicionar");

        if (!pedidosDisponiveis) {
          btn.textContent = "Pedidos indisponíveis";
          btn.disabled = true;
          btn.style.opacity = "0.6";
          btn.style.cursor = "not-allowed";
        } else if (
          semEstoque ||
          (produto.controla_estoque === true && estoqueDisponivel <= 0)
        ) {
          btn.textContent = "Esgotado";
          btn.disabled = true;
          btn.style.opacity = "0.6";
          btn.style.cursor = "not-allowed";
        } else {
          btn.textContent = "Adicionar";
          btn.onclick = () => adicionarItem(produto);
        }

        content.appendChild(tituloProduto);
        content.appendChild(desc);
        content.appendChild(preco);
        content.appendChild(estoque);
        content.appendChild(btn);

        card.appendChild(img);
        card.appendChild(content);
        gridCategoria.appendChild(card);
      });
    });
  } catch (erro) {
    console.error(erro);
    container.innerHTML = `
      <p style="text-align:center; color:red;">
        Estabelecimento não encontrado 😢
      </p>
    `;
  }
}

function atualizarEstoqueVisual() {
  document.querySelectorAll(".estoque-texto").forEach((el) => {
    const produtoId = el.dataset.id;
    const produto = produtosGlobais.find((p) => p.id === produtoId);
    if (!produto) return;

    const btn = el.parentElement.querySelector(".btn-adicionar");

    if (!pedidosDisponiveis) {
      if (btn) {
        btn.textContent = "Pedidos indisponíveis";
        btn.disabled = true;
        btn.style.opacity = "0.6";
        btn.style.cursor = "not-allowed";
      }
      return;
    }

    if (
      produto.controla_estoque !== true &&
      Number(produto.controla_estoque) !== 1
    ) {
      el.textContent = "";
      if (btn) {
        btn.textContent = "Adicionar";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      }
      return;
    }

    const estoqueAtual = calcularEstoqueRestanteNoCarrinho(produto);

    if (estoqueAtual <= 0 || produto.esgotado === true) {
      el.textContent = "Esgotado";
      if (btn) {
        btn.textContent = "Esgotado";
        btn.disabled = true;
        btn.style.opacity = "0.6";
        btn.style.cursor = "not-allowed";
      }
    } else {
      el.textContent = `Estoque: ${estoqueAtual}`;
      if (btn) {
        btn.textContent = "Adicionar";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      }
    }
  });
}

function getIcon(categoria) {
  switch (categoria.toLowerCase()) {
    case "bebida":
    case "bebidas":
      return "🍹";
    case "lanche":
    case "lanches":
      return "🍔";
    case "porções":
      return "🍟";
    case "sobremesa":
      return "🍰";
    default:
      return "🍽️";
  }
}

function focarCategoria(categoria) {
  document.querySelectorAll(".menu-tab").forEach((tab) => {
    if (tab.textContent.trim() === categoria) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });

  if (categoria === "Ajuda") {
    const contatos = document.getElementById("contatos");
    if (contatos) {
      contatos.scrollIntoView({ behavior: "smooth" });
    }
    document.querySelectorAll(".card").forEach((card) => {
      card.style.display = "";
    });
    return;
  }

  document.querySelectorAll(".card").forEach((card) => {
    const categoriaCard = card.dataset.categoria || "Todos";
    card.style.display =
      categoria === "Todos" || categoriaCard === categoria ? "" : "none";
  });

  const tabs = document.getElementById("menuTabs");
  const toggle = document.getElementById("categoryToggle");
  if (window.innerWidth <= 650 && tabs && toggle) {
    tabs.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }
}

function fecharMenuCategorias() {
  const menu = document.getElementById("menuTabs");
  const toggle = document.getElementById("categoryToggle");
  if (!menu || !toggle) return;
  menu.classList.remove("open");
  toggle.setAttribute("aria-expanded", "false");
}

function toggleCategoryMenu() {
  const menu = document.getElementById("menuTabs");
  const toggle = document.getElementById("categoryToggle");
  if (!menu || !toggle) return;

  const open = menu.classList.toggle("open");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleMenu() {
  const nav = document.getElementById("navLinks");
  if (nav) nav.classList.toggle("active");
}

// Controle de status e Horários
let modoTeste = false;
let lojaAberta = true;

function verificarStatusLoja() {
  const statusEl = document.getElementById("status-loja");
  if (!statusEl || !horariosEstabelecimento) return; // ✅ Corrigido de horariosEstablishment para horariosEstabelecimento

  const agora = new Date();
  const dias = [
    "domingo",
    "segunda",
    "terca",
    "quarta",
    "quinta",
    "sexta",
    "sabado",
  ];
  const diaAtual = dias[agora.getDay()];
  const horaAtual = agora.getHours();
  const minutoAtual = agora.getMinutes();

  const horarioHoje = horariosEstabelecimento[diaAtual];

  if (!horarioHoje) {
    lojaAberta = false;
    statusEl.textContent = " Fechado hoje";
    statusEl.classList.add("fechada");
    return;
  }

  const [hA, mA] = horarioHoje.abertura.split(":");
  const [hF, mF] = horarioHoje.fechamento.split(":");

  const abertura = Number(hA) * 60 + Number(mA);
  const fechamento = Number(hF) * 60 + Number(mF);
  const agoraMin = horaAtual * 60 + minutoAtual;

  lojaAberta = agoraMin >= abertura && agoraMin < fechamento;

  if (modoTeste) {
    statusEl.textContent = " Loja Aberta (modo teste)";
    statusEl.classList.remove("fechada");
    lojaAberta = true;
    return;
  }

  if (lojaAberta) {
    statusEl.textContent = "Loja Aberta";
    statusEl.classList.remove("fechada");
  } else {
    statusEl.textContent = "Loja Fechada";
    statusEl.classList.add("fechada");
  }
}

let pedido = [];

function atualizarResumoCarrinho() {
  const emptyState = document.getElementById("cartSidebarEmpty");
  const itemsContainer = document.getElementById("cartSidebarItems");
  const totalElement = document.getElementById("cartSidebarTotal");
  if (!emptyState || !itemsContainer || !totalElement) return;

  itemsContainer.replaceChildren();

  const temPedido = pedido.length > 0;
  emptyState.hidden = temPedido;
  itemsContainer.hidden = !temPedido;
  totalElement.hidden = !temPedido;

  if (!temPedido) return;

  pedido.forEach((item) => {
    const itemElement = document.createElement("div");
    itemElement.className = "cart-sidebar-item";

    const nameElement = document.createElement("span");
    nameElement.textContent = `${item.quantidade}x ${item.nome || "Produto"}`;

    const priceElement = document.createElement("strong");
    priceElement.textContent = `R$ ${(item.preco * item.quantidade)
      .toFixed(2)
      .replace(".", ",")}`;

    itemElement.append(nameElement, priceElement);
    itemsContainer.appendChild(itemElement);
  });

  totalElement.textContent = `Total estimado: R$ ${calcularTotalPedido()
    .toFixed(2)
    .replace(".", ",")}`;
}

function atualizarBotaoFinalizar() {
  const btnFinalizar = document.getElementById("btn-finalizar");
  const btnVerPedido = document.getElementById("btn-ver-pedido");
  const botoesCarrinho = document.querySelectorAll(".btn-ver-pedido");
  const contadorCarrinho = document.getElementById("contador-carrinho");

  const temPedido = pedido.length > 0;
  const quantidadeTotal = pedido.reduce(
    (total, item) => total + item.quantidade,
    0,
  );

  if (btnFinalizar) {
    btnFinalizar.style.display = temPedido ? "block" : "none";
    btnFinalizar.disabled = !pedidosDisponiveis;
  }
  if (btnVerPedido)
    btnVerPedido.style.display = temPedido ? "inline-flex" : "none";

  botoesCarrinho.forEach((btn) => {
    btn.style.display = temPedido ? "block" : "none";
  });

  if (contadorCarrinho) {
    contadorCarrinho.textContent = quantidadeTotal;
    contadorCarrinho.style.display = temPedido ? "inline-block" : "none";
  }

  atualizarResumoCarrinho();

  const categoryToggle = document.getElementById("categoryToggle");
  if (categoryToggle) {
    categoryToggle.style.display =
      temPedido && window.innerWidth <= 650 ? "none" : "";
  }
}

function adicionarItem(produto) {
  if (!pedidosDisponiveis) {
    mostrarToast(
      "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
      "erro",
    );
    return;
  }
  if (!lojaAberta) {
    Swal.fire({
      icon: "info",
      title: "Loja Fechada 🕒",
      text: "Estamos fechados no momento.",
      confirmButtonText: "Ok",
      confirmButtonColor: "#d33",
    });
    return;
  }

  const itemExistente = pedido.find((p) => p.id === produto.id);
  const controlaEstoque =
    produto.controla_estoque === true || Number(produto.controla_estoque) === 1;

  if (
    controlaEstoque &&
    (itemExistente?.quantidade || 0) >= (Number(produto.estoque) || 0)
  ) {
    mostrarToast("Estoque insuficiente para adicionar mais unidades.", "erro");
    return;
  }

  if (itemExistente) {
    itemExistente.quantidade++;
  } else {
    pedido.push({
      id: produto.id,
      nome: produto.nome,
      preco: Number(produto.preco),
      quantidade: 1,
    });
  }

  mostrarToast(`${produto.nome} adicionado ao pedido!`);
  atualizarEstoqueVisual();
  fecharMenuCategorias();
  atualizarBotaoFinalizar();
  atualizarTotalPagamento();
}

function finalizarPedido() {
  if (!pedidosDisponiveis) {
    mostrarToast(
      "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
      "erro",
    );
    return;
  }
  if (pedido.length === 0) {
    mostrarToast("Nenhum item no pedido!", "erro");
    return;
  }
  document.getElementById("modalPagamento").style.display = "flex";
}

let formaPagamento = "";

function selecionarPagamento(tipo) {
  if (!pedidosDisponiveis) {
    mostrarToast(
      "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
      "erro",
    );
    return;
  }
  formaPagamento = tipo;
  document.getElementById("modalPagamento").style.display = "none";
  document.getElementById("modalConfirmacao").style.display = "flex";
  esconderBusca();

  const divTroco = document.getElementById("divTroco");
  if (divTroco) {
    const isDinheiro = tipo === "Dinheiro";
    divTroco.style.display = isDinheiro ? "block" : "none";
    if (!isDinheiro) {
      document.getElementById("selectPrecisaTroco").value = "nao";
      const wrap = divTroco.querySelector(".troco-input-wrap");
      if (wrap) wrap.style.display = "none";
      document.getElementById("inputTrocoPara").value = "";
    }
  }

  const divEmailCliente = document.getElementById("divEmailCliente");
  if (divEmailCliente) {
    const isPix = tipo && String(tipo).toLowerCase() === "pix";
    divEmailCliente.style.display = isPix ? "block" : "none";
    if (!isPix) {
      const inputEmail = document.getElementById("inputEmailCliente");
      if (inputEmail) inputEmail.value = "";
    }
  }

  const btnPedido = document.getElementById("btn-ver-pedido");
  if (btnPedido) btnPedido.style.display = "none";
}

function alternarInputTroco() {
  const precisaTroco =
    document.getElementById("selectPrecisaTroco")?.value === "sim";
  const inputTroco = document.getElementById("inputTrocoPara");
  const wrap = document.querySelector("#divTroco .troco-input-wrap");
  if (!inputTroco || !wrap) return;
  wrap.style.display = precisaTroco ? "flex" : "none";
  if (!precisaTroco) inputTroco.value = "";
}

window.copiarCodigoPix = function (codigo) {
  if (!codigo) {
    mostrarToast("Código Pix inválido!", "erro");
    return;
  }

  navigator.clipboard
    .writeText(codigo)
    .then(() => {
      mostrarToast("Código Pix copiado com sucesso!", "sucesso");
    })
    .catch((err) => {
      console.error("Erro ao copiar Pix:", err);
      // Fallback caso o navegador bloqueie a Clipboard API
      const inputTemp = document.createElement("input");
      inputTemp.value = codigo;
      document.body.appendChild(inputTemp);
      inputTemp.select();
      document.execCommand("copy");
      document.body.removeChild(inputTemp);
      mostrarToast("Código Pix copiado!", "sucesso");
    });
};

function enviarPedido(tipoEntrega) {
  if (!pedidosDisponiveis) {
    mostrarToast(
      "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
      "erro",
    );
    pedidoEnviado = false;
    return;
  }
  if (pedidoEnviado) return;
  pedidoEnviado = true;

  const nomeCliente = document.getElementById("inputNomeCliente")?.value.trim();
  const emailCliente = document
    .getElementById("inputEmailCliente")
    ?.value.trim();
  const mesa = document.getElementById("inputMesa")?.value.trim();
  const endereco = document.getElementById("inputEndereco")?.value.trim();
  const establishmentSlug = getQueryParam("estab");

  // DECLARAÇÃO DA VARIÁVEL ISPIX
  const isPix =
    formaPagamento && String(formaPagamento).toLowerCase() === "pix";

  if (!nomeCliente) {
    mostrarToast("Digite o nome do cliente.", "erro");
    pedidoEnviado = false;
    return;
  }

  if (!formaPagamento) {
    mostrarToast("Selecione a forma de pagamento.", "erro");
    pedidoEnviado = false;
    return;
  }

  if (tipoEntrega === "Mesa" && !mesa) {
    mostrarToast("Informe o número da mesa.", "erro");
    pedidoEnviado = false;
    return;
  }

  if (tipoEntrega === "Entrega" && !endereco) {
    mostrarToast("Informe o endereço de entrega.", "erro");
    pedidoEnviado = false;
    return;
  }

  const isDinheiro =
    formaPagamento && String(formaPagamento).toLowerCase() === "dinheiro";
  const precisaTroco =
    isDinheiro &&
    document.getElementById("selectPrecisaTroco")?.value === "sim";
  const trocoParaStr = document.getElementById("inputTrocoPara")?.value.trim();
  const trocoPara = trocoParaStr ? Number(trocoParaStr) : null;

  if (precisaTroco && (!trocoPara || trocoPara <= 0)) {
    mostrarToast("Informe o valor para troco.", "erro");
    pedidoEnviado = false;
    return;
  }

  if (precisaTroco && trocoPara < calcularTotalPedido()) {
    mostrarToast(
      "O valor para troco deve ser maior ou igual ao total do pedido.",
      "erro",
    );
    pedidoEnviado = false;
    return;
  }

  const endpoint = isPix
    ? `${API_URL}/pedidos/salvar-com-pix`
    : `${API_URL}/pedidos/salvar`;

  const modalConfirmacao = document.getElementById("modalConfirmacao");
  const modalPedido = document.getElementById("modalPedido");

  if (modalConfirmacao) modalConfirmacao.style.display = "none";
  if (modalPedido) modalPedido.style.display = "none";

  // Exibe a modal de carregamento (Loading)
  Swal.fire({
    title: isPix ? "Gerando Pix..." : "Enviando Pedido...",
    html: isPix
      ? "Aguarde enquanto geramos o seu QR Code com Mercado Pago."
      : "Aguarde um momento...",
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: establishmentSlug,
      itens: pedido.map((item) => ({
        id: String(item.id),
        quantidade: item.quantidade,
      })),
      forma_pagamento: isPix
        ? undefined
        : removerAcentos(String(formaPagamento).toLowerCase()),
      tipo_entrega: tipoEntrega,
      mesa: tipoEntrega === "Mesa" ? mesa : undefined,
      nome_cliente: nomeCliente,
      endereco: tipoEntrega === "Entrega" ? endereco : undefined,
      payer_email: isPix ? emailCliente || undefined : undefined,
      precisa_troco: isDinheiro ? precisaTroco : undefined,
      troco_para: precisaTroco ? trocoPara : undefined,
    }),
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data.message || data.mensagem || "Erro ao processar pedido",
        );
      return data;
    })
    .then((json) => {
      if (json && json.mercado_pago && json.mercado_pago.qr_code_base64) {
        // --- FLUXO PIX ---
        const base64 = json.mercado_pago.qr_code_base64;
        const copia =
          json.mercado_pago.copia_e_cola || json.mercado_pago.qr_code || "";
        const transacaoId = json.transacao_id;

        // Limpa o carrinho local do cliente
        pedido = [];
        if (typeof atualizarListaPedido === "function") atualizarListaPedido();
        if (typeof atualizarBotaoFinalizar === "function")
          atualizarBotaoFinalizar();

        if (modalConfirmacao) modalConfirmacao.style.display = "none";
        if (modalPedido) modalPedido.style.display = "none";

        let intervalVerificacao;

        Swal.fire({
          title: "Aguardando Pagamento Pix",
          html: `
            <div style="text-align:center">
              <p style="font-size:14px;color:#555;margin-bottom:15px;">Escaneie o QR Code abaixo para efetuar o pagamento. Seu pedido será enviado para a cozinha após a confirmação!</p>
              <img src="data:image/png;base64,${base64}" style="max-width:240px;margin-bottom:12px;border:1px solid #ddd;border-radius:8px;padding:8px;background:#fff;"/>
              <div style="word-break:break-all;padding:10px;font-size:12px;background:#f8f9fa;border-radius:6px;border:1px dashed #ccc;margin-bottom:14px;user-select:all;">${copia}</div>

              <button type="button" class="swal2-confirm swal2-styled" style="background-color: #3085d6; margin-bottom: 12px; width: 100%; display: block;" onclick="window.copiarCodigoPix('${copia}')">
                <i class="fas fa-copy"></i> Copiar Código Pix
              </button>

              <p style="font-weight:bold;color:#28a745;font-size:15px;"><i class="fas fa-spinner fa-spin"></i> Confirmando recebimento em tempo real...</p>
            </div>
          `,
          showConfirmButton: false,
          showCancelButton: true,
          cancelButtonText: "Fechar",
          allowOutsideClick: false,
          didOpen: () => {
            // Monitora a transação provisória a cada 3 segundos
            intervalVerificacao = setInterval(() => {
              fetch(`${API_URL}/transacao-pix/${transacaoId}/status`)
                .then((r) => r.json())
                .then((statusJson) => {
                  if (statusJson.status === "processado_pago") {
                    clearInterval(intervalVerificacao);

                    const pedidoIdExibicao = statusJson.pedido_id
                      ? statusJson.pedido_id.slice(-6).toUpperCase()
                      : "CONFIRMADO";

                    Swal.fire({
                      icon: "success",
                      title: "Pagamento Confirmado! 🎉",
                      html: `
                        <div style="text-align:center;">
                          <p style="font-size:16px;">Seu Pix foi recebido com sucesso e seu pedido já está na cozinha!</p>
                          <p style="font-weight:bold;color:#ff9800;margin-top:10px;font-size:15px;">ID do Pedido: #${pedidoIdExibicao}</p>
                          <button type="button" class="swal2-confirm swal2-styled" onclick="copiarIdPedido('${statusJson.pedido_id}')"><i class="fas fa-copy"></i> Copiar ID</button>
                          <p style="font-size:13px;color:#777;margin-top:5px;">Agora é só relaxar e aguardar o preparo.</p>
                        </div>
                      `,
                      confirmButtonText: "Acompanhar pedido",
                      confirmButtonColor: "#28a745",
                    }).then((result) => {
                      if (result.isConfirmed) {
                        abrirAcompanhamentoPedido(statusJson.pedido_id);
                      }
                    });
                  }
                })
                .catch((e) =>
                  console.error("Erro ao verificar status do pagamento:", e),
                );
            }, 3000);
          },
          willClose: () => {
            if (intervalVerificacao) clearInterval(intervalVerificacao);
          },
        });
      } else {
        // --- FLUXO NORMAL (DINHEIRO / CARTÃO) ---
        Swal.close();

        pedido = [];
        if (typeof atualizarListaPedido === "function") atualizarListaPedido();
        if (typeof atualizarBotaoFinalizar === "function")
          atualizarBotaoFinalizar();

        if (modalConfirmacao) modalConfirmacao.style.display = "none";
        if (modalPedido) modalPedido.style.display = "none";

        // Exibe modal de confirmação de envio do pedido
        exibirPedidoCriado(json.pedido_id);
      }

      pedidoEnviado = false;
    })
    .catch((err) => {
      console.error(err);
      Swal.close(); // FECHA O LOADING EM CASO DE ERRO
      mostrarToast("Erro ao processar pedido!", "erro");
      pedidoEnviado = false;
    });
}

function abrirModalPedido() {
  if (pedido.length === 0) return;
  atualizarListaPedido();
  atualizarTotalPagamento();
  document.getElementById("modalPedido").style.display = "flex";
  esconderBusca();
}

function fecharModalPedido() {
  document.getElementById("modalPedido").style.display = "none";
}

// Execução imediata da busca inicial
carregarProdutos();

function fecharModalMesa() {
  const modal = document.getElementById("modalConfirmacao");
  if (modal) modal.style.display = "none";
  atualizarBotaoFinalizar();
}

function fecharModalPagamento() {
  document.getElementById("modalPagamento").style.display = "none";
  atualizarBotaoFinalizar();
}

function atualizarListaPedido() {
  const lista = document.getElementById("listaPedido");
  if (!lista) return;
  lista.innerHTML = "";

  pedido.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = `${item.nome || "Produto"} x${item.quantidade} `;

    const btnRemover = document.createElement("button");
    btnRemover.textContent = "-";
    btnRemover.classList.add("btn-remover");

    btnRemover.onclick = () => {
      if (item.quantidade > 1) {
        item.quantidade--;
      } else {
        pedido.splice(index, 1);
      }
      atualizarListaPedido();
      atualizarBotaoFinalizar();
      atualizarEstoqueVisual();
    };

    li.appendChild(btnRemover);
    lista.appendChild(li);
  });

  const totalPedidoModal = document.getElementById("totalPedidoModal");
  if (totalPedidoModal) {
    totalPedidoModal.textContent =
      pedido.length > 0
        ? calcularTotalPedido().toFixed(2).replace(".", ",")
        : "0,00";
  }
}

function calcularEstoqueRestanteNoCarrinho(produto) {
  if (
    produto.controla_estoque !== true &&
    Number(produto.controla_estoque) !== 1
  ) {
    return null;
  }
  const itemCarrinho = pedido.find((p) => p.id === produto.id);
  const quantidadeNoCarrinho = itemCarrinho ? itemCarrinho.quantidade : 0;

  return Math.max(0, (Number(produto.estoque) || 0) - quantidadeNoCarrinho);
}

function calcularTotalPedido() {
  return pedido.reduce((total, item) => {
    const precoItem = item.preco || 0;
    return total + precoItem * item.quantidade;
  }, 0);
}

function atualizarTotalPagamento() {
  const total = calcularTotalPedido();
  const span = document.getElementById("totalPagamento");
  if (span) {
    span.textContent = total.toFixed(2).replace(".", ",");
  }
}

function removerAcentos(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function filtrarCardapio() {
  const campo = document.getElementById("campoBusca");
  const busca = removerAcentos(campo.value.toLowerCase());
  const buscaContainer = document.getElementById("buscaContainer");

  if (busca.length > 0) {
    buscaContainer.classList.add("active");
    esconderBanner();
    esconderFooter();
  } else {
    buscaContainer.classList.remove("active");
    mostrarBanner();
    mostrarFooter();
  }

  let algumCardVisivel = false;
  document.querySelectorAll(".card-grid").forEach((grid) => {
    let algumVisivel = false;
    grid.querySelectorAll(".card").forEach((card) => {
      const titulo = removerAcentos(
        card.querySelector(".card-title")?.textContent.toLowerCase() || "",
      );
      const desc = removerAcentos(
        card.querySelector(".card-desc")?.textContent.toLowerCase() || "",
      );

      if (titulo.includes(busca) || desc.includes(busca)) {
        card.style.display = "";
        algumVisivel = true;
        algumCardVisivel = true;
      } else {
        card.style.display = "none";
      }
    });

    const tituloSecao = grid.previousElementSibling;
    if (tituloSecao && tituloSecao.tagName === "H2") {
      tituloSecao.style.display = algumVisivel ? "" : "none";
    }
  });

  let msgGlobal = document.getElementById("msg-nao-encontrado-global");
  if (!algumCardVisivel) {
    if (!msgGlobal) {
      msgGlobal = document.createElement("div");
      msgGlobal.id = "msg-nao-encontrado-global";
      msgGlobal.className = "msg-nao-encontrado";
      msgGlobal.textContent = "Esse item não existe no cardápio.";
      msgGlobal.style.color = "red";
      msgGlobal.style.textAlign = "center";
      msgGlobal.style.margin = "32px 0";
      const cardapio = document.getElementById("cardapio");
      if (cardapio) cardapio.appendChild(msgGlobal);
    }
  } else if (msgGlobal) {
    msgGlobal.remove();
  }
}

// Gerenciamento de Visibilidade das Barras e Rolagem
let lastScrollTop = 0;
const navbar = document.querySelector(".navbar");
const buscaContainerNav = document.getElementById("buscaContainer");

window.addEventListener("scroll", function () {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  if (navbar) {
    navbar.style.transform =
      scrollTop > lastScrollTop ? "translateY(-100%)" : "translateY(0)";
  }
  if (buscaContainerNav) {
    buscaContainerNav.style.transform =
      scrollTop > lastScrollTop ? "translateY(-100%)" : "translateY(0)";
  }
  lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
});

function esconderBanner() {
  const header = document.querySelector(".header");
  const logo = document.getElementById("logo-estabelecimento");
  const status = document.getElementById("status-loja");

  if (header) header.style.display = "none";
  if (logo) logo.style.display = "none";
  if (status) status.style.display = "none";
}

function mostrarBanner() {
  const header = document.querySelector(".header");
  const logo = document.getElementById("logo-estabelecimento");
  const status = document.getElementById("status-loja");

  if (header) header.style.display = "";
  if (logo) logo.style.display = "";
  if (status) status.style.display = "";
}

function esconderFooter() {
  const footer = document.querySelector("footer");
  if (footer) footer.style.display = "none";
}

function mostrarFooter() {
  const footer = document.querySelector("footer");
  if (footer) footer.style.display = "";
}

const btnScrool = document.getElementById("btnScrool");
let lastScrollTopBtn = 0;

window.addEventListener("scroll", function () {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  if (btnScrool) {
    if (scrollTop > 300 && scrollTop < lastScrollTopBtn) {
      btnScrool.classList.add("visible");
    } else {
      btnScrool.classList.remove("visible");
    }
  }
  lastScrollTopBtn = scrollTop;
});

if (btnScrool) {
  btnScrool.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function atualizarFooterComEstabelecimento(estabelecimento) {
  const footerEstabName = document.getElementById("footer-estab-name");
  const linkWhatsFooter = document.getElementById("link-whatsapp");
  const linkWhatsHeader = document.getElementById("link-whatsapp-header");
  const footerPhone = document.getElementById("footer-phone");

  if (footerEstabName) {
    footerEstabName.textContent = estabelecimento.nome || "Estabelecimento";
  }

  const telefone = estabelecimento.telefone || "";
  const telefoneLimpo = telefone.replace(/[^0-9]/g, "");
  const whatsappUrl =
    telefoneLimpo.length >= 8 ? `https://wa.me/${telefoneLimpo}` : "#";
  const whatsappTexto =
    telefoneLimpo.length >= 8 ? "WhatsApp" : "WhatsApp indisponível";

  if (linkWhatsFooter) {
    linkWhatsFooter.href = whatsappUrl;
    linkWhatsFooter.textContent = whatsappTexto;
  }
  if (linkWhatsHeader) {
    linkWhatsHeader.href = whatsappUrl;
  }
  if (footerPhone) {
    footerPhone.textContent = telefone
      ? `Telefone: ${telefone}`
      : "Telefone não informado";
  }
}

function toggleBusca() {
  const busca = document.getElementById("buscaContainer");
  const campo = document.getElementById("campoBusca");
  if (!busca) return;

  if (
    busca.style.display === "none" ||
    getComputedStyle(busca).display === "none"
  ) {
    busca.style.display = "block";
    if (campo) campo.focus();
  } else {
    busca.style.display = "none";
  }
}

function closeToast() {
  const toast = document.getElementById("toast");
  if (toast) toast.classList.remove("show");
}

function esconderBusca() {
  const busca = document.getElementById("buscaContainer");
  if (busca) busca.style.display = "none";
}

function mostrarBusca() {
  const busca = document.getElementById("buscaContainer");
  if (busca) busca.style.display = "block";
}

document.addEventListener("DOMContentLoaded", () => {
  const linkWhats = document.getElementById("link-whatsapp");
  const disabledMsg =
    "Como o modo teste está ativado, esses links estão desativados.";

  function handleFooterLinkClick(e, url) {
    if (modoTeste) {
      e.preventDefault();
      mostrarToast(disabledMsg);
      return;
    }
    if (!url || url === "#") {
      e.preventDefault();
      mostrarToast("Contato via WhatsApp indisponível no momento.", "erro");
      return;
    }
    window.open(url, "_blank");
    e.preventDefault();
  }

  if (linkWhats) {
    linkWhats.addEventListener("click", (e) =>
      handleFooterLinkClick(e, linkWhats.href),
    );
  }

  const searchButton = document.getElementById("searchButton");
  if (searchButton) {
    searchButton.addEventListener("click", toggleBusca);
  }

  const anoEl = document.getElementById("ano");
  if (anoEl) anoEl.textContent = new Date().getFullYear();
});

// Vinculação ao Escopo Global (window) para Módulos ES6
window.adicionarItem = adicionarItem;
window.finalizarPedido = finalizarPedido;
window.selecionarPagamento = selecionarPagamento;
window.alternarInputTroco = alternarInputTroco;
window.enviarPedido = enviarPedido;
window.abrirModalPedido = abrirModalPedido;
window.fecharModalPedido = fecharModalPedido;
window.fecharModalMesa = fecharModalMesa;
window.fecharModalPagamento = fecharModalPagamento;
window.filtrarCardapio = filtrarCardapio;
window.focarCategoria = focarCategoria;
window.toggleCategoryMenu = toggleCategoryMenu;
window.toggleMenu = toggleMenu;
window.toggleBusca = toggleBusca;
window.closeToast = closeToast;
window.esconderBusca = esconderBusca;
window.mostrarBusca = mostrarBusca;
