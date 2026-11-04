// Mesma estratégia de js/core/config.js e js/login.js: o ambiente depende apenas do hostname.
const API_URL = (window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000").replace(/\/$/, "");

function fetchComAuth(url, options = {}) {
  const isFormData = options.body instanceof FormData;

  const headers = {
    ...options.headers,
  };

  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  let csrfToken = localStorage.getItem("csrfToken");

  if (!csrfToken) {
    csrfToken = document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrf-token="))
      ?.split("=")[1];
  }

  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: "include",
  }).then(async (res) => {
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }

    const mensagemBackend = typeof data.mensagem === "string" ? data.mensagem : "";
    // 401, CSRF inválido e troca de senha obrigatória invalidam a sessão local.
    // Demais 403 (permissão/regra de negócio) apenas negam a operação.
    const sessaoInvalida =
      res.status === 401 ||
      (res.status === 403 &&
        (data.code === "FORCAR_TROCA_SENHA" ||
          /csrf/i.test(mensagemBackend) ||
          data.code === "CSRF_INVALIDO" ||
          /desativada/i.test(mensagemBackend)));

    if (sessaoInvalida) {
      console.warn("Sessão ou CSRF inválido detectado. Limpando credenciais locais...");

      localStorage.removeItem("role");
      localStorage.removeItem("csrfToken");
      localStorage.removeItem("establishmentId");
      localStorage.removeItem("establishmentName");

      if (document.body.classList.contains("restrito")) {
        // Interface ainda protegida (invisível): redireciona sem depender de diálogo.
        window.location.href = "login.html";
      } else if (typeof Swal !== "undefined") {
        Swal.fire({
          icon: "warning",
          title: "Sessão expirada",
          text: "Sua validação de segurança expirou. Por favor, faça login novamente.",
          confirmButtonText: "OK",
        }).then(() => {
          window.location.href = "login.html";
        });
      } else {
        alert("Sessão expirada. Faça login novamente.");
        window.location.href = "login.html";
      }
      return Promise.reject("Sessão inválida");
    }

    if (!res.ok) {
      if (res.status === 403 && document.body.classList.contains("restrito")) {
        // Sem permissão de superadmin: a interface protegida nunca é exibida.
        window.location.href = "login.html";
        return Promise.reject("Sem permissão");
      }
      let mensagem = mensagemBackend || "Erro na requisição";
      if (res.status >= 500) {
        mensagem = "Serviço temporariamente indisponível. Tente novamente em instantes.";
      }
      const erro = new Error(mensagem);
      erro.status = res.status;
      erro.detalhes = data.detalhes;
      throw erro;
    }
    return data;
  });
}

// Helper de DOM seguro: dados não confiáveis entram sempre via textContent/addEventListener.
function criarEl(tag, { classe, texto, attrs, estilo, onClick, filhos } = {}) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined && texto !== null) el.textContent = String(texto);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  }
  if (estilo) el.style.cssText = estilo;
  if (onClick) el.addEventListener("click", onClick);
  (filhos || []).forEach((f) => f && el.appendChild(f));
  return el;
}

