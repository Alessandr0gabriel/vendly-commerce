const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const js = (rel) =>
  pathToFileURL(path.join(__dirname, "../../frontend/js", rel)).href;
const flush = () => new Promise((r) => setTimeout(r, 30));

function criarDom() {
  const mk = (id, { classes = [], menu } = {}) => {
    const set = new Set(classes);
    return {
      id,
      value: "",
      checked: false,
      disabled: false,
      hidden: false,
      textContent: "",
      innerHTML: "",
      innerText: "",
      files: [],
      style: {},
      dataset: menu ? { menu } : {},
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
      },
    };
  };
  const genericos = new Map();
  const el = (id) => {
    if (!genericos.has(id)) genericos.set(id, mk(id));
    return genericos.get(id);
  };

  const painel = mk("panelDefaultContent");
  const forms = [
    "modalProduto",
    "modalHorarios",
    "modalBanner",
    "modalDados",
    "modalLinkDaLoja",
  ].map((id) => mk(id, { classes: ["panel-form-view"] }));
  const menus = {
    Pedidos: mk("b-pedidos", { classes: ["active"], menu: "Pedidos" }),
    Produtos: mk("b-produtos", { menu: "Produtos" }),
    Cadastrar: mk("b-cadastrar", { menu: "Produtos" }),
    Historico: mk("b-historico", { menu: "Histórico" }),
    Horarios: mk("b-horarios", { menu: "Horários" }),
    Banner: mk("b-banner", { menu: "Banner" }),
    Dados: mk("b-dados", { menu: "Dados da loja" }),
    Link: mk("b-link", { menu: "Link" }),
  };
  const botoes = Object.values(menus);
  const tituloSecao = mk("tituloSecao");
  const lista = mk("listarPedidos");
  const inputBanner = mk("inputBanner");
  inputBanner.files = [{}];
  tituloSecao.textContent = "Pedidos pendentes";
  lista.innerHTML = '<p class="empty-state">Nenhum pedido pendente.</p>';
  // Mock mínimo de DOM: a listagem agora é montada com createElement.
  const criarNo = () => {
    const no = {
      children: [],
      style: {},
      textContent: "",
      className: "",
      setAttribute() {},
      addEventListener() {},
      append(...f) { no.children.push(...f); },
      appendChild(f) { no.children.push(f); return f; },
    };
    return no;
  };
  const textoDe = (no) =>
    typeof no === "string" ? no : (no.textContent || "") + (no.children || []).map(textoDe).join("");
  lista.replaceChildren = (...filhos) => {
    lista.innerHTML = filhos.map(textoDe).join("");
  };
  const chamadas = [];

  global.window = {
    location: { hostname: "localhost" },
    addEventListener() {},
    dispatchEvent() {},
  };
  global.localStorage = {
    getItem: (k) => ({ establishmentId: "e1", plan: "full" })[k] ?? null,
    setItem() {},
    removeItem() {},
  };
  global.FormData = class {
    append() {}
  };
  global.document = {
    cookie: "",
    createElement: criarNo,
    getElementById: (id) => {
      if (id === "panelDefaultContent") return painel;
      if (id === "tituloSecao") return tituloSecao;
      if (id === "listarPedidos") return lista;
      if (id === "inputBanner") return inputBanner;
      return forms.find((f) => f.id === id) || el(id);
    },
    querySelector: (sel) => {
      if (sel === ".sidebar-link.active")
        return botoes.find((b) => b.classList.contains("active")) || null;
      if (sel === ".panel-form-view.active")
        return forms.find((f) => f.classList.contains("active")) || null;
      return el(sel);
    },
    querySelectorAll: (sel) => {
      if (sel === ".panel-form-view.active")
        return forms.filter((f) => f.classList.contains("active"));
      if (sel === ".sidebar-link") return botoes;
      if (sel === ".dias-semana input:checked") return [{ value: "seg" }];
      return [];
    },
  };
  global.Swal = {
    fire: () => Promise.resolve({}),
    showLoading() {},
    close() {},
    isLoading: () => false,
  };
  global.alert = () => {};
  global.fetch = async (url, opts = {}) => {
    const metodo = opts.method || "GET";
    chamadas.push({ url, metodo });
    const ehLista = /\/me\/produtos$/.test(url) && metodo === "GET";
    return {
      status: 200,
      ok: true,
      json: async () =>
        ehLista
          ? [{ id: "p1", nome: "Pizza", descricao: "d", categoria: "c", preco: "10" }]
          : { nome: "Loja" },
    };
  };

  const ativos = () => forms.filter((f) => f.classList.contains("active"));
  const botaoAtivo = () => botoes.filter((b) => b.classList.contains("active"));
  // O que o usuário realmente vê na área principal.
  const visivel = () => {
    if (ativos().length > 0) return `form:${ativos()[0].id}`;
    if (painel.classList.contains("hidden")) return "EM BRANCO";
    return `conteudo:${tituloSecao.textContent}|${lista.innerHTML}`;
  };
  const puts = () => chamadas.filter((c) => c.metodo === "PUT").length;
  return { el, painel, forms, menus, ativos, botaoAtivo, tituloSecao, lista, visivel, chamadas, puts };
}

