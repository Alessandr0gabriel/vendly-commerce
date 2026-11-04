import { API_URL } from "../core/config.js";
import { fetchComAuth } from "../core/api.js";
import { showError, showSuccess } from "../ui/alerts.js";
import { abrirModal, fecharModal } from "../ui/modais.js";
import { escapeHTML } from "../core/utils.js";
import { criarImagemProduto } from "../ui/produtoImagem.js";
import { normalizarPlano } from "../core/plan.js";

let produtoEditando = null;

function atualizarOpcaoTaxaMercadoPago() {
  const bloco = document.getElementById("configMercadoPagoProduto");
  if (!bloco) return;

  const disponivel = normalizarPlano(localStorage.getItem("plan")) === "full";
  bloco.hidden = !disponivel;

  if (!disponivel) definirOpcaoTaxaMercadoPago("assumir");
}

function obterOpcaoTaxaMercadoPago() {
  return (
    document.querySelector('input[name="mercadoPagoTaxa"]:checked')?.value ||
    "assumir"
  );
}

function definirOpcaoTaxaMercadoPago(opcao) {
  const valor = opcao === "repassar" ? "repassar" : "assumir";
  const radio = document.querySelector(
    `input[name="mercadoPagoTaxa"][value="${valor}"]`,
  );
  if (radio) radio.checked = true;
}

export function isEditingProduto() {
  return produtoEditando !== null;
}

export function limparProdutoForm() {
  const fields = [
    "nome",
    "descricao",
    "categoria",
    "preco",
    "imagem",
    "editImagemAtual",
  ];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  produtoEditando = null;
  const controlaEstoque = document.getElementById("controlaEstoque");
  if (controlaEstoque) controlaEstoque.checked = false;
  definirOpcaoTaxaMercadoPago("assumir");
  atualizarOpcaoTaxaMercadoPago();
  const title = document.getElementById("produtoModalTitle");
  if (title) title.textContent = "Cadastrar Produto";
}

export function atualizarEstadoEstoque() {
  const checkbox = document.getElementById("controlaEstoque");
  const estoqueInput = document.getElementById("estoque");

  if (!checkbox || !estoqueInput) return;

  if (checkbox.checked) {
    estoqueInput.disabled = false;
    estoqueInput.style.opacity = "1";
  } else {
    estoqueInput.disabled = true;
    estoqueInput.style.opacity = "0.5";
    estoqueInput.value = "";
  }
}

export function salvarProdutoModal() {
  if (produtoEditando) {
    salvarEdicao();
  } else {
    adicionarProduto();
  }
}