function criarLinhaTd(conteudo, { attrs, classe, estilo } = {}) {
  const td = criarEl("td", { attrs, classe, estilo });
  [].concat(conteudo).forEach((c) => {
    td.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return td;
}

// VALIDAÇÃO IMEDIATA: Executa no topo do ciclo de vida para segurança absoluta
let meuSuperAdminId = null;
let meuEhSuperAdminPadrao = false;

async function verificarSuperAdmin() {
  const role = localStorage.getItem("role");

  if (role !== "superadmin") {
    localStorage.clear();
    window.location.href = "login.html";
    return;
  }

  let autorizado = false;

  try {
    await fetchComAuth(`${API_URL}/api/admin/check-token`);

    // A role é confirmada pelo backend; o localStorage é apenas uma dica de UI.
    const eu = await fetchComAuth(`${API_URL}/api/admin/me`);
    if (eu.role !== "superadmin") {
      localStorage.clear();
      window.location.href = "login.html";
      return;
    }

    autorizado = true;
    document.body.classList.remove("restrito");

    try {
      meuSuperAdminId = eu.id;
      meuEhSuperAdminPadrao = !!eu.isDefaultSuperAdmin;

      // Apenas o superadmin padrão pode acessar a área de Preços & Ofertas.
      if (!meuEhSuperAdminPadrao) {
        document.getElementById("btnMenuPlanosLanding")?.remove();
        document.getElementById("btnMenuMercadoPagoVendly")?.remove();
        document.getElementById("btnMenuAssinaturas")?.remove();
      }
    } catch (err) {
      console.warn("Não foi possível identificar o próprio superadmin:", err);
    }

    // Inicializa o carregamento normal de todos os dados com as rotas corrigidas
    await Promise.allSettled([
      carregarAdmins(),
      carregarEstabelecimentos(),
      carregarSolicitacoes(),
      carregarMetricasGerais(),
      carregarPlanosLanding(),
      meuEhSuperAdminPadrao ? carregarMercadoPagoVendly() : Promise.resolve(),
      meuEhSuperAdminPadrao ? carregarAssinaturas() : Promise.resolve(),
    ]);

    setInterval(() => {
      fetchComAuth(`${API_URL}/api/admin/check-token`).catch(() => {
        console.warn("A sessão do superadmin deixou de ser válida.");
      });
    }, 15000);
  } catch (err) {
    console.error("Falha na validação do SuperAdmin:", err);
    // 401/403 já redirecionam em fetchComAuth; aqui cobre falhas de rede/servidor.
    if (!autorizado) {
      localStorage.clear();
      window.location.href = "login.html?erro=servidor";
    }
  } finally {
    document.getElementById("loading")?.classList.remove("active");
  }
}

function carregarMetricasGerais() {
  return fetchComAuth(`${API_URL}/api/admin/faturamento`)
    .then((data) => {
      const elemTotalLojas = document.getElementById("totalLojas");
      const elemFaturamento = document.getElementById("faturamentoSaaS");

      if (elemTotalLojas) {
        elemTotalLojas.innerText = data.totalLojas || 0;
      }
      if (elemFaturamento) {
        elemFaturamento.innerText = `R$ ${
          data.faturamento_total
            ? Number(data.faturamento_total).toFixed(2)
            : "0,00"
        }`;
      }
    })
    .catch((err) => console.error("Erro métricas saas:", err));
}

function carregarAdmins() {
  const loadingState = document.getElementById("adminsLoadingState");
  if (loadingState) loadingState.hidden = false;

  return fetchComAuth(`${API_URL}/api/admin/list`)
    .then((data) => {
      const tabela = document.getElementById("tabelaAdminsBody");
      if (!tabela) return;
      tabela.innerHTML = "";

      const listaAdmins = data.admins || [];

      if (listaAdmins.length === 0) {
        tabela.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding:20px;">Nenhum administrador cadastrado.</td></tr>`;
        return;
      }

      listaAdmins.forEach((admin) => {
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid rgba(255, 255, 255, 0.05)";
        tr.style.verticalAlign = "middle";

        // O superadmin padrão pode gerenciar outros superadmins. Os demais não.
        const ehOutroSuperAdmin =
          admin.role === "superadmin" &&
          admin.id !== meuSuperAdminId &&
          !meuEhSuperAdminPadrao;

        const btnStatus = criarEl("button", {
          classe: `action-mini-btn ${admin.active ? "btn-saas-status-active" : "btn-saas-status-inactive"}`,
          texto: admin.active ? "✕ Desativar" : "✓ Ativar",
          onClick: () => alternarStatusAdmin(admin.id, admin.active),
        });

        const btnDesbloquear = admin.bloqueado
          ? criarEl("button", {
              classe: "action-mini-btn btn-saas-unlock",
              texto: "⚡ Desbloquear",
              onClick: () => desbloquearAdmin(admin.id, admin.email),
            })
          : null;

        const btnResetSenha = criarEl("button", {
          classe: "action-mini-btn btn-saas-reset",
          texto: "🔑 Resetar Senha",
          onClick: () => resetarSenhaAdmin(admin.id, admin.email),
        });

        const btnEditarPlano = criarEl("button", {
          classe: "action-mini-btn btn-saas-plan",
          texto: "📝 Plano",
          onClick: () => abrirModalEditarPlano(admin.id, admin.plan || "barato"),
        });

        const acoesCelula = ehOutroSuperAdmin
          ? criarEl("span", {
              classe: "saas-badge badge-blocked",
              texto: "🔒 Protegido",
            })
          : criarEl("div", {
              classe: "actions-cell-container",
              filhos: [btnStatus, btnEditarPlano, btnDesbloquear, btnResetSenha],
            });

        const statusBadge = criarEl("div", {
          estilo: "display:contents",
          filhos: [
            criarEl("span", {
              classe: `saas-badge ${admin.active ? "badge-active" : "badge-inactive"}`,
              texto: admin.active ? "Ativo" : "Inativo",
            }),
            admin.bloqueado
              ? criarEl("span", {
                  classe: "saas-badge badge-blocked",
                  texto: "Bloqueado",
                })
              : null,
          ],
        });

        tr.append(
          criarLinhaTd(admin.establishment_name || "SuperAdmin / Global", {
            attrs: { "data-label": "Estabelecimento" },
            estilo: "padding: 14px 12px; font-weight: 500;",
          }),
          criarLinhaTd(String(admin.email ?? ""), {
            attrs: { "data-label": "E-mail" },
            estilo:
              "padding: 14px 12px; color: rgba(238, 242, 255, 0.8); font-family: monospace; font-size: 0.9rem;",
          }),
          criarLinhaTd(
            criarEl("span", {
              classe: "saas-badge",
              texto: admin.plan || "barato",
            }),
            {
              attrs: { "data-label": "Plano" },
              classe: "plan-cell",
              estilo: "padding: 14px 12px;",
            },
          ),
          criarLinhaTd(statusBadge, {
            attrs: { "data-label": "Status" },
            estilo: "padding: 14px 12px;",
          }),
          criarLinhaTd(acoesCelula, {
            attrs: { "data-label": "Ações" },
            estilo: "padding: 14px 12px;",
          }),
        );
        tabela.appendChild(tr);
      });
    })
    .catch((err) => console.error("Erro admins:", err))
    .finally(() => {
      if (loadingState) loadingState.hidden = true;
    });
}

function desbloquearAdmin(id, email) {
  Swal.fire({
    title: "Desbloquear conta?",
    text: `Deseja remover o bloqueio por erros de senha do administrador: ${email}?`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Sim, desbloquear",
    cancelButtonText: "Cancelar",
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Processando...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    fetchComAuth(`${API_URL}/api/admin/desbloquear/${encodeURIComponent(id)}`, {
      method: "PUT",
    })
      .then((res) => {
        Swal.fire(
          "Sucesso!",
          res.mensagem || "Conta desbloqueada com sucesso!",
          "success",
        );
        carregarAdmins();
      })
      .catch((err) => Swal.fire("Erro", err.message, "error"));
  });
}

function resetarSenhaAdmin(id, email) {
  Swal.fire({
    title: "Redefinir senha",
    text: `Insira a nova senha temporária para ${email} (mínimo 8 caracteres):`,
    input: "password",
    inputAttributes: {
      autocapitalize: "off",
      autocorrect: "off",
    },
    showCancelButton: true,
    confirmButtonText: "Gravar Nova Senha",
    cancelButtonText: "Cancelar",
    inputValidator: (value) => {
      if (!value || value.trim().length < 8) {
        return "A senha deve conter pelo menos 8 caracteres!";
      }
    },
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Salvando nova senha...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    fetchComAuth(`${API_URL}/api/admin/${encodeURIComponent(id)}/reset-password`, {
      method: "PUT",
      body: JSON.stringify({ senha: result.value.trim() }),
    })
      .then((res) => {
        Swal.fire(
          "Sucesso!",
          "Senha redefinida! O usuário será forçado a trocá-la no próximo acesso.",
          "success",
        );
        carregarAdmins();
      })
      .catch((err) => Swal.fire("Erro", err.message, "error"));
  });
}

function carregarEstabelecimentos() {
  return fetchComAuth(`${API_URL}/api/admin/estabelecimentos`)
    .then((lojas) => {
      const tabela = document.getElementById("tabelaLojasBody");
      if (tabela) tabela.innerHTML = "";

      const listaLojas = Array.isArray(lojas) ? lojas : [];

      listaLojas.forEach((loja) => {
        if (tabela) {
          const suspensa = loja.status === "suspended";
          const tr = document.createElement("tr");
          tr.append(
            criarLinhaTd(String(loja.nome ?? "")),
            criarLinhaTd(`${loja.slug || "---"}.vendly.com`),
            criarLinhaTd(
              criarEl("span", {
                classe: "badge bg-primary text-uppercase",
                texto: loja.plano || "SaaS Enterprise",
              }),
            ),
            criarLinhaTd(
              criarEl("span", {
                classe: `badge ${!suspensa ? "bg-success" : "bg-danger"}`,
                texto: !suspensa ? "Ativo" : "Suspenso",
              }),
            ),
            criarLinhaTd([
              criarEl("button", {
                classe: "btn btn-sm btn-info",
                texto: "Plano",
                onClick: () => abrirModalPlano(loja.id, loja.plano || "gratis"),
              }),
              " ",
              criarEl("button", {
                classe: `btn btn-sm ${!suspensa ? "btn-danger" : "btn-success"}`,
                texto: !suspensa ? "Suspender" : "Reativar",
                onClick: () => alternarStatusLoja(loja.id, loja.status),
              }),
            ]),
          );
          tabela.appendChild(tr);
        }
      });
    })
    .catch((err) => console.error("Erro estabelecimentos:", err));
}

function carregarSolicitacoes() {
  return fetchComAuth(`${API_URL}/api/admin/estabelecimentos`)
    .then((lista) => {
      const tabela = document.getElementById("tabelaSolicitacoesBody");
      if (!tabela) return;
      tabela.innerHTML = "";

      const pendentes = Array.isArray(lista)
        ? lista.filter((l) => l.status === "pendente")
        : [];

      if (pendentes.length === 0) {
        tabela.innerHTML = `<tr><td colspan="5" class="text-center text-muted">Nenhuma solicitação pendente.</td></tr>`;
        return;
      }

      pendentes.forEach((sol) => {
        const tr = document.createElement("tr");
        tr.append(
          criarLinhaTd(String(sol.nome ?? "")),
          criarLinhaTd(`${sol.slug}.vendly.com`),
          criarLinhaTd("Administrador do Sistema"),
          criarLinhaTd(
            criarEl("span", { classe: "badge bg-warning", texto: "Pendente" }),
          ),
          criarLinhaTd([
            criarEl("button", {
              classe: "btn btn-sm btn-success",
              texto: "Aprovar",
              onClick: () => processarSolicitacao(sol.id, "aprovar"),
            }),
            " ",
            criarEl("button", {
              classe: "btn btn-sm btn-danger",
              texto: "Rejeitar",
              onClick: () => processarSolicitacao(sol.id, "rejeitar"),
            }),
          ]),
        );
        tabela.appendChild(tr);
      });
    })
    .catch((err) => console.error("Erro solicitações:", err));
}

function setActiveMenu(abaId) {
  const secoes = [
    "dashboard",
    "estabelecimentos",
    "admins",
    "solicitacoes",
    "planosLanding",
    "mercadoPagoVendly",
    "assinaturas",
  ];
  secoes.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("d-none");
  });

  const secaoAtiva = document.getElementById(abaId);
  if (secaoAtiva) secaoAtiva.classList.remove("d-none");

  const botoes = document.querySelectorAll(
    ".sidebar .nav-link, .sidebar button",
  );
  botoes.forEach((btn) => btn.classList.remove("active"));

  if (abaId === "planosLanding") {
    carregarPlanosLanding();
  }
  if (abaId === "mercadoPagoVendly") {
    carregarMercadoPagoVendly();
  }
  if (abaId === "assinaturas") {
    carregarAssinaturas();
  }

  document.querySelector(".sidebar")?.classList.remove("active");
}

function formatarDataAssinaturaAdmin(valor) {
  return valor
    ? new Date(valor).toLocaleDateString("pt-BR")
    : "Não configurada";
}

function carregarAssinaturas() {
  return fetchComAuth(`${API_URL}/api/admin/estabelecimentos`)
    .then((lojas) => {
      const tabela = document.getElementById("tabelaAssinaturasBody");
      const listaMobile = document.getElementById("listaAssinaturasMobile");
      if (!tabela && !listaMobile) return;
      if (tabela) tabela.innerHTML = "";
      if (listaMobile) listaMobile.innerHTML = "";
      (Array.isArray(lojas) ? lojas : []).forEach((loja) => {
        const assinatura = loja.assinatura || { status: "nao_configurada" };
        const statusTxt = String(assinatura.status || "nao_configurada");
        const statusClasse = `status-${statusTxt.replace(/[^a-z0-9_-]/gi, "").replace("_", "-")}`;
        const criarAcoes = () =>
          criarEl("div", {
            classe: "assinatura-acoes",
            filhos: [
              ...[30, 90, 365].map((d) =>
                criarEl("button", {
                  classe: "assinatura-action",
                  texto: `+${d} dias`,
                  onClick: () => alterarAssinaturaManual(loja.id, d),
                }),
              ),
              criarEl("button", {
                classe: "assinatura-action assinatura-action-outline",
                texto: "Definir data",
                onClick: () => definirVencimentoAssinatura(loja.id),
              }),
            ],
          });
        const nomeLoja = String(loja.nome || "Sem nome");
        const slugTxt = `${loja.slug || "sem slug"}.vendly.com`;

        if (tabela) {
          const tr = document.createElement("tr");
          tr.append(
            criarLinhaTd(
              [
                criarEl("strong", { texto: nomeLoja }),
                criarEl("small", { texto: slugTxt }),
              ],
              { classe: "assinatura-estabelecimento" },
            ),
            criarLinhaTd(
              criarEl("span", {
                classe: "assinatura-plano",
                texto: loja.plano || "-",
              }),
            ),
            criarLinhaTd(
              criarEl("span", {
                classe: `assinatura-status ${statusClasse}`,
                texto: statusTxt,
              }),
            ),
            criarLinhaTd(formatarDataAssinaturaAdmin(assinatura.vence_em), {
              classe: "assinatura-vencimento",
            }),
            criarLinhaTd(criarAcoes()),
          );
          tabela.appendChild(tr);
        }

        if (listaMobile) {
          const card = document.createElement("article");
          card.className = "assinatura-mobile-card";
          const dias =
            assinatura.status === "carencia"
              ? assinatura.dias_restantes_carencia
              : assinatura.dias_restantes;
          const campo = (rotulo, conteudo, extra = "") =>
            criarEl("div", {
              classe: `assinatura-mobile-field${extra}`,
              filhos: [
                criarEl("span", {
                  classe: "assinatura-mobile-label",
                  texto: rotulo,
                }),
                ...[].concat(conteudo),
              ],
            });
          card.append(
            campo("Estabelecimento", [
              criarEl("strong", { texto: nomeLoja }),
              criarEl("small", { texto: slugTxt }),
            ]),
            campo(
              "Plano",
              criarEl("span", {
                classe: "assinatura-plano",
                texto: loja.plano || "-",
              }),
            ),
            campo(
              "Status",
              criarEl("span", {
                classe: `assinatura-status ${statusClasse}`,
                texto: statusTxt,
              }),
            ),
            campo(
              "Vencimento",
              criarEl("strong", {
                texto: formatarDataAssinaturaAdmin(assinatura.vence_em),
              }),
            ),
          );
          if (dias !== null && dias !== undefined && Number.isFinite(Number(dias))) {
            card.appendChild(
              campo(
                "Dias restantes",
                criarEl("strong", {
                  texto: `${Number(dias)} ${Number(dias) === 1 ? "dia" : "dias"}`,
                }),
              ),
            );
          }
          card.appendChild(
            campo("Ações", criarAcoes(), " assinatura-mobile-actions"),
          );
          listaMobile.appendChild(card);
        }
      });
    })
    .catch((err) => console.error("Erro ao carregar assinaturas:", err));
}

function alterarAssinaturaManual(establishmentId, dias) {
  Swal.fire({
    title: `Adicionar ${dias} dias?`,
    text: "A alteração será registrada na auditoria administrativa.",
    showCancelButton: true,
    confirmButtonText: "Confirmar",
    cancelButtonText: "Cancelar",
  }).then((resultado) => {
    if (!resultado.isConfirmed) return;
    fetchComAuth(
      `${API_URL}/api/admin/estabelecimentos/${encodeURIComponent(establishmentId)}/assinatura`,
      {
        method: "PUT",
        body: JSON.stringify({ dias }),
      },
    )
      .then(() => carregarAssinaturas())
      .catch((err) => Swal.fire("Erro", err.message, "error"));
  });
}

function definirVencimentoAssinatura(establishmentId) {
  Swal.fire({
    title: "Definir vencimento",
    input: "date",
    showCancelButton: true,
    confirmButtonText: "Salvar",
    cancelButtonText: "Cancelar",
    inputValidator: (valor) =>
      !valor ? "Informe uma data futura." : undefined,
  }).then((resultado) => {
    if (!resultado.isConfirmed) return;
    fetchComAuth(
      `${API_URL}/api/admin/estabelecimentos/${encodeURIComponent(establishmentId)}/assinatura`,
      {
        method: "PUT",
        body: JSON.stringify({ vence_em: `${resultado.value}T23:59:59.999Z` }),
      },
    )
      .then(() => carregarAssinaturas())
      .catch((err) => Swal.fire("Erro", err.message, "error"));
  });
}