async function carregarModulos() {
  const modais = await import(js("ui/modais.js"));
  const sidebar = await import(js("modules/sidebar.js"));
  const produtos = await import(js("modules/produtos.js"));
  const estab = await import(js("modules/estabelecimento.js"));
  const horarios = await import(js("modules/horarios.js"));
  const banner = await import(js("modules/banner.js"));
  const contadores = { produto: 0 };
  // Espelha o registro de hooks feito em admin.js
  modais.registerModalHooks({
    afterCloseProduto: () => {
      contadores.produto++;
      produtos.limparProdutoForm();
      produtos.atualizarEstadoEstoque();
    },
  });
  return { ...modais, ...sidebar, ...produtos, ...estab, ...horarios, ...banner, contadores };
}

// Reproduz o onclick inline da sidebar: setActiveMenu(this); abrirModal(...)
async function clicar(m, botao, formulario) {
  const p = m.setActiveMenu(botao);
  if (formulario) await m.abrirModal(formulario);
  await p;
  await flush();
}

const naoEmBranco = (d) => assert.notEqual(d.visivel(), "EM BRANCO");
const naoMostraPedidos = (d) => {
  const v = d.visivel();
  assert.ok(!/pedidos? pendentes?/i.test(v), `Pedidos pendentes apareceu: ${v}`);
};

const CONFIG = [
  {
    nome: "Dados da loja",
    menu: "Dados",
    abrir: "dados",
    form: "modalDados",
    titulo: "Dados da loja",
    salvar: async (d, m) => {
      d.el("inputNomeEstabelecimento").value = "Loja";
      d.el("inputNomeEstabelecimento").dataset.persistedName = "Loja";
      d.el("inputTelefone").value = "11999999999";
      await m.salvarDados();
    },
  },
  {
    nome: "Horários",
    menu: "Horarios",
    abrir: "horarios",
    form: "modalHorarios",
    titulo: "Horários",
    salvar: async (d, m) => {
      d.el("abertura-global").value = "08:00";
      d.el("fechamento-global").value = "18:00";
      await m.aplicarHorarios();
    },
  },
  {
    nome: "Banner",
    menu: "Banner",
    abrir: "banner",
    form: "modalBanner",
    titulo: "Banner",
    salvar: async (_d, m) => m.enviarBanner(),
  },
];