export async function adicionarProduto() {
  const nome = document.getElementById("nome")?.value;
  const descricao = document.getElementById("descricao")?.value;
  const categoria = document.getElementById("categoria")?.value;
  const precoInput = document.getElementById("preco")?.value;
  const preco = Number(precoInput?.replace(",", "."));
  const imagem = document.getElementById("imagem")?.files?.[0];
  const controlaEstoque = document.getElementById("controlaEstoque")?.checked;
  const mercadoPagoTaxa = obterOpcaoTaxaMercadoPago();
  const estoqueInput = document.getElementById("estoque");
  const estoque = Number(estoqueInput?.value || 0);

  if (!nome || !descricao || !categoria || !imagem) {
    return showError("Preencha tudo", "Todos os campos são obrigatórios.");
  }

  if (isNaN(preco)) {
    return showError("Preço inválido", "Use ponto para decimais. Ex: 10.50");
  }

  if (controlaEstoque && (isNaN(estoque) || estoque < 0)) {
    return showError("Estoque inválido", "Informe um estoque válido.");
  }

  const formData = new FormData();
  formData.append("nome", nome);
  formData.append("descricao", descricao);
  formData.append("categoria", categoria);
  formData.append("preco", preco);
  formData.append("imagem", imagem);
  formData.append("controla_estoque", controlaEstoque ? "true" : "false");
  formData.append("mercado_pago_taxa", mercadoPagoTaxa);

  if (controlaEstoque) {
    formData.append("estoque", estoque);
  }

  // Bloqueio visual para evitar cliques duplos no envio do formulário e upload da imagem
  Swal.fire({
    title: "Cadastrando produto...",
    text: "Por favor, aguarde o envio dos dados e da imagem.",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  try {
    await fetchComAuth(`${API_URL}/me/produtos`, {
      method: "POST",
      body: formData,
    });

    showSuccess("Produto cadastrado!", "");
    fecharModal(null, "modalProduto");
    limparProdutoForm();
    carregarProdutos();
  } catch (err) {
    console.error(err);
    showError(
      "Erro ao cadastrar produto",
      err.message || "Arquivo inválido ou corrompido",
    );
  }
}

export async function carregarProdutos() {
  const lista = document.getElementById("listarPedidos");
  if (!lista) return;

  lista.innerHTML = '<p class="empty-state">Carregando produtos...</p>';

  try {
    const produtos = await fetchComAuth(`${API_URL}/me/produtos`);
    if (!Array.isArray(produtos) || produtos.length === 0) {
      lista.innerHTML = '<p class="empty-state">Nenhum produto cadastrado.</p>';
      return;
    }

    const cards = produtos.map((produto) => {
      const controlaEstoque = produto.controla_estoque === true;
      const estoque = Number(produto.estoque) || 0;

      const card = document.createElement("div");
      card.className = "produto-card produto-card-com-imagem";

      const meta = document.createElement("div");
      meta.className = "produto-meta";

      const nome = document.createElement("strong");
      nome.textContent = String(produto.nome ?? "");
      const preco = document.createElement("span");
      preco.textContent = `R$ ${Number(produto.preco).toFixed(2)}`;
      const descricao = document.createElement("small");
      descricao.textContent = String(produto.descricao ?? "");
      meta.append(nome, preco, descricao);

      if (controlaEstoque) {
        const estoqueEl = document.createElement("small");
        if (estoque === 0) {
          estoqueEl.textContent = "Sem estoque";
          estoqueEl.style.color = "red";
          estoqueEl.style.fontWeight = "bold";
        } else if (estoque < 5) {
          estoqueEl.textContent = `Estoque baixo: ${estoque}`;
          estoqueEl.style.color = "red";
        } else {
          estoqueEl.textContent = `Estoque: ${estoque}`;
        }
        meta.appendChild(estoqueEl);
      }

      const acoes = document.createElement("div");
      acoes.className = "acoes";
      const criarBotao = (texto, acao) => {
        const botao = document.createElement("button");
        botao.textContent = texto;
        botao.addEventListener("click", acao);
        return botao;
      };

      acoes.appendChild(criarBotao("Editar", () => editarProduto(produto.id)));
      if (controlaEstoque) {
        acoes.appendChild(
          criarBotao("+ Estoque", () => alterarEstoque(produto.id, 1)),
        );
        acoes.appendChild(
          criarBotao("- Estoque", () => alterarEstoque(produto.id, -1)),
        );
      }
      acoes.appendChild(
        criarBotao("Deletar", () => deletarProduto(produto.id)),
      );

      card.append(criarImagemProduto(produto.imagem), meta, acoes);
      return card;
    });

    lista.replaceChildren(...cards);
  } catch (err) {
    console.error("Erro ao carregar produtos:", err);
    lista.innerHTML = '<p class="empty-state">Erro ao carregar produtos.</p>';
  }
}

export function alterarEstoque(id, quantidade) {
  const rota =
    quantidade > 0
      ? `/produtos/${id}/estoque/add`
      : `/produtos/${id}/estoque/remove`;

  // Trava a tela com um loading sutil para evitar spam de cliques que quebram o estoque
  Swal.fire({
    title: "Atualizando estoque...",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetchComAuth(`${API_URL}${rota}`, {
    method: "PATCH",
    body: JSON.stringify({ quantidade: Math.abs(quantidade) }),
  })
    .then(() => {
      Swal.close(); // Fecha a trava visual
      carregarProdutos();
    })
    .catch((err) => {
      console.error(err);
      showError("Erro ao atualizar estoque", err.message || "");
    });
}

export function editarProduto(id) {
  produtoEditando = id;

  // Mostra um indicador enquanto busca as informações do Firestore para popular o modal
  Swal.fire({
    title: "Carregando dados...",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetchComAuth(`${API_URL}/me/produtos`)
    .then((produtos) => {
      Swal.close();
      const p = produtos.find((x) => x.id === id);
      if (!p) return;

      document.getElementById("nome").value = p.nome || "";
      document.getElementById("descricao").value = p.descricao || "";
      document.getElementById("categoria").value = p.categoria || "";
      document.getElementById("preco").value = p.preco || "";
      if (document.getElementById("editImagemAtual")) {
        document.getElementById("editImagemAtual").value = p.imagem || "";
      }
      definirOpcaoTaxaMercadoPago(p.mercado_pago_taxa);
      atualizarOpcaoTaxaMercadoPago();

      const estoqueInput = document.getElementById("estoque");
      const checkbox = document.getElementById("controlaEstoque");
      const controla = p.controla_estoque === true;

      if (checkbox) checkbox.checked = controla;
      if (estoqueInput) {
        estoqueInput.value = p.estoque ?? 0;
        estoqueInput.disabled = !controla;
        estoqueInput.style.opacity = controla ? "1" : "0.5";
      }

      const title = document.getElementById("produtoModalTitle");
      if (title) title.textContent = "Editar Produto";

      abrirModal("produto");
    })
    .catch((err) => {
      Swal.close();
      console.error("Erro ao buscar produto:", err);
    });
}

export function deletarProduto(id) {
  Swal.fire({
    title: "Tem certeza?",
    text: "Você não poderá desfazer isso e a imagem será removida do Cloudinary!",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Sim, deletar!",
    cancelButtonText: "Cancelar",
    confirmButtonColor: "#3085d6",
    cancelButtonColor: "#d33",
    showLoaderOnConfirm: true,
    preConfirm: async () => {
      // Força a exibição do loading ativo nativo do SweetAlert durante o processo assíncrono
      Swal.showLoading();
      try {
        await fetchComAuth(`${API_URL}/produtos/${id}`, {
          method: "DELETE",
        });
      } catch (error) {
        Swal.showValidationMessage("Erro ao deletar o produto");
      }
    },
    allowOutsideClick: () => !Swal.isLoading(),
  }).then((result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: "Deletado!",
        text: "O produto foi removido com sucesso.",
        icon: "success",
        timer: 1500,
        showConfirmButton: false,
      });
      carregarProdutos();
    }
  });
}

export function salvarEdicao() {
  const nome = document.getElementById("nome")?.value;
  const descricao = document.getElementById("descricao")?.value;
  const categoria = document.getElementById("categoria")?.value;
  const preco = Number(
    document.getElementById("preco")?.value?.replace(",", "."),
  );
  const imagemFile = document.getElementById("imagem")?.files?.[0];
  const controlaEstoque = document.getElementById("controlaEstoque")?.checked;
  const mercadoPagoTaxa = obterOpcaoTaxaMercadoPago();
  const estoque = Number(document.getElementById("estoque")?.value || 0);

  if (!nome || !descricao || !categoria) {
    return showError("Preencha tudo", "Por favor, preencha todos os campos.");
  }

  if (isNaN(preco)) {
    return showError("Preço inválido", "Informe um valor de preço válido.");
  }

  if (controlaEstoque && (isNaN(estoque) || estoque < 0)) {
    return showError("Estoque inválido", "Informe um estoque válido.");
  }

  const formData = new FormData();
  formData.append("nome", nome);
  formData.append("descricao", descricao);
  formData.append("categoria", categoria);
  formData.append("preco", preco);
  formData.append("controla_estoque", controlaEstoque ? "true" : "false");
  formData.append("mercado_pago_taxa", mercadoPagoTaxa);

  if (controlaEstoque) {
    formData.append("estoque", estoque);
  }

  if (imagemFile) {
    formData.append("imagem", imagemFile);
  }

  // Trava a tela exibindo o status atualizado antes da resposta da API de alteração
  Swal.fire({
    title: "Salvando alterações...",
    text: "Por favor, aguarde a atualização dos dados do produto.",
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetchComAuth(`${API_URL}/produtos/${produtoEditando}`, {
    method: "PUT",
    body: formData,
  })
    .then(() => {
      showSuccess("Sucesso!", "Produto atualizado com sucesso!");
      fecharModal(null, "modalProduto");
      limparProdutoForm();
      carregarProdutos();
    })
    .catch((err) => {
      showError("Erro", err.message);
    });
}

// Vinculação de escopo para as chamadas inline do HTML do painel administrativo
window.editarProduto = editarProduto;
window.alterarEstoque = alterarEstoque;
window.deletarProduto = deletarProduto;
window.atualizarEstadoEstoque = atualizarEstadoEstoque;
window.salvarProdutoModal = salvarProdutoModal;