function carregarMercadoPagoVendly() {
  return fetchComAuth(`${API_URL}/api/admin/configuracoes/mercadopago-vendly`)
    .then((dados) => {
      const token = document.getElementById("statusVendlyMercadoPagoToken");
      const secret = document.getElementById("statusVendlyMercadoPagoSecret");
      if (token)
        token.textContent = dados.access_token_configurado
          ? "🔒 Credencial configurada"
          : "⚠️ Credencial não configurada";
      if (secret)
        secret.textContent = dados.webhook_secret_configurado
          ? "🔒 Chave configurada"
          : "⚠️ Chave não configurada";
      document.getElementById("vendlyMercadoPagoToken").value = "";
      document.getElementById("vendlyMercadoPagoSecret").value = "";
    })
    .catch((err) =>
      console.error("Erro ao carregar configuração Mercado Pago Vendly:", err),
    );
}

function salvarMercadoPagoVendly() {
  const accessToken =
    document.getElementById("vendlyMercadoPagoToken")?.value || "";
  const webhookSecret =
    document.getElementById("vendlyMercadoPagoSecret")?.value || "";
  if (!accessToken.trim() && !webhookSecret.trim()) {
    Swal.fire("Atenção", "Informe ao menos uma credencial.", "warning");
    return;
  }

  fetchComAuth(`${API_URL}/api/admin/configuracoes/mercadopago-vendly`, {
    method: "PUT",
    body: JSON.stringify({
      access_token: accessToken,
      webhook_secret: webhookSecret,
    }),
  })
    .then((res) => {
      document.getElementById("vendlyMercadoPagoToken").value = "";
      document.getElementById("vendlyMercadoPagoSecret").value = "";
      Swal.fire("Sucesso", res.mensagem, "success");
      return carregarMercadoPagoVendly();
    })
    .catch((err) => Swal.fire("Erro", err.message, "error"));
}

const PLANOS_PADRAO_LANDING = [
  {
    id: "basico",
    nome: "Plano Básico",
    preco: 49.9,
    destaque: false,
    recursos: [
      "Cardápio digital online",
      "Gestão de pedidos em tempo real",
      "Cadastro ilimitado de produtos e categorias",
      "Configuração de horários de funcionamento",
      "Link personalizado da loja",
      "❌ Pix automático Mercado Pago",
      "❌ Relatórios avançados de faturamento",
    ],
  },
  {
    id: "premium",
    nome: "Plano Premium",
    preco: 89.9,
    destaque: true,
    recursos: [
      "Tudo do Plano Básico",
      "Pagamento via Pix automático (Mercado Pago)",
      "Banners promocionais no cardápio",
      "Relatórios de faturamento",
      "Notificações sonoras de pedidos",
      "❌ Suporte prioritário 24/7",
    ],
  },
  {
    id: "full",
    nome: "Plano Full",
    preco: 139.9,
    destaque: false,
    recursos: [
      "Tudo do Plano Premium",
      "Integração completa e sem limites",
      "Relatórios e métricas completas",
      "Suporte prioritário via WhatsApp",
      "Múltiplos administradores",
      "Acesso antecipado a novos recursos",
    ],
  },
];

function preencherFormularioPlanosLanding(dados) {
  const planosRecebidos = Array.isArray(dados?.planos) ? dados.planos : [];
  const oferta = dados?.oferta || {};

  const mapaIds = { basico: "Basico", premium: "Premium", full: "Full" };

  ["basico", "premium", "full"].forEach((id) => {
    const planoEncontrado = planosRecebidos.find((p) => p.id === id);
    const planoPadrao = PLANOS_PADRAO_LANDING.find((p) => p.id === id);
    const plano = planoEncontrado || planoPadrao;

    const sufixo = mapaIds[id];
    if (!sufixo || !plano) return;

    const nomeEl = document.getElementById(`plano${sufixo}Nome`);
    const precoEl = document.getElementById(`plano${sufixo}Preco`);
    const recursosEl = document.getElementById(`plano${sufixo}Recursos`);
    const destaqueEl = document.getElementById(`plano${sufixo}Destaque`);

    if (nomeEl) nomeEl.value = plano.nome || "";
    if (precoEl) precoEl.value = plano.preco ?? "";
    if (recursosEl)
      recursosEl.value = Array.isArray(plano.recursos)
        ? plano.recursos.join("\n")
        : "";
    if (destaqueEl) destaqueEl.checked = !!plano.destaque;
  });

  const ofertaAtivaEl = document.getElementById("ofertaAtiva");
  const ofertaPlanoIdEl = document.getElementById("ofertaPlanoId");
  const ofertaTextoEl = document.getElementById("ofertaTexto");
  const ofertaPrecoOriginalEl = document.getElementById("ofertaPrecoOriginal");
  const ofertaPrecoComDescontoEl = document.getElementById(
    "ofertaPrecoComDesconto",
  );
  const ofertaPercentualDescontoEl = document.getElementById(
    "ofertaPercentualDesconto",
  );

  if (ofertaAtivaEl) ofertaAtivaEl.checked = !!oferta.ativa;
  if (ofertaPlanoIdEl) ofertaPlanoIdEl.value = oferta.planoId || "full";
  if (ofertaTextoEl) ofertaTextoEl.value = oferta.texto || "";
  if (ofertaPrecoOriginalEl)
    ofertaPrecoOriginalEl.value = oferta.precoOriginal ?? "";
  if (ofertaPrecoComDescontoEl)
    ofertaPrecoComDescontoEl.value = oferta.precoComDesconto ?? "";
  if (ofertaPercentualDescontoEl)
    ofertaPercentualDescontoEl.value = oferta.percentualDesconto ?? "";

  const whatsappNumeroEl = document.getElementById("whatsappNumero");
  if (whatsappNumeroEl) whatsappNumeroEl.value = dados?.whatsappNumero || "";

  atualizarCalculoOfertaAnual();
}

function atualizarCalculoOfertaAnual() {
  const planoIdEl = document.getElementById("ofertaPlanoId");
  const percentualEl = document.getElementById("ofertaPercentualDesconto");
  const precoOriginalEl = document.getElementById("ofertaPrecoOriginal");
  const precoComDescontoEl = document.getElementById("ofertaPrecoComDesconto");
  const previewEl = document.getElementById("ofertaPreviewResumo");
  const textoEl = document.getElementById("ofertaTexto");

  if (!planoIdEl) return;

  const planoId = planoIdEl.value || "full";
  const mapaIds = { basico: "Basico", premium: "Premium", full: "Full" };
  const sufixo = mapaIds[planoId] || "Full";

  const precoMensalInput = document.getElementById(`plano${sufixo}Preco`);
  const nomeInput = document.getElementById(`plano${sufixo}Nome`);

  const precoMensal = Number(precoMensalInput?.value) || 0;
  const nomePlano = nomeInput?.value?.trim() || `Plano ${sufixo}`;

  // Cálculo de 12 meses
  const precoAnualOriginal = precoMensal * 12;
  const percentualDesconto = Math.min(
    100,
    Math.max(0, Number(percentualEl?.value) || 0),
  );

  const valorDesconto = precoAnualOriginal * (percentualDesconto / 100);
  const precoAnualComDesconto = precoAnualOriginal - valorDesconto;
  const economia = valorDesconto;

  if (precoOriginalEl) {
    precoOriginalEl.value =
      precoAnualOriginal > 0 ? precoAnualOriginal.toFixed(2) : "";
  }
  if (precoComDescontoEl) {
    precoComDescontoEl.value =
      precoAnualComDesconto > 0 ? precoAnualComDesconto.toFixed(2) : "";
  }

  if (previewEl) {
    function formatar(val) {
      return Number(val || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    const textoOferta = textoEl?.value?.trim() || "Oferta anual";

    if (precoMensal > 0) {
      previewEl.replaceChildren();
      const caixa = criarEl("div", {
        classe: "oferta-preview-box",
        estilo:
          "background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 14px; margin-top: 10px;",
      });
      caixa.appendChild(
        criarEl("div", {
          texto: "📢 Prévia do Cálculo Anual (12 Meses):",
          estilo:
            "font-weight: 700; color: #a5b4fc; margin-bottom: 6px; font-size: 0.95rem;",
        }),
      );
      caixa.appendChild(
        criarEl("div", {
          estilo: "color: #e2e8f0; font-size: 0.95rem; line-height: 1.5;",
          filhos: [
            criarEl("strong", { texto: `${textoOferta} ${nomePlano}:` }),
            document.createTextNode(" de "),
            criarEl("s", { texto: `R$ ${formatar(precoAnualOriginal)}` }),
            document.createTextNode(" por "),
            criarEl("strong", {
              texto: `R$ ${formatar(precoAnualComDesconto)}`,
              estilo: "color: #4ade80;",
            }),
          ],
        }),
      );
      caixa.appendChild(
        criarEl("div", {
          estilo:
            "color: #38bdf8; font-size: 0.88rem; font-weight: 600; margin-top: 6px;",
          filhos: [
            document.createTextNode("🎉 O cliente economiza "),
            criarEl("strong", { texto: `R$ ${formatar(economia)}` }),
            document.createTextNode(
              ` no plano de 12 meses (${Number(percentualDesconto)}% OFF)`,
            ),
          ],
        }),
      );
      previewEl.appendChild(caixa);
    } else {
      previewEl.replaceChildren();
    }
  }
}

function carregarPlanosLanding() {
  return fetchComAuth(`${API_URL}/api/planos-landing`)
    .then((dados) => preencherFormularioPlanosLanding(dados))
    .catch((err) =>
      Swal.fire(
        "Erro",
        err.message || "Não foi possível carregar os planos.",
        "error",
      ),
    );
}

function lerRecursos(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return el.value
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0);
}

function montarPayloadPlanosLanding() {
  const planos = [
    {
      id: "basico",
      nome: document.getElementById("planoBasicoNome").value.trim(),
      preco: Number(document.getElementById("planoBasicoPreco").value) || 0,
      destaque: document.getElementById("planoBasicoDestaque").checked,
      recursos: lerRecursos("planoBasicoRecursos"),
    },
    {
      id: "premium",
      nome: document.getElementById("planoPremiumNome").value.trim(),
      preco: Number(document.getElementById("planoPremiumPreco").value) || 0,
      destaque: document.getElementById("planoPremiumDestaque").checked,
      recursos: lerRecursos("planoPremiumRecursos"),
    },
    {
      id: "full",
      nome: document.getElementById("planoFullNome").value.trim(),
      preco: Number(document.getElementById("planoFullPreco").value) || 0,
      destaque: document.getElementById("planoFullDestaque").checked,
      recursos: lerRecursos("planoFullRecursos"),
    },
  ];

  const percentualBruto = document.getElementById(
    "ofertaPercentualDesconto",
  ).value;
  const precoOriginalBruto = document.getElementById(
    "ofertaPrecoOriginal",
  ).value;
  const precoComDescontoBruto = document.getElementById(
    "ofertaPrecoComDesconto",
  ).value;

  const oferta = {
    ativa: document.getElementById("ofertaAtiva").checked,
    planoId: document.getElementById("ofertaPlanoId").value,
    texto: document.getElementById("ofertaTexto").value.trim(),
    precoOriginal:
      precoOriginalBruto === "" ? null : Number(precoOriginalBruto),
    precoComDesconto:
      precoComDescontoBruto === "" ? null : Number(precoComDescontoBruto),
    percentualDesconto: percentualBruto === "" ? null : Number(percentualBruto),
  };

  const whatsappNumero = document
    .getElementById("whatsappNumero")
    .value.trim()
    .replace(/\D/g, "");

  return { planos, oferta, whatsappNumero };
}

function salvarPlanosLanding() {
  const payload = montarPayloadPlanosLanding();

  const nomesVazios = payload.planos.some((p) => !p.nome);
  if (nomesVazios) {
    Swal.fire("Erro", "Todos os planos precisam de um nome.", "error");
    return;
  }

  Swal.fire({
    title: "Salvando alterações...",
    allowOutsideClick: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetchComAuth(`${API_URL}/api/planos-landing`, {
    method: "PUT",
    body: JSON.stringify(payload),
  })
    .then((res) => {
      // Atualiza o formulário com os valores oficiais calculados pelo backend
      if (res.planos && res.oferta) {
        preencherFormularioPlanosLanding(res);
      }
      Swal.fire(
        "Sucesso!",
        res.mensagem || "Planos atualizados com sucesso.",
        "success",
      );
    })
    .catch((err) => {
      const detalhes = Array.isArray(err.detalhes)
        ? `\n\n${err.detalhes.map(String).join("\n")}`
        : "";
      Swal.fire({
        icon: "error",
        title: "Erro",
        text: (err.message || "Não foi possível salvar os planos.") + detalhes,
      });
    });
}

function abrirModalCriarAdmin() {
  const modalEl = document.getElementById("modalCriarAdmin");
  if (modalEl) {
    const form = document.getElementById("formCriarAdmin");
    if (form) form.reset(); // Limpa dados anteriores
    atualizarCamposRoleAdmin();
    modalEl.classList.add("active");
  }
}

function abrirModalEditarPlano(adminId, planoAtual) {
  const modalEl = document.getElementById("modalEditarPlano");
  const planoSelect = document.getElementById("editarAdminPlano");
  const adminIdInput = document.getElementById("editarAdminId");

  if (planoSelect) {
    planoSelect.value = planoAtual || "barato";
  }
  if (adminIdInput) {
    adminIdInput.value = adminId;
  }
  if (modalEl) {
    modalEl.classList.add("active");
  }
}

function fecharModalEditarPlano() {
  const modalEl = document.getElementById("modalEditarPlano");
  if (modalEl) {
    modalEl.classList.remove("active");
  }
}

function salvarPlanoAdmin() {
  const adminId = document.getElementById("editarAdminId").value;
  const plan = document.getElementById("editarAdminPlano").value;

  if (!adminId || !plan) {
    Swal.fire("Erro", "ID do administrador ou plano inválido.", "error");
    return;
  }

  Swal.fire({
    title: "Atualizando plano...",
    allowOutsideClick: false,
    didOpen: () => {
      Swal.showLoading();
    },
  });

  fetchComAuth(`${API_URL}/api/admin/${encodeURIComponent(adminId)}/plan`, {
    method: "PUT",
    body: JSON.stringify({ plan }),
  })
    .then((res) => {
      Swal.fire("Sucesso!", res.mensagem || "Plano atualizado.", "success");
      fecharModalEditarPlano();
      carregarAdmins();
    })
    .catch((err) =>
      Swal.fire(
        "Erro",
        err.message || "Não foi possível atualizar o plano.",
        "error",
      ),
    );
}

function fecharModalAdmin() {
  const modalEl = document.getElementById("modalCriarAdmin");
  if (modalEl) {
    modalEl.classList.remove("active");
  }
}

function abrirModalAdmin() {
  abrirModalCriarAdmin();
}

const modal = document.getElementById("modalCriarAdmin");

modal.addEventListener("click", function () {
  fecharModalAdmin();
});

function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");

  if (!sidebar) return;

  sidebar.classList.toggle("active");
}

window.toggleSidebar = toggleSidebar;
window.abrirModalEditarPlano = abrirModalEditarPlano;
window.fecharModalEditarPlano = fecharModalEditarPlano;
window.salvarPlanoAdmin = salvarPlanoAdmin;
window.salvarMercadoPagoVendly = salvarMercadoPagoVendly;
window.alterarAssinaturaManual = alterarAssinaturaManual;
window.definirVencimentoAssinatura = definirVencimentoAssinatura;

function alternarStatusAdmin(id, ativo) {
  fetchComAuth(`${API_URL}/api/admin/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ active: !ativo }),
  })
    .then((res) => {
      Swal.fire("Sucesso!", res.mensagem, "success");
      carregarAdmins();
    })
    .catch((err) => Swal.fire("Erro", err.message, "error"));
}

function alternarStatusLoja(id, statusAtual) {
  const novoStatus = statusAtual === "active" ? "suspended" : "active";
  fetchComAuth(`${API_URL}/api/estabelecimentos/${id}/dados`, {
    method: "PUT",
    body: JSON.stringify({ status: novoStatus }),
  })
    .then((res) => {
      Swal.fire("Sucesso!", res.mensagem, "success");
      carregarEstabelecimentos();
    })
    .catch((err) => Swal.fire("Erro", err.message, "error"));
}

function abrirModalPlano(lojaId, planoAtual) {
  document.getElementById("modalPlanoLojaId").value = lojaId;
  document.getElementById("modalPlanoSelect").value = planoAtual;
  const modal = new bootstrap.Modal(document.getElementById("modalPlano"));
  modal.show();
}

function salvarPlano() {
  const id = document.getElementById("modalPlanoLojaId").value;
  const plan = document.getElementById("modalPlanoSelect").value;

  fetchComAuth(`${API_URL}/api/estabelecimentos/${id}/dados`, {
    method: "PUT",
    body: JSON.stringify({ plan }),
  })
    .then((res) => {
      Swal.fire("Sucesso!", res.mensagem, "success");
      const modalEl = document.getElementById("modalPlano");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
      carregarEstabelecimentos();
    })
    .catch((err) => Swal.fire("Erro", err.message, "error"));
}

const MSG_NOME_DUPLICADO =
  "Este nome de estabelecimento já está em uso. Escolha outro nome.";

function atualizarCamposRoleAdmin() {
  const role =
    document.querySelector('input[name="role"]:checked')?.value || "admin";
  const ehAdmin = role === "admin";
  const grupo = document.getElementById("grupoEstabelecimentoAdmin");
  const nome = document.getElementById("adminEstabelecimento");
  const plano = document.getElementById("adminPlano");

  if (grupo) grupo.style.display = ehAdmin ? "" : "none";
  if (nome) {
    nome.disabled = !ehAdmin;
    nome.required = ehAdmin;
  }
  if (plano) plano.disabled = !ehAdmin;
}

let criandoAdmin = false;

function criarAdmin(e) {
  e.preventDefault();
  if (criandoAdmin) return;

  const email = document.getElementById("adminEmail").value.trim();
  const senha = document.getElementById("adminSenha").value;
  const roleRadio = document.querySelector('input[name="role"]:checked');
  const role = roleRadio ? roleRadio.value : "admin";
  const payload = { email, senha, role };

  if (role === "admin") {
    const establishmentName = document
      .getElementById("adminEstabelecimento")
      .value.trim();
    if (!establishmentName) {
      Swal.fire("Atenção", "Informe o nome do estabelecimento.", "warning");
      return;
    }
    payload.establishmentName = establishmentName;
    payload.plan = document.getElementById("adminPlano")?.value || "barato";
  }

  criandoAdmin = true;
  fetchComAuth(`${API_URL}/api/admin/register`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
    .then((res) => {
      Swal.fire("Sucesso!", res.mensagem, "success");
      document.getElementById("formCriarAdmin").reset();
      atualizarCamposRoleAdmin();
      fecharModalAdmin();
      return Promise.allSettled([carregarAdmins(), carregarEstabelecimentos()]);
    })
    .catch((err) => {
      if (err === "Sessão inválida") return;
      // O formulário permanece aberto e preenchido para correção.
      const msg = /já está em uso/i.test(err.message || "")
        ? MSG_NOME_DUPLICADO
        : err.message || "Não foi possível criar o administrador.";
      Swal.fire("Erro", msg, "error");
    })
    .finally(() => {
      criandoAdmin = false;
    });
}

function processarSolicitacao(id, acao) {
  const statusLoja = acao === "aprovar" ? "active" : "rejected";
  fetchComAuth(`${API_URL}/api/estabelecimentos/${id}/dados`, {
    method: "PUT",
    body: JSON.stringify({ status: statusLoja }),
  })
    .then((res) => {
      Swal.fire("Sucesso!", "Solicitação processada com sucesso!", "success");
      carregarSolicitacoes();
      carregarEstabelecimentos();
      carregarAdmins();
    })
    .catch((err) => Swal.fire("Erro", err.message, "error"));
}

function logout() {
  Swal.fire({
    title: "Sair do sistema?",
    text: "Você precisará fazer login novamente.",
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Sim, sair",
    cancelButtonText: "Cancelar",
  }).then((result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: "Saindo...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
    });

    const csrfToken = localStorage.getItem("csrfToken");

    fetch(`${API_URL}/api/admin/logout`, {
      method: "POST",
      credentials: "include",
      headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
    }).finally(() => {
      localStorage.clear();
      setTimeout(() => {
        window.location.href = "login.html";
      }, 1000);
    });
  });
}

verificarSuperAdmin();

window.addEventListener("DOMContentLoaded", () => {
  const formAdmin = document.getElementById("formCriarAdmin");
  if (formAdmin) {
    formAdmin.addEventListener("submit", criarAdmin);
    formAdmin
      .querySelectorAll('input[name="role"]')
      .forEach((r) => r.addEventListener("change", atualizarCamposRoleAdmin));
    atualizarCamposRoleAdmin();
  }

  const idsParaRecalcular = [
    "ofertaPlanoId",
    "ofertaPercentualDesconto",
    "ofertaTexto",
    "planoBasicoPreco",
    "planoPremiumPreco",
    "planoFullPreco",
    "planoBasicoNome",
    "planoPremiumNome",
    "planoFullNome",
  ];
  idsParaRecalcular.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", atualizarCalculoOfertaAnual);
      el.addEventListener("change", atualizarCalculoOfertaAnual);
    }
  });
});

// Garante exposição global das funções injetadas nos cliques do arquivo HTML
window.logout = logout;
window.alternarStatusAdmin = alternarStatusAdmin;
window.alternarStatusLoja = alternarStatusLoja;
window.abrirModalPlano = abrirModalPlano;
window.salvarPlano = salvarPlano;
window.processarSolicitacao = processarSolicitacao;
window.setActiveMenu = setActiveMenu;
window.abrirModalCriarAdmin = abrirModalCriarAdmin;
window.fecharModalAdmin = fecharModalAdmin;
window.desbloquearAdmin = desbloquearAdmin;
window.resetarSenhaAdmin = resetarSenhaAdmin;
window.salvarPlanosLanding = salvarPlanosLanding;