for (const cfg of CONFIG) {
  test(`Pedidos → ${cfg.nome} → salvar permanece em ${cfg.nome}, sem Pedidos pendentes`, async () => {
    const d = criarDom();
    const m = await carregarModulos();

    await clicar(m, d.menus.Pedidos);
    assert.match(d.visivel(), /^conteudo:Pedidos pendentes/);

    await clicar(m, d.menus[cfg.menu], cfg.abrir);
    assert.equal(d.visivel(), `form:${cfg.form}`);

    for (let i = 0; i < 2; i++) {
      const antes = d.puts();
      await cfg.salvar(d, m);
      await flush();
      assert.equal(d.visivel(), `form:${cfg.form}`, "formulário continua visível");
      assert.deepEqual(d.botaoAtivo(), [d.menus[cfg.menu]]);
      assert.equal(d.tituloSecao.textContent, cfg.titulo);
      naoMostraPedidos(d);
      assert.equal(d.puts() - antes, 1, "uma única requisição de salvamento");
    }
  });

  test(`${cfg.nome}: fechar pelo X, Cancelar e fundo mantém a seção e nunca mostra Pedidos`, async () => {
    const d = criarDom();
    const m = await carregarModulos();
    await clicar(m, d.menus.Pedidos);

    for (const modo of ["x/cancelar", "fundo"]) {
      await clicar(m, d.menus[cfg.menu], cfg.abrir);
      assert.equal(d.visivel(), `form:${cfg.form}`);

      if (modo === "fundo") {
        // clique dentro do conteúdo não fecha
        m.fecharModal({ target: {} }, cfg.form);
        assert.equal(d.visivel(), `form:${cfg.form}`);
        m.fecharModal({ target: d.forms.find((f) => f.id === cfg.form) }, cfg.form);
      } else {
        m.fecharModal(null, cfg.form);
      }
      await flush();
      assert.ok(d.visivel().startsWith(`conteudo:${cfg.titulo}|`), d.visivel());
      assert.deepEqual(d.botaoAtivo(), [d.menus[cfg.menu]]);
      naoMostraPedidos(d);
    }
  });
}

test("Link da loja: fechar mantém Link da loja", async () => {
  const d = criarDom();
  const m = await carregarModulos();
  await clicar(m, d.menus.Pedidos);
  await clicar(m, d.menus.Link, "linkDaLoja");
  assert.equal(d.visivel(), "form:modalLinkDaLoja");
  m.fecharModal(null, "modalLinkDaLoja");
  assert.ok(d.visivel().startsWith("conteudo:Link da loja|"));
  assert.deepEqual(d.botaoAtivo(), [d.menus.Link]);
  naoMostraPedidos(d);
});

test("Produtos: cadastrar, editar, cancelar edição e cadastrar outro voltam à listagem de Produtos", async () => {
  const d = criarDom();
  const m = await carregarModulos();

  await clicar(m, d.menus.Pedidos);
  await clicar(m, d.menus.Cadastrar, "produto");
  assert.equal(d.visivel(), "form:modalProduto");
  d.el("nome").value = "A";
  d.el("descricao").value = "B";
  d.el("categoria").value = "C";
  d.el("preco").value = "5";
  d.el("imagem").files = [{}];
  await m.adicionarProduto();
  await flush();
  assert.ok(d.visivel().startsWith("conteudo:Produtos|"), d.visivel());
  assert.deepEqual(d.botaoAtivo(), [d.menus.Cadastrar]);
  assert.match(d.lista.innerHTML, /Pizza/, "listagem atualizada");
  naoMostraPedidos(d);

  m.editarProduto("p1");
  await flush();
  assert.equal(d.visivel(), "form:modalProduto");
  assert.equal(m.isEditingProduto(), true);
  m.salvarEdicao();
  await flush();
  assert.ok(d.visivel().startsWith("conteudo:Produtos|"), d.visivel());
  assert.equal(m.isEditingProduto(), false);
  naoMostraPedidos(d);

  m.editarProduto("p1");
  await flush();
  m.fecharModal(null, "modalProduto");
  assert.equal(m.isEditingProduto(), false, "cancelar limpa o estado de edição");
  assert.ok(d.visivel().startsWith("conteudo:Produtos|"), d.visivel());
  assert.deepEqual(d.botaoAtivo(), [d.menus.Cadastrar]);

  const posts = () => d.chamadas.filter((c) => c.metodo === "POST").length;
  const putsAntes = d.puts();
  const postsAntes = posts();
  await clicar(m, d.menus.Cadastrar, "produto");
  d.el("nome").value = "Novo";
  d.el("descricao").value = "x";
  d.el("categoria").value = "y";
  d.el("preco").value = "7";
  d.el("imagem").files = [{}];
  m.salvarProdutoModal();
  await flush();
  assert.equal(posts() - postsAntes, 1, "cadastro faz POST");
  assert.equal(d.puts() - putsAntes, 0, "não reaproveita o produto cancelado (sem PUT)");
  assert.ok(d.visivel().startsWith("conteudo:Produtos|"));
});

test("navegação manual com formulário aberto é respeitada, hooks rodam uma vez e nunca há tela em branco", async () => {
  const d = criarDom();
  const m = await carregarModulos();

  await clicar(m, d.menus.Pedidos);
  await clicar(m, d.menus.Dados, "dados");
  await clicar(m, d.menus.Historico);
  assert.equal(d.ativos().length, 0);
  assert.deepEqual(d.botaoAtivo(), [d.menus.Historico]);
  assert.ok(d.visivel().startsWith("conteudo:Histórico|"), d.visivel());

  await clicar(m, d.menus.Horarios, "horarios");
  await clicar(m, d.menus.Pedidos);
  assert.ok(d.visivel().startsWith("conteudo:Pedidos pendentes|"), d.visivel());
  assert.deepEqual(d.botaoAtivo(), [d.menus.Pedidos]);

  // formulário já fechado: fechar de novo não muda a seção escolhida
  m.fecharModal(null, "modalHorarios");
  assert.deepEqual(d.botaoAtivo(), [d.menus.Pedidos]);

  // hook do produto: uma vez ao fechar e uma vez ao navegar com ele aberto
  await clicar(m, d.menus.Produtos);
  await m.abrirModal("produto");
  m.fecharModal(null, "modalProduto");
  assert.equal(m.contadores.produto, 1);
  await m.abrirModal("produto");
  await clicar(m, d.menus.Historico);
  assert.equal(m.contadores.produto, 2);

  // abre e fecha formulários repetidamente
  const reqs = d.chamadas.length;
  for (let i = 0; i < 5; i++) {
    for (const [menu, abrir, form] of [
      ["Horarios", "horarios", "modalHorarios"],
      ["Banner", "banner", "modalBanner"],
      ["Dados", "dados", "modalDados"],
      ["Link", "linkDaLoja", "modalLinkDaLoja"],
    ]) {
      await clicar(m, d.menus[menu], abrir);
      assert.equal(d.visivel(), `form:${form}`);
      assert.deepEqual(d.ativos().length, 1);
      m.fecharModal(null, form);
      naoEmBranco(d);
      naoMostraPedidos(d);
    }
  }
  assert.equal(d.chamadas.length, reqs, "abrir/fechar não gera requisições");
});

test("regressão: subtítulo acompanha a seção ao alternar Produtos e Pedidos", async () => {
  const d = criarDom();
  const m = await carregarModulos();
  const sub = () => d.el(".card-head p").textContent;

  for (let i = 0; i < 3; i++) {
    await clicar(m, d.menus.Produtos);
    assert.equal(d.tituloSecao.textContent, "Produtos");
    assert.match(sub(), /Gerencie os produtos/);
    await clicar(m, d.menus.Pedidos);
    assert.equal(d.tituloSecao.textContent, "Pedidos pendentes");
    assert.match(sub(), /Visualize e finalize pedidos/);
    assert.doesNotMatch(sub(), /produtos do seu cardápio/);
  }
});

test("regressão: layout com miniatura fica restrito aos cards de Produtos", () => {
  const fs = require("node:fs");
  const front = path.join(__dirname, "..", "..", "frontend");
  const css = fs.readFileSync(path.join(front, "css/admin/produtos.css"), "utf8");
  const produtosJs = fs.readFileSync(path.join(front, "js/modules/produtos.js"), "utf8");
  const pedidosJs = fs.readFileSync(path.join(front, "js/modules/pedidos.js"), "utf8");

  assert.match(produtosJs, /produto-card produto-card-com-imagem/);
  assert.doesNotMatch(pedidosJs, /produto-card-com-imagem|produto-thumb/);

  // Nenhuma regra de coluna com miniatura pode usar .produto-card sem o modificador.
  const blocos = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, seletor, corpo] of blocos) {
    if (/grid-template-columns:\s*(72|56)px/.test(corpo)) {
      assert.match(seletor, /produto-card-com-imagem/, seletor);
    }
  }
  assert.match(css, /\.produto-card \{[^}]*grid-template-columns: 1fr auto;/);
});