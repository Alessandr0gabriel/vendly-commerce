const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const Joi = require("joi");
const mercadopago = require("mercadopago");
const { MercadoPagoConfig, Payment } = mercadopago;
const mongoose = require("mongoose");
const xss = require("xss");

const { gerarSlug } = require("./utils/slug");
const {
  chaveNomeEstabelecimento,
  normalizarNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
  classificarErroCadastro,
  erroNomeDuplicado,
  exigirIndiceNomesPronto,
} = require("./utils/nomeEstabelecimento");
const { signInWithPassword } = require("./utils/firebaseAuthRest");
const {
  timestampParaMillis,
  calcularStatusAssinatura,
  aplicarAssinaturaPagamento,
} = require("./utils/assinatura");
const {
  valorParaCentavos,
  calcularValoresAssinatura,
  SCHEMA_CRIACAO_PIX_ASSINATURA,
} = require("./utils/precosAssinatura");
const produtoPublico = require("./utils/produtoPublico");
const deveConsumirEstoqueNaFinalizacao = require("./utils/estoquePedido");
const { reservarEstoqueDoEstabelecimento } = require("./utils/reservaEstoque");

const assinaturaTrialConfigurado = Number.parseInt(
  process.env.ASSINATURA_TRIAL_DIAS || "7",
  10,
);
const ASSINATURA_TRIAL_DIAS = Number.isFinite(assinaturaTrialConfigurado)
  ? Math.min(365, Math.max(0, assinaturaTrialConfigurado))
  : 30;

// IMPORTA DEPENDÊNCIAS QUE JÁ EXISTEM NO SERVER
module.exports = ({
  db,
  auth,
  FieldValue,
  Timestamp,
  AggregateField,
  verificarToken,
  verificarCSRF,
  verificarSuperAdmin,
  upload,
  schemaProduto,
  validarBuffer,
  uploadCloudinary,
  cloudinary,
  loginLimiter,
  logger,
  webhookLimiter,
  subscriptionPaymentLimiter,
  publicLimiter,
  validateMercadoPagoSignature,
  encryptSensitiveData,
  decryptSensitiveData,
}) => {
  const schemaPedidoPublico = Joi.object({
    itens: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().trim().required(),
          quantidade: Joi.number().integer().min(1).max(100).required(),
        }),
      )
      .min(1)
      .max(50)
      .required(),
  });
  const cookieSecure = process.env.USE_FIREBASE_EMULATOR !== "true";
  const cookieSameSite = cookieSecure ? "none" : "lax";

  const schemaPedidoSalvar = Joi.object({
    slug: Joi.string().trim().required(),
    itens: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().trim().required(),
          quantidade: Joi.number().integer().min(1).max(100).required(),
        }),
      )
      .min(1)
      .max(50)
      .required(),
    forma_pagamento: Joi.string().valid("dinheiro", "cartao", "pix").required(),
    tipo_entrega: Joi.string().trim().optional(),
    mesa: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
    nome_cliente: Joi.string().trim().max(100).optional(),
    endereco: Joi.string().trim().max(500).optional(),
    precisa_troco: Joi.boolean().optional(),
    troco_para: Joi.number().min(0).max(100000).optional(),
  });

  const schemaPedidoPixSalvar = Joi.object({
    slug: Joi.string().trim().required(),
    itens: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().trim().required(),
          quantidade: Joi.number().integer().min(1).max(100).required(),
        }),
      )
      .min(1)
      .max(50)
      .required(),
    tipo_entrega: Joi.string().trim().optional(),
    mesa: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
    nome_cliente: Joi.string().trim().max(100).optional(),
    endereco: Joi.string().trim().max(500).optional(),
    payer_email: Joi.string().email().trim().required(),
  });

  // Helper: calcula o campo "esgotado" que antes vinha de um CASE WHEN no SQL
  function comEsgotado(data) {
    const esgotado =
      data.controla_estoque === true && Number(data.estoque) <= 0;
    return { ...data, esgotado };
  }

  // Libera uma reserva de estoque (estoque_reservado) feita para um pedido Pix
  // que expirou, foi rejeitado/cancelado ou não chegou a gerar cobrança.
  async function liberarReservaEstoque(itens) {
    if (!Array.isArray(itens) || itens.length === 0) return;

    try {
      await db.runTransaction(async (tx) => {
        const refs = itens.map((item) =>
          db.collection("produtos").doc(String(item.id)),
        );
        const docs = await Promise.all(refs.map((ref) => tx.get(ref)));

        for (let i = 0; i < itens.length; i++) {
          const doc = docs[i];
          if (doc.exists && doc.data().controla_estoque === true) {
            tx.update(refs[i], {
              estoque_reservado: FieldValue.increment(-itens[i].quantidade),
            });
          }
        }
      });
    } catch (err) {
      logger.error("Erro ao liberar reserva de estoque", err);
    }
  }

  function normalizarPlano(plano) {
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

  function normalizarStatusPedido(status) {
    if (["pendente", "pago", "aprovado"].includes(status)) {
      return "aguardando";
    }
    if (status === "aguardando") return "aguardando";
    if (status === "a_caminho" || status === "a caminho") return "a_caminho";
    if (status === "finalizado") return "finalizado";
    if (status === "preparando") return "preparando";
    return "aguardando";
  }

  function validarAcessoEstabelecimento(req, res, establishmentId) {
    const usuarioEstablishmentId =
      req.user?.establishmentId || req.user?.establishment_id;

    if (
      req.user?.role === "superadmin" ||
      String(usuarioEstablishmentId || "") === String(establishmentId || "")
    ) {
      return true;
    }

    res.status(403).json({ mensagem: "Acesso negado ao estabelecimento." });
    return false;
  }

  function dadosEstabelecimentoPublicos(id, data) {
    return {
      id,
      nome: data.nome || null,
      slug: data.slug || null,
      banner: data.banner || null,
      status: data.status || null,
      plano: data.plano || null,
      horarios: data.horarios || null,
      telefone: data.telefone || null,
      pedidos_disponiveis:
        calcularStatusAssinatura(data.assinatura).status !== "suspensa",
    };
  }

  function responderPedidosIndisponiveis(res) {
    return res.status(403).json({
      code: "PEDIDOS_TEMPORARIAMENTE_INDISPONIVEIS",
      message:
        "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
      mensagem:
        "Este estabelecimento não está recebendo pedidos pelo cardápio online no momento.",
    });
  }

  function bloquearMercadoPagoNoModoLocal(res) {
    if (process.env.USE_FIREBASE_EMULATOR !== "true") return false;

    res.status(503).json({
      mensagem: "Pagamentos Mercado Pago estão desabilitados no modo local.",
    });
    return true;
  }

  const dashboardCache = new Map();
  const DASHBOARD_CACHE_TTL_MS = 20 * 1000;
  const dashboardPerfLog = process.env.DASHBOARD_PERF_LOG === "true";

  function dashboardCacheKey(req, establishmentId, periodo) {
    const usuarioId = req.user?.uid || req.user?.id || "desconhecido";
    const escopo = req.user?.role || "admin";
    return `${establishmentId}:${periodo}:${escopo}:${usuarioId}`;
  }

  function limparCacheDashboard(establishmentId) {
    const prefixo = `${establishmentId}:`;
    for (const chave of dashboardCache.keys()) {
      if (chave.startsWith(prefixo)) dashboardCache.delete(chave);
    }
  }

  function instrumentarMiddlewareDashboard(nome, middleware) {
    return (req, res, next) => {
      if (!dashboardPerfLog) return middleware(req, res, next);

      const inicio = process.hrtime.bigint();
      return middleware(req, res, (erro) => {
        logger.info(
          `[DASHBOARD_PERF] etapa=${nome} ms=${Number(process.hrtime.bigint() - inicio) / 1e6}`,
        );
        next(erro);
      });
    };
  }

  function verificarPlanoMinimo(planoMinimo) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ mensagem: "Sessão inválida." });
      }

      if (req.user.role === "superadmin") {
        return next();
      }

      const rank = { barato: 0, medio: 1, full: 2 };
      const planoAtual = normalizarPlano(req.user.plan || req.user.plano);
      const planoNecessario = normalizarPlano(planoMinimo);

      if ((rank[planoAtual] || 0) >= (rank[planoNecessario] || 0)) {
        return next();
      }

      return res.status(403).json({
        mensagem: "Seu plano atual não possui acesso a este recurso.",
      });
    };
  }

  async function obterStatusAssinatura(establishmentId, transaction = null) {
    const ref = db.collection("estabelecimentos").doc(String(establishmentId));
    const doc = transaction ? await transaction.get(ref) : await ref.get();
    if (!doc.exists) return null;
    return {
      ref,
      doc,
      assinatura: doc.data()?.assinatura || null,
      status: calcularStatusAssinatura(doc.data()?.assinatura),
    };
  }

  async function verificarAssinatura(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ mensagem: "Sessão inválida." });
    }
    if (req.user.role === "superadmin") return next();
    if (req.path.startsWith("/pagamentos-assinatura")) return next();
    if (
      req.path === "/admin/me/estabelecimento" ||
      req.path === "/assinatura/status"
    )
      return next();

    try {
      const establishmentId =
        req.user.establishmentId || req.user.establishment_id;
      const dados = establishmentId
        ? await obterStatusAssinatura(establishmentId)
        : null;
      if (
        !dados ||
        dados.status.status === "nao_configurada" ||
        dados.status.status !== "suspensa"
      )
        return next();
      return res.status(403).json({
        code: "ASSINATURA_SUSPENSA",
        mensagem:
          "Sua assinatura precisa ser renovada para continuar usando o Vendly.",
      });
    } catch (err) {
      logger.error("Erro ao validar assinatura do estabelecimento", err);
      return res
        .status(500)
        .json({ mensagem: "Erro interno ao validar assinatura." });
    }
  }

  router.post(
    "/admin/register",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      const { email, senha, role, establishmentName, plan } = req.body;
      const normalizedRole = role ? String(role).trim().toLowerCase() : "";
      const normalizedPlan = plan
        ? String(plan).trim().toLowerCase()
        : "barato";

      if (!email || !senha || !normalizedRole) {
        return res.status(400).json({ mensagem: "Preencha todos os campos!" });
      }

      if (!["admin", "superadmin"].includes(normalizedRole)) {
        return res
          .status(400)
          .json({ mensagem: "Role inválido. Use admin ou superadmin." });
      }

      const nomeNovoEstabelecimento =
        normalizedRole === "admin"
          ? normalizarNomeEstabelecimento(establishmentName)
          : null;
      if (normalizedRole === "admin" && !nomeNovoEstabelecimento) {
        return res.status(400).json({
          mensagem: "Informe um nome válido para o estabelecimento.",
        });
      }

      try {
        const isDefault = await isDefaultSuperAdmin(req);

        if (normalizedRole === "superadmin" && !isDefault) {
          return res.status(403).json({
            mensagem:
              "Apenas o superadmin padrão pode criar ou gerenciar outro superadmin.",
          });
        }

        let establishmentId = null;

        if (normalizedRole === "admin") {
          const chaveNome = chaveNomeEstabelecimento(
            nomeNovoEstabelecimento,
          );
          const nomeRef = referenciaReservaNome(db, chaveNome);
          const statusIndiceRef = referenciaStatusIndiceNomes(db);
          const novoEstabRef = db.collection("estabelecimentos").doc();
          const slug = gerarSlug(nomeNovoEstabelecimento);

          establishmentId = await db.runTransaction(async (tx) => {
            const [statusIndice, reservaNome] = await Promise.all([
              tx.get(statusIndiceRef),
              tx.get(nomeRef),
            ]);
            exigirIndiceNomesPronto(statusIndice);

            if (reservaNome.exists) {
              throw erroNomeDuplicado();
            }

            const slugExistente = await tx.get(
              db
                .collection("estabelecimentos")
                .where("slug", "==", slug)
                .limit(1),
            );
            if (!slugExistente.empty) {
              throw Object.assign(
                new Error(
                  "Já existe um estabelecimento com esse nome (slug duplicado)",
                ),
                { statusCode: 400 },
              );
            }

            tx.create(novoEstabRef, {
              nome: nomeNovoEstabelecimento,
              slug,
              banner: null,
              telefone: null,
              chave_pix: null,
              horarios: null,
              cor_primaria: null,
              cor_secundaria: null,
              banner_public_id: null,
              plano: normalizedPlan,
              assinatura: {
                vence_em: Timestamp.fromMillis(
                  Date.now() + ASSINATURA_TRIAL_DIAS * 86400000,
                ),
                dias_carencia: 5,
                em_teste: true,
                atualizado_em: FieldValue.serverTimestamp(),
              },
              created_at: FieldValue.serverTimestamp(),
            });
            tx.create(nomeRef, {
              establishment_id: novoEstabRef.id,
              nome_normalizado: chaveNome,
              criado_em: FieldValue.serverTimestamp(),
            });
            return novoEstabRef.id;
          });
        }

        // Quem gera e guarda o hash da senha agora é o próprio Firebase Auth
        // Compensação: só remove loja/reserva criadas por ESTA requisição,
        // e apenas se nenhum admin estiver vinculado a elas.
        const compensarEstabelecimentoCriado = async () => {
          if (normalizedRole !== "admin" || !establishmentId) return;
          try {
            const chave = chaveNomeEstabelecimento(nomeNovoEstabelecimento);
            const reservaRef = referenciaReservaNome(db, chave);
            const estabRef = db
              .collection("estabelecimentos")
              .doc(establishmentId);
            await db.runTransaction(async (tx) => {
              const [reserva, vinculos] = await Promise.all([
                tx.get(reservaRef),
                tx.get(
                  db
                    .collection("admin")
                    .where("establishment_id", "==", establishmentId)
                    .limit(1),
                ),
              ]);
              if (!vinculos.empty) return;
              if (reserva.exists && reserva.data()?.establishment_id === establishmentId) {
                tx.delete(reservaRef);
              }
              tx.delete(estabRef);
            });
          } catch (compError) {
            logger.error("Falha ao compensar estabelecimento órfão", compError);
          }
        };

        let userRecord;
        try {
          userRecord = await auth.createUser({
            email,
            password: senha,
            disabled: false,
          });
        } catch (err) {
          await compensarEstabelecimentoCriado();
          if (err.code === "auth/email-already-exists") {
            return res
              .status(400)
              .json({ mensagem: "Já existe um admin com esse email" });
          }
          throw err;
        }

        try {
          await db.collection("admin").doc(userRecord.uid).set({
            email,
            role: normalizedRole,
            establishment_id: establishmentId,
            active: true,
            plan: normalizedPlan,
            deactivated_at: null,
            tentativas_login: 0,
            bloqueado: false,
            primeiro_login: true,
            created_at: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          await auth.deleteUser(userRecord.uid).catch((delErr) => {
            logger.error("Falha ao remover usuário Auth órfão", delErr);
          });
          await compensarEstabelecimentoCriado();
          throw err;
        }

        res.json({ mensagem: "Admin criado!" });
      } catch (error) {
        const { status, corpo } = classificarErroCadastro(error);
        if (status >= 500) {
          logger.error("Erro ao criar admin", error);
        } else {
          logger.warn(
            `Cadastro de admin recusado: ${corpo.code || status}`,
          );
        }
        res.status(status).json(corpo);
      }
    },
  );
  router.post("/admin/login", loginLimiter, async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res
        .status(400)
        .json({ mensagem: "E-mail e senha são obrigatórios!" });
    }

    let uid = null;

    try {
      try {
        const userRecord = await auth.getUserByEmail(email);
        uid = userRecord.uid;
      } catch (authDocErr) {
        return res.status(401).json({ mensagem: "E-mail ou senha incorreto" });
      }

      const adminDoc = await db.collection("admin").doc(uid).get();

      if (!adminDoc.exists) {
        return res
          .status(401)
          .json({ mensagem: "Usuário inválido ou sem privilégios." });
      }

      const adminData = adminDoc.data();

      if (adminData.bloqueado === true) {
        return res.status(403).json({
          mensagem:
            "Esta conta foi bloqueada devido a múltiplos erros de senha. Contate o suporte.",
        });
      }

      if (adminData.active !== true) {
        return res
          .status(401)
          .json({ mensagem: "Esta conta está desativada no momento." });
      }

      const authData = await signInWithPassword(email, senha);
      const idToken = authData.idToken;

      const expiresIn = Number(process.env.JWT_EXPIRES) || 4 * 60 * 60 * 1000;
      const sessionCookie = await auth.createSessionCookie(idToken, {
        expiresIn,
      });
      const sessionId = crypto.randomUUID();

      const cookieOptions = {
        maxAge: expiresIn,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        path: "/",
      };

      res.cookie("token", sessionCookie, cookieOptions);
      res.cookie("session-id", sessionId, cookieOptions);

      const csrfToken = crypto.randomBytes(24).toString("hex");
      res.cookie("csrf-token", csrfToken, {
        maxAge: expiresIn,
        secure: cookieSecure,
        httpOnly: false,
        sameSite: cookieSameSite,
        path: "/",
      });

      await db.collection("admin").doc(uid).update({
        tentativas_login: 0,
        bloqueado: false,
        session_id: sessionId,
      });

      const io = req.app.get("io");
      if (io) {
        for (const socket of io.sockets.sockets.values()) {
          if (socket.user?.id === uid) {
            socket.emit("sessaoEncerrada", {
              mensagem: "Sua sessão foi encerrada porque houve um novo login.",
            });
            socket.disconnect(true);
          }
        }
      }

      logger.info(`[LOGIN] Administrador '${email}' autenticado com sucesso.`);

      let plano = "barato";
      const establishmentId = adminData.establishment_id || null;

      if (establishmentId) {
        const estabDoc = await db
          .collection("estabelecimentos")
          .doc(establishmentId)
          .get();
        if (estabDoc.exists) {
          plano = estabDoc.data()?.plano || "barato";
        }
      }

      return res.json({
        mensagem: "Login sucesso",
        role: adminData.role,
        csrfToken: csrfToken,
        primeiroLogin: adminData.primeiro_login || false,
        establishmentId,
        establishmentName: adminData.establishment_name || "",
        plan: plano,
      });
    } catch (error) {
      logger.error(
        `[LOGIN] Falha na tentativa de login para '${email}'`,
        error,
      );

      if (uid) {
        try {
          const ref = db.collection("admin").doc(uid);
          const doc = await ref.get();

          if (doc.exists) {
            const atual = doc.data().tentativas_login || 0;
            const novasTentativas = atual + 1;
            const deveBloquear = novasTentativas >= 5;

            await ref.update({
              tentativas_login: novasTentativas,
              bloqueado: deveBloquear,
            });

            if (deveBloquear) {
              return res.status(403).json({
                mensagem:
                  "Conta bloqueada por excesso de tentativas falhas! Entre em contato com o suporte.",
              });
            }
          }
        } catch (dbErr) {
          logger.error(
            "Erro ao atualizar contador de tentativas no Firestore",
            dbErr,
          );
        }
      }

      return res.status(401).json({ mensagem: "E-mail ou senha incorreto" });
    }
  });

  router.post("/admin/logout", verificarCSRF, async (req, res) => {
    const sessionCookie = req.cookies.token;

    if (sessionCookie) {
      try {
        const decoded = await auth.verifySessionCookie(sessionCookie);
        await auth.revokeRefreshTokens(decoded.uid);
        await db.collection("admin").doc(decoded.uid).update({
          session_id: null,
        });
      } catch (err) {
        // cookie expirado
      }
    }

    res.clearCookie("token", {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
    });

    res.clearCookie("session-id", {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
      path: "/",
    });

    res.clearCookie("csrf-token", {
      secure: cookieSecure,
      httpOnly: false,
      sameSite: cookieSameSite,
      path: "/",
    });

    return res.json({ mensagem: "Logout realizado com sucesso" });
  });

  router.get("/admin/me", verificarToken, verificarCSRF, async (req, res) => {
    res.json({
      id: req.user.uid,
      role: req.user.role,
      establishmentId: req.user.establishmentId,
      isDefaultSuperAdmin: await isDefaultSuperAdmin({ user: req.user }),
    });
  });

  async function isDefaultSuperAdmin(req) {
    const defaultEmail = String(process.env.DEFAULT_SUPERADMIN_EMAIL || "")
      .trim()
      .toLowerCase();

    if (!defaultEmail) return false;

    const currentEmail = String(req.user?.email || "")
      .trim()
      .toLowerCase();

    if (currentEmail && currentEmail === defaultEmail) {
      return true;
    }

    const currentUid = req.user?.uid || req.user?.id;
    if (!currentUid) return false;

    try {
      const adminDoc = await db.collection("admin").doc(currentUid).get();
      const adminEmail = String(adminDoc.data()?.email || "")
        .trim()
        .toLowerCase();

      return adminEmail === defaultEmail;
    } catch (err) {
      logger.error("Erro ao verificar superadmin padrão", err);
      return false;
    }
  }

  function verificarSuperAdminPadrao(req, res, next) {
    isDefaultSuperAdmin(req)
      .then((isDefault) => {
        if (!isDefault) {
          return res.status(403).json({
            mensagem: "Acesso permitido apenas ao superadmin padrão.",
          });
        }
        next();
      })
      .catch((err) => {
        logger.error("Erro ao validar superadmin padrão", err);
        res.status(403).json({ mensagem: "Acesso negado." });
      });
  }

  const schemaConfiguracaoMercadoPagoVendly = Joi.object({
    access_token: Joi.string().trim().max(500).allow("").optional(),
    webhook_secret: Joi.string().trim().max(500).allow("").optional(),
  }).unknown(false);

  router.get(
    "/admin/configuracoes/mercadopago-vendly",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    verificarSuperAdminPadrao,
    async (req, res) => {
      try {
        const doc = await db
          .collection("configuracoes")
          .doc("pagamentos_vendly")
          .get();
        const dados = doc.exists ? doc.data() : {};
        return res.json({
          access_token_configurado: Boolean(dados.mercadopago_access_token),
          webhook_secret_configurado: Boolean(dados.mercadopago_webhook_secret),
        });
      } catch (err) {
        logger.error("Erro ao consultar configuração Mercado Pago Vendly", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao consultar configuração." });
      }
    },
  );

  router.put(
    "/admin/configuracoes/mercadopago-vendly",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    verificarSuperAdminPadrao,
    async (req, res) => {
      const { error, value } = schemaConfiguracaoMercadoPagoVendly.validate(
        req.body,
      );
      if (error)
        return res
          .status(400)
          .json({ mensagem: "Dados de configuração inválidos." });

      const updateData = {
        atualizado_em: FieldValue.serverTimestamp(),
        atualizado_por: req.user.uid,
      };

      try {
        if (value.access_token) {
          if (!/^(TEST-|APP_USR-)/i.test(value.access_token)) {
            return res
              .status(400)
              .json({ mensagem: "Access Token Mercado Pago inválido." });
          }
          updateData.mercadopago_access_token = encryptSensitiveData(
            value.access_token,
          );
        }

        if (value.webhook_secret) {
          if (
            value.webhook_secret.length < 10 ||
            /^[\-_*•.]+$/.test(value.webhook_secret)
          ) {
            return res
              .status(400)
              .json({ mensagem: "Chave secreta do webhook inválida." });
          }
          updateData.mercadopago_webhook_secret = encryptSensitiveData(
            value.webhook_secret,
          );
        }

        if (Object.keys(updateData).length === 2) {
          return res
            .status(400)
            .json({ mensagem: "Informe ao menos uma credencial." });
        }

        await db
          .collection("configuracoes")
          .doc("pagamentos_vendly")
          .set(updateData, { merge: true });
        await db.collection("auditoria_admin").add({
          acao: "mercadopago_vendly_configurado",
          realizado_por: req.user.uid,
          realizado_em: FieldValue.serverTimestamp(),
        });
        logger.info(
          "Configuração Mercado Pago Vendly atualizada pelo superadmin padrão",
        );
        return res.json({
          mensagem: "Credenciais Mercado Pago Vendly salvas com sucesso.",
        });
      } catch (err) {
        logger.error("Erro ao salvar configuração Mercado Pago Vendly", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao salvar configuração." });
      }
    },
  );

  // Apenas o superadmin padrão pode alterar dados de outro superadmin.
  // O próprio superadmin pode mexer na própria conta, e o superadmin padrão pode
  // remover/editar outro superadmin quando houver necessidade administrativa.
  async function protegerOutroSuperAdmin(req, res, alvoId, alvoData) {
    const meuId = req.user?.id || req.user?.uid;
    const alvoRole = String(alvoData?.role || "")
      .trim()
      .toLowerCase();
    const ehDefault = await isDefaultSuperAdmin(req);

    if (alvoRole === "superadmin" && alvoId !== meuId && !ehDefault) {
      res.status(403).json({
        mensagem:
          "Apenas o superadmin padrão pode alterar os dados de outro superadmin.",
      });
      return true;
    }

    return false;
  }

  // Plano vive em estabelecimentos.plano e em admin.plan (espelho exibido na
  // listagem). Ambos são gravados na mesma transação Firestore.
  async function atualizarEstabelecimentoComPlano(
    estabelecimentoId,
    updateData,
    plan,
    adminRef = null,
  ) {
    const estabRef = db.collection("estabelecimentos").doc(estabelecimentoId);
    await db.runTransaction(async (tx) => {
      const estabSnap = await tx.get(estabRef);
      if (!estabSnap.exists) {
        const err = new Error("Estabelecimento não encontrado");
        err.statusCode = 404;
        throw err;
      }
      const admins = await tx.get(
        db
          .collection("admin")
          .where("establishment_id", "==", estabelecimentoId),
      );
      if (adminRef) {
        const alvo = await tx.get(adminRef);
        if (!alvo.exists) {
          const err = new Error("Admin não encontrado");
          err.statusCode = 404;
          throw err;
        }
      }

      tx.update(estabRef, { ...updateData, plano: plan });
      for (const doc of admins.docs) tx.update(doc.ref, { plan });
    });
  }

  router.put(
    "/admin/desbloquear/:id",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      const { id } = req.params;

      try {
        const ref = db.collection("admin").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Admin não encontrado" });
        }

        if (await protegerOutroSuperAdmin(req, res, id, doc.data())) return;

        await ref.update({ bloqueado: false, tentativas_login: 0 });

        res.json({ mensagem: "Conta desbloqueada com sucesso" });
      } catch (err) {
        logger.error("Erro ao desbloquear", err);
        res.status(500).json({ mensagem: "Erro ao desbloquear" });
      }
    },
  );
  router.put(
    "/auth/primeiro-acesso",
    verificarToken,
    verificarCSRF,
    async (req, res) => {
      try {
        const { novaSenha } = req.body;

        const userId = req.user?.id || req.user?.uid;
        const email = req.user?.email;

        if (!userId) {
          return res.status(401).json({
            mensagem: "Identificação do usuário inválida na sessão atual.",
          });
        }

        if (!novaSenha || String(novaSenha).trim().length < 8) {
          return res.status(400).json({
            mensagem:
              "A nova senha é obrigatória e deve conter pelo menos 8 caracteres.",
          });
        }

        const senhaTrim = novaSenha.trim();
        await auth.updateUser(userId, { password: senhaTrim });

        await db.collection("admin").doc(userId).update({
          primeiro_login: false,
        });

        // Trocar a senha invalida a sessão atual no Firebase (validSince avança).
        // Reautenticamos aqui mesmo para não jogar o admin de volta pro login.
        let novoCsrfToken = null;
        try {
          const authData = await signInWithPassword(email, senhaTrim);
          const idToken = authData.idToken;
          const expiresIn =
            Number(process.env.JWT_EXPIRES) || 4 * 60 * 60 * 1000;
          const sessionCookie = await auth.createSessionCookie(idToken, {
            expiresIn,
          });
          const sessionId = crypto.randomUUID();

          const cookieOptions = {
            maxAge: expiresIn,
            httpOnly: true,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            path: "/",
          };

          res.cookie("token", sessionCookie, cookieOptions);
          res.cookie("session-id", sessionId, cookieOptions);

          novoCsrfToken = crypto.randomBytes(24).toString("hex");
          res.cookie("csrf-token", novoCsrfToken, {
            maxAge: expiresIn,
            secure: cookieSecure,
            httpOnly: false,
            sameSite: cookieSameSite,
            path: "/",
          });

          await db.collection("admin").doc(userId).update({
            session_id: sessionId,
          });
        } catch (reauthErr) {
          logger.error(
            "Erro ao reautenticar após troca de senha no primeiro acesso",
            reauthErr,
          );
          // Mesmo se a reautenticação falhar, a senha já foi trocada com sucesso.
          // O frontend vai simplesmente pedir um novo login nesse caso raro.
        }

        res.json({
          mensagem: "Senha atualizada com sucesso!",
          csrfToken: novoCsrfToken,
        });
      } catch (err) {
        logger.error("Erro ao trocar senha no primeiro acesso:", err);
        res.status(500).json({
          mensagem: "Erro interno no servidor ao processar a troca de senha.",
        });
      }
    },
  );

  router.get("/admin/check-token", verificarToken, (req, res) => {
    res.json({ valid: true, user: req.user });
  });

  // Limpeza de admins inativos há mais de 7 dias, separada da listagem.
  // Por padrão apenas simula (dry-run); a exclusão exige dryRun:false explícito.
  router.post(
    "/admin/inativos/limpeza",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    verificarSuperAdminPadrao,
    async (req, res) => {
      const { error, value } = Joi.object({
        dryRun: Joi.boolean().strict().default(true),
        confirmar: Joi.string().valid("EXCLUIR_DEFINITIVAMENTE"),
      })
        .unknown(false)
        .validate(req.body || {});
      if (error) {
        return res.status(400).json({ mensagem: "Parâmetros inválidos." });
      }
      if (value.dryRun === false && !value.confirmar) {
        return res.status(400).json({
          mensagem:
            'A exclusão real exige confirmar: "EXCLUIR_DEFINITIVAMENTE".',
        });
      }

      try {
        const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const cutoff = Timestamp.fromMillis(limite);
        const emailPadrao = String(process.env.DEFAULT_SUPERADMIN_EMAIL || "")
          .trim()
          .toLowerCase();
        const expirados = await db
          .collection("admin")
          .where("active", "==", false)
          .where("deactivated_at", "<", cutoff)
          .get();

        const alvos = expirados.docs.filter((doc) => {
          const d = doc.data();
          return (
            d.role !== "superadmin" &&
            doc.id !== req.user.uid &&
            !(emailPadrao && String(d.email || "").toLowerCase() === emailPadrao)
          );
        });
        const estabelecimentosAfetados = [
          ...new Set(
            alvos.map((d) => d.data().establishment_id).filter(Boolean),
          ),
        ];

        if (value.dryRun) {
          return res.json({
            dryRun: true,
            total: alvos.length,
            ids: alvos.map((d) => d.id),
            estabelecimentos_preservados: estabelecimentosAfetados,
          });
        }

        let removidos = 0;
        const falhas = [];
        for (const doc of alvos) {
          try {
            // Reconfere logo antes de excluir (reativação concorrente).
            const atual = await doc.ref.get();
            const dados = atual.data();
            if (
              !atual.exists ||
              dados.active !== false ||
              !dados.deactivated_at ||
              dados.deactivated_at.toMillis() >= limite
            ) {
              continue;
            }
            try {
              await auth.deleteUser(doc.id);
            } catch (err) {
              if (err?.code !== "auth/user-not-found") throw err;
            }
            // Se a exclusão no Firestore falhar, o Auth já não existe e a
            // próxima execução conclui a remoção (user-not-found é tolerado).
            await doc.ref.delete();
            removidos++;
          } catch (err) {
            logger.error("Erro ao remover admin inativo", {
              id: doc.id,
              code: err?.code,
            });
            falhas.push(doc.id);
          }
        }
        res.status(falhas.length ? 207 : 200).json({
          dryRun: false,
          total: alvos.length,
          removidos,
          falhas,
          estabelecimentos_preservados: estabelecimentosAfetados,
        });
      } catch (err) {
        logger.error("Erro na limpeza de admins inativos", {
          message: err?.message,
        });
        res.status(500).json({ mensagem: "Erro interno." });
      }
    },
  );

  router.get(
    "/admin/list",
    verificarToken,
    verificarSuperAdmin,
    async (req, res) => {
      try {
        const snap = await db.collection("admin").get();
        const estabCache = new Map();

        const admins = await Promise.all(
          snap.docs.map(async (doc) => {
            const data = doc.data();
            let establishment_name = null;

            if (data.establishment_id) {
              if (!estabCache.has(data.establishment_id)) {
                const estabDoc = await db
                  .collection("estabelecimentos")
                  .doc(data.establishment_id)
                  .get();

                estabCache.set(
                  data.establishment_id,
                  estabDoc.exists ? estabDoc.data().nome : null,
                );
              }

              establishment_name = estabCache.get(data.establishment_id);
            }

            return {
              id: doc.id,
              email: data.email,
              role: data.role,
              active: data.active,
              bloqueado: data.bloqueado,
              tentativas_login: data.tentativas_login,
              deactivated_at: data.deactivated_at
                ? data.deactivated_at.toDate()
                : null,
              establishment_name,
              plan: data.plan || "barato",
              establishment_id: data.establishment_id || null,
            };
          }),
        );

        res.json({ admins });
      } catch (err) {
        logger.error("Erro ao carregar admins", err);
        res.status(500).json({ mensagem: "Erro ao carregar admins" });
      }
    },
  );

  router.patch(
    "/admin/:id/status",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      const { id } = req.params;
      const { active } = req.body;

      if (typeof active !== "boolean") {
        return res.status(400).json({ mensagem: "Valor 'active' inválido" });
      }

      try {
        const ref = db.collection("admin").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Admin não encontrado" });
        }

        if (await protegerOutroSuperAdmin(req, res, id, doc.data())) return;

        const dadosAtuais = doc.data();
        const valorAnteriorAtivo = dadosAtuais.active;
        const desativadoAnterior = dadosAtuais.deactivated_at || null;

        let usuarioAuth = null;
        try {
          usuarioAuth = await auth.getUser(id);
        } catch (authError) {
          if (authError?.code !== "auth/user-not-found") {
            logger.error("Erro ao consultar usuário no Firebase Auth", {
              id,
              code: authError?.code,
            });
            return res.status(502).json({
              mensagem:
                "Não foi possível consultar o Firebase Auth. Nada foi alterado.",
            });
          }
          if (active) {
            return res.status(409).json({
              mensagem:
                "Conta inexistente no Firebase Auth. Não é possível reativar.",
            });
          }
        }

        const dadosFirestore = {
          active,
          deactivated_at: active ? null : FieldValue.serverTimestamp(),
        };
        const parcial = (detalhe) =>
          res.status(502).json({
            mensagem: `Falha parcial: ${detalhe} Repita a operação para reconciliar.`,
            code: "STATUS_PARCIAL",
          });

        // Ordem "fail-closed": desativar bloqueia o Auth antes do Firestore;
        // ativar libera o Firestore antes do Auth. Em qualquer falha o
        // estado intermediário nunca deixa a conta utilizável por engano.
        if (!active) {
          if (usuarioAuth) {
            try {
              await auth.updateUser(id, { disabled: true });
            } catch (authError) {
              logger.error("Falha ao desabilitar usuário no Firebase Auth", {
                id,
                code: authError?.code,
              });
              return res.status(502).json({
                mensagem:
                  "Não foi possível desativar a conta no Firebase Auth. Nada foi alterado.",
              });
            }
          }

          try {
            await ref.update(dadosFirestore);
          } catch (fsError) {
            logger.error("Falha ao gravar desativação no Firestore", {
              id,
              code: fsError?.code,
            });
            // Compensação: só reabilita se o Auth estava habilitado antes e o
            // Firestore ainda indica conta ativa. Caso contrário permanece bloqueada.
            try {
              const atual = await ref.get();
              if (
                usuarioAuth &&
                usuarioAuth.disabled !== true &&
                atual.exists &&
                atual.data().active === true
              ) {
                await auth.updateUser(id, { disabled: false });
              }
            } catch (compErr) {
              logger.error("Falha na compensação do Auth", {
                id,
                code: compErr?.code,
              });
            }
            return parcial("a desativação não foi gravada no Firestore.");
          }
          return res.json({ mensagem: "Status atualizado com sucesso" });
        }

        try {
          await ref.update(dadosFirestore);
        } catch (fsError) {
          logger.error("Falha ao gravar ativação no Firestore", {
            id,
            code: fsError?.code,
          });
          return res.status(502).json({
            mensagem: "Não foi possível ativar a conta. Nada foi alterado.",
          });
        }

        try {
          await auth.updateUser(id, { disabled: false });
        } catch (authError) {
          logger.error("Falha ao habilitar usuário no Firebase Auth", {
            id,
            code: authError?.code,
          });
          // Compensação: volta o Firestore ao estado anterior (conta bloqueada).
          try {
            await ref.update({
              active: valorAnteriorAtivo === true,
              deactivated_at: desativadoAnterior,
            });
          } catch (compErr) {
            logger.error("Falha na compensação do Firestore", {
              id,
              code: compErr?.code,
            });
          }
          return parcial("a ativação não foi concluída no Firebase Auth.");
        }

        return res.json({ mensagem: "Status atualizado com sucesso" });
      } catch (err) {
        logger.error("Erro ao atualizar status do admin", {
          message: err?.message,
        });
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao atualizar status do admin" });
      }
    },
  );

  router.put(
    "/admin/:id/plan",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      const { id } = req.params;
      const { plan } = req.body;
      const normalizedPlan = String(plan || "")
        .trim()
        .toLowerCase();
      const validPlans = ["barato", "medio", "full"];

      if (!validPlans.includes(normalizedPlan)) {
        return res.status(400).json({ mensagem: "Plano inválido." });
      }

      try {
        const adminRef = db.collection("admin").doc(id);
        const adminDoc = await adminRef.get();

        if (!adminDoc.exists) {
          return res.status(404).json({ mensagem: "Admin não encontrado" });
        }

        const adminData = adminDoc.data();

        if (await protegerOutroSuperAdmin(req, res, id, adminData)) return;

        const establishmentId = adminData.establishment_id;

        if (!establishmentId) {
          return res.status(400).json({
            mensagem:
              "Este administrador não está vinculado a um estabelecimento.",
          });
        }

        const estabRef = db.collection("estabelecimentos").doc(establishmentId);
        const estabDoc = await estabRef.get();

        if (!estabDoc.exists) {
          return res
            .status(404)
            .json({ mensagem: "Estabelecimento não encontrado" });
        }

        await atualizarEstabelecimentoComPlano(
          establishmentId,
          {},
          normalizedPlan,
          adminRef,
        );

        return res.json({ mensagem: "Plano atualizado com sucesso" });
      } catch (err) {
        if (err?.statusCode === 404) {
          return res.status(404).json({ mensagem: err.message });
        }
        logger.error("Erro ao atualizar plano do admin", {
          message: err?.message,
        });
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao atualizar plano" });
      }
    },
  );

  router.put(
    "/admin/:id/reset-password",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      const { id } = req.params;
      const { senha } = req.body;

      if (!senha || typeof senha !== "string" || senha.trim().length < 8) {
        return res.status(400).json({
          mensagem: "Senha obrigatória com ao menos 8 caracteres.",
        });
      }

      try {
        const ref = db.collection("admin").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Admin não encontrado" });
        }

        if (await protegerOutroSuperAdmin(req, res, id, doc.data())) return;

        try {
          await auth.getUser(id);
        } catch (authErr) {
          if (authErr.code === "auth/user-not-found") {
            return res.status(404).json({
              mensagem:
                "Este administrador não existe mais no Firebase Authentication. Recrie o usuário ou remova o registro duplicado.",
            });
          }
          throw authErr;
        }

        await auth.updateUser(id, { password: senha.trim() });
        await ref.update({
          primeiro_login: true,
          bloqueado: false,
          tentativas_login: 0,
        });

        res.json({
          mensagem:
            "Senha redefinida com sucesso. Esse admin será redirecionado para trocar a senha no próximo login.",
        });
      } catch (error) {
        logger.error("Erro ao redefinir senha", error);
        res.status(500).json({ mensagem: "Erro ao redefinir senha" });
      }
    },
  );
  // Controlado exclusivamente pelo superadmin. O front (index.html) apenas
  // consome os dados públicos via GET; toda escrita exige sessão + CSRF + role superadmin.
  // Nenhum valor de plano/preço/oferta fica fixo no código: tudo vem do Firestore.

  const schemaPlanoLanding = Joi.object({
    id: Joi.string().trim().min(1).max(50).required(),
    nome: Joi.string().trim().min(2).max(60).required(),
    preco: Joi.number().min(0).max(100000).required(),
    destaque: Joi.boolean().optional(),
    recursos: Joi.array()
      .items(Joi.string().trim().max(150))
      .max(20)
      .optional(),
  });

  const schemaOfertaLanding = Joi.object({
    ativa: Joi.boolean().required(),
    planoId: Joi.string().trim().max(50).allow("").optional(),
    texto: Joi.string().trim().max(200).allow("").optional(),
    precoOriginal: Joi.number().min(0).max(1000000).allow(null).optional(),
    precoComDesconto: Joi.number().min(0).max(1000000).allow(null).optional(),
    percentualDesconto: Joi.number().min(0).max(100).allow(null).optional(),
    economia: Joi.number().min(0).max(1000000).allow(null).optional(),
  });

  const schemaPlanosLanding = Joi.object({
    planos: Joi.array().items(schemaPlanoLanding).min(1).max(6).required(),
    oferta: schemaOfertaLanding.required(),
    whatsappNumero: Joi.string()
      .trim()
      .pattern(/^[0-9]{8,15}$/)
      .allow("")
      .optional(),
  });

  function sanitizarPlanosLanding(dados) {
    const planos = dados.planos.map((p) => ({
      id: xss(String(p.id)),
      nome: xss(String(p.nome)),
      preco: Number(p.preco) || 0,
      destaque: !!p.destaque,
      recursos: Array.isArray(p.recursos)
        ? p.recursos.map((r) => xss(String(r)))
        : [],
    }));

    // Localiza no backend o plano selecionado para a oferta para calcular com segurança
    const planoOferta = planos.find(
      (p) => p.id === xss(String(dados.oferta.planoId || "")),
    );
    const precoMensal = planoOferta ? Number(planoOferta.preco) || 0 : 0;

    const percentualDesconto = Math.min(
      100,
      Math.max(0, Number(dados.oferta.percentualDesconto) || 0),
    );

    // O backend faz o cálculo autoritativo e seguro do plano anual de 12 meses
    const precoOriginal = Number((precoMensal * 12).toFixed(2));
    const precoComDesconto = Number(
      (precoOriginal * (1 - percentualDesconto / 100)).toFixed(2),
    );
    const economia = Number((precoOriginal - precoComDesconto).toFixed(2));

    return {
      planos,
      oferta: {
        ativa: !!dados.oferta.ativa,
        planoId: xss(String(dados.oferta.planoId || "")),
        texto: xss(String(dados.oferta.texto || "")),
        precoOriginal,
        precoComDesconto,
        percentualDesconto,
        economia,
      },
      whatsappNumero: xss(String(dados.whatsappNumero || "")),
    };
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

  const OFERTA_PADRAO_LANDING = {
    ativa: false,
    planoId: "full",
    texto: "Oferta Anual 12 Meses",
    precoOriginal: 1678.8,
    precoComDesconto: 1343.04,
    percentualDesconto: 20,
    economia: 335.76,
  };

  // Rota pública: a landing page apenas consome os dados já persistidos no banco.
  router.get("/planos-landing", publicLimiter, async (req, res) => {
    try {
      const doc = await db
        .collection("configuracoes")
        .doc("planos_landing")
        .get();

      if (!doc.exists) {
        return res.json({
          planos: PLANOS_PADRAO_LANDING,
          oferta: OFERTA_PADRAO_LANDING,
          whatsappNumero: "",
        });
      }

      const dados = doc.data();
      return res.json({
        planos:
          Array.isArray(dados.planos) && dados.planos.length > 0
            ? dados.planos
            : PLANOS_PADRAO_LANDING,
        oferta: dados.oferta || OFERTA_PADRAO_LANDING,
        whatsappNumero: dados.whatsappNumero || "",
      });
    } catch (err) {
      logger.error("Erro ao carregar planos da landing page", err);
      res.status(500).json({ mensagem: "Erro ao carregar planos" });
    }
  });

  router.put(
    "/planos-landing",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      // Apenas o superadmin padrão pode alterar preços/ofertas da landing page.
      if (!(await isDefaultSuperAdmin(req))) {
        return res.status(403).json({
          mensagem:
            "Apenas o superadmin padrão pode alterar os planos e ofertas da página inicial.",
        });
      }

      const { error, value } = schemaPlanosLanding.validate(req.body, {
        abortEarly: false,
      });

      if (error) {
        return res.status(400).json({
          mensagem: "Dados inválidos.",
          detalhes: error.details.map((d) => d.message),
        });
      }

      try {
        const dadosSanitizados = sanitizarPlanosLanding(value);

        await db
          .collection("configuracoes")
          .doc("planos_landing")
          .set(
            {
              ...dadosSanitizados,
              atualizadoEm: FieldValue.serverTimestamp(),
              atualizadoPor: req.user?.email || null,
            },
            { merge: false },
          );

        res.json({
          mensagem: "Planos e oferta atualizados com sucesso.",
          ...dadosSanitizados,
        });
      } catch (err) {
        logger.error("Erro ao salvar planos da landing page", err);
        res.status(500).json({ mensagem: "Erro ao salvar planos" });
      }
    },
  );

  router.get("/estabelecimentos", publicLimiter, async (req, res) => {
    const { slug } = req.query;

    try {
      if (slug) {
        const snap = await db
          .collection("estabelecimentos")
          .where("slug", "==", slug)
          .limit(1)
          .get();

        if (snap.empty) {
          return res.status(404).json({ mensagem: "Não encontrado" });
        }

        const doc = snap.docs[0];
        return res.json(dadosEstabelecimentoPublicos(doc.id, doc.data()));
      } else {
        return res
          .status(403)
          .json({ mensagem: "Consulta global não permitida." });
      }
    } catch (err) {
      logger.error("Erro ao carregar estabelecimentos", err);
      return res
        .status(500)
        .json({ mensagem: "Erro interno ao processar lojas" });
    }
  });

  router.get(
    "/admin/estabelecimentos",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    async (req, res) => {
      try {
        const snap = await db.collection("estabelecimentos").get();
        const estabelecimentos = await Promise.all(
          snap.docs.map(async (doc) => {
            const dados = doc.data();
            return {
              ...dadosEstabelecimentoPublicos(doc.id, dados),
              assinatura: calcularStatusAssinatura(dados.assinatura),
            };
          }),
        );
        return res.json(estabelecimentos);
      } catch (err) {
        logger.error("Erro ao carregar estabelecimentos administrativos", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao processar lojas" });
      }
    },
  );

  const schemaAlteracaoAssinatura = Joi.object({
    dias: Joi.number().integer().min(1).max(3650).optional(),
    vence_em: Joi.string().isoDate().optional(),
  })
    .xor("dias", "vence_em")
    .unknown(false);

  router.put(
    "/admin/estabelecimentos/:id/assinatura",
    verificarToken,
    verificarCSRF,
    verificarSuperAdmin,
    verificarSuperAdminPadrao,
    async (req, res) => {
      const { error, value } = schemaAlteracaoAssinatura.validate(req.body);
      if (error)
        return res
          .status(400)
          .json({ mensagem: "Alteração de assinatura inválida." });

      try {
        const ref = db.collection("estabelecimentos").doc(req.params.id);
        const auditoriaRef = db.collection("auditoria_admin").doc();
        let anterior = null;
        let novoVencimento;

        await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref);
          if (!doc.exists) {
            const err = new Error("Estabelecimento não encontrado.");
            err.statusCode = 404;
            throw err;
          }

          anterior = doc.data()?.assinatura || null;
          if (value.dias !== undefined) {
            const base = timestampParaMillis(anterior?.vence_em);
            const inicio = base && base > Date.now() ? base : Date.now();
            novoVencimento = Timestamp.fromMillis(
              inicio + value.dias * 86400000,
            );
          } else {
            const data = new Date(value.vence_em);
            if (
              data.getTime() <= Date.now() ||
              data.getTime() > Date.now() + 10 * 3650 * 86400000
            ) {
              const err = new Error(
                "Data de vencimento fora do limite permitido.",
              );
              err.statusCode = 400;
              throw err;
            }
            novoVencimento = Timestamp.fromMillis(data.getTime());
          }

          tx.update(ref, {
            assinatura: {
              vence_em: novoVencimento,
              dias_carencia: Number.isInteger(anterior?.dias_carencia)
                ? anterior.dias_carencia
                : 5,
              atualizado_em: FieldValue.serverTimestamp(),
              atualizado_por: req.user.uid,
            },
          });

          tx.set(auditoriaRef, {
            tipo: "ASSINATURA_ALTERADA",
            establishment_id: req.params.id,
            alterado_por: req.user.uid,
            vencimento_anterior: anterior?.vence_em || null,
            vencimento_novo: novoVencimento,
            motivo:
              value.dias !== undefined ? "ADICAO_MANUAL" : "DEFINICAO_MANUAL",
            criado_em: FieldValue.serverTimestamp(),
          });
        });

        return res.json({
          mensagem: "Assinatura atualizada com sucesso.",
          assinatura: calcularStatusAssinatura({
            vence_em: novoVencimento,
            dias_carencia: anterior?.dias_carencia || 5,
          }),
        });
      } catch (err) {
        logger.error("Erro ao alterar assinatura manualmente", err);
        return res.status(err.statusCode || 500).json({
          mensagem: err.statusCode
            ? err.message
            : "Erro interno ao alterar assinatura.",
        });
      }
    },
  );

  router.get("/estabelecimentos/:id", publicLimiter, async (req, res) => {
    const { id } = req.params;

    try {
      const doc = await db.collection("estabelecimentos").doc(id).get();

      if (!doc.exists) {
        return res
          .status(404)
          .json({ mensagem: "Estabelecimento não encontrado" });
      }

      const { nome, slug, banner, status, plano, horarios, telefone } =
        doc.data();
      res.json({
        id: doc.id,
        nome,
        slug,
        banner,
        status,
        plano,
        horarios,
        telefone,
        pedidos_disponiveis:
          calcularStatusAssinatura(doc.data().assinatura).status !== "suspensa",
      });
    } catch (err) {
      res.status(500).json({ mensagem: "Erro interno no servidor" });
    }
  });

  router.put(
    "/estabelecimentos/:id/banner",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    upload.single("banner"),
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!validarAcessoEstabelecimento(req, res, id)) return;

        if (!req.file) {
          return res.status(400).json({ mensagem: "Nenhuma imagem enviada" });
        }

        await validarBuffer(req.file.buffer);

        const result = await uploadCloudinary(req.file.buffer);
        const novaUrl = result.secure_url;
        const novoPublicId = result.public_id;

        const ref = db.collection("estabelecimentos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res
            .status(404)
            .json({ mensagem: "Estabelecimento não encontrado" });
        }

        const publicIdAntigo = doc.data().banner_public_id;

        if (publicIdAntigo) {
          try {
            await cloudinary.uploader.destroy(publicIdAntigo);
          } catch (e) {
            logger.error("Erro ao deletar banner antigo", e);
          }
        }

        await ref.update({ banner: novaUrl, banner_public_id: novoPublicId });

        res.json({
          mensagem: "Banner atualizado com sucesso!",
          banner: novaUrl,
        });
      } catch (err) {
        logger.error("Erro ao atualizar banner", err);
        res.status(err.statusCode || 500).json({
          erro: err.message || "Erro no servidor",
        });
      }
    },
  );

  router.put(
    "/estabelecimentos/:id/horarios",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    async (req, res) => {
      const { id } = req.params;
      if (!validarAcessoEstabelecimento(req, res, id)) return;
      let { horarios } = req.body;

      Object.keys(horarios || {}).forEach((dia) => {
        if (horarios[dia]) {
          horarios[dia] = {
            abertura: horarios[dia].abertura,
            fechamento:
              horarios[dia].fechamento || horarios[dia]["fechamento"] || null,
          };
        }
      });

      try {
        await db.collection("estabelecimentos").doc(id).update({ horarios });
        res.json({ mensagem: "Horários atualizados!" });
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.get(
    "/estabelecimentos/:id/horarios",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    async (req, res) => {
      const { id } = req.params;

      if (!validarAcessoEstabelecimento(req, res, id)) return;

      try {
        const doc = await db.collection("estabelecimentos").doc(id).get();

        if (!doc.exists) {
          return res.json({ horarios: {} });
        }

        res.json({ horarios: doc.data().horarios || {} });
      } catch (err) {
        logger.error("Erro ao buscar horários", err);
        res.status(500).json({ mensagem: "Erro ao buscar horários" });
      }
    },
  );

  router.put(
    "/estabelecimentos/:id/dados",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    async (req, res) => {
      const { id } = req.params;

      if (!validarAcessoEstabelecimento(req, res, id)) return;
      const camposPermitidos = [
        "telefone",
        "status",
        "plan",
        "mercadopago_access_token",
        "mercadopago_secret_key",
      ];
      const corpo = req.body;
      if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
        return res.status(400).json({ mensagem: "Corpo da requisição inválido." });
      }
      if (Object.keys(corpo).some((k) => !camposPermitidos.includes(k))) {
        return res.status(400).json({ mensagem: "Campo não permitido." });
      }
      const {
        telefone,
        status,
        plan,
        mercadopago_access_token,
        mercadopago_secret_key,
      } = corpo;
      if (
        [mercadopago_access_token, mercadopago_secret_key].some(
          (v) => v !== undefined && typeof v !== "string",
        )
      ) {
        return res.status(400).json({ mensagem: "Credencial inválida." });
      }

      // Status e plano são campos exclusivos do Superadmin: um admin comum não pode
      // alterar o próprio plano/status (escalada de privilégio).
      if (
        (status !== undefined || plan !== undefined) &&
        req.user?.role !== "superadmin"
      ) {
        return res.status(403).json({
          mensagem: "Apenas o superadmin pode alterar status ou plano.",
        });
      }
      if (
        status !== undefined &&
        (typeof status !== "string" ||
          !["active", "suspended", "rejected", "pending"].includes(status))
      ) {
        return res.status(400).json({ mensagem: "Status inválido." });
      }
      if (
        plan !== undefined &&
        (typeof plan !== "string" ||
          !["barato", "medio", "full"].includes(plan))
      ) {
        return res.status(400).json({ mensagem: "Plano inválido." });
      }
      if (
        telefone !== undefined &&
        (typeof telefone !== "string" || telefone.length > 30)
      ) {
        return res.status(400).json({ mensagem: "Telefone inválido." });
      }

      try {
        const updateData = {};
        if (telefone !== undefined) updateData.telefone = telefone;
        if (status !== undefined) updateData.status = status;
        if (plan !== undefined) updateData.plano = plan;

        // Encriptar token Mercado Pago se fornecido. Campo vazio = mantém o valor já salvo
        // (o frontend nunca reenvia o token/chave existente, só mostra se está configurado)
        if (mercadopago_access_token !== undefined) {
          const token = String(mercadopago_access_token).trim();

          if (token) {
            // Validar formato do token
            if (!token.startsWith("TEST-") && !token.startsWith("APP_USR-")) {
              return res.status(400).json({
                mensagem:
                  "Token Mercado Pago inválido. Deve começar com TEST- ou APP_USR-",
              });
            }

            try {
              updateData.mercadopago_access_token = encryptSensitiveData(token);
            } catch (encErr) {
              logger.error("Erro ao encriptar token", encErr);
              return res.status(500).json({
                mensagem: "Erro ao processar token de segurança",
              });
            }
          }
        }

        // Encriptar a chave secreta do webhook do Mercado Pago se fornecida
        if (mercadopago_secret_key !== undefined) {
          const secretKey = String(mercadopago_secret_key)
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .trim();

          if (secretKey) {
            const isMaskedPlaceholder =
              /^[\-_*•.]+$/.test(secretKey) || /^(.)(\1)+$/.test(secretKey);

            if (secretKey.length < 10 || isMaskedPlaceholder) {
              return res.status(400).json({
                mensagem:
                  "Chave secreta do Mercado Pago inválida. Copie a chave real no painel do Mercado Pago.",
              });
            }

            try {
              updateData.mercadopago_secret_key =
                encryptSensitiveData(secretKey);
            } catch (encErr) {
              logger.error("Erro ao encriptar chave secreta", encErr);
              return res.status(500).json({
                mensagem: "Erro ao processar chave de segurança",
              });
            }
          }
        }

        if (plan !== undefined) {
          await atualizarEstabelecimentoComPlano(id, updateData, plan);
        } else {
          await db.collection("estabelecimentos").doc(id).update(updateData);
        }
        res.json({ mensagem: "Dados updated com sucesso!" });
      } catch (err) {
        if (err?.statusCode === 404) {
          return res.status(404).json({ mensagem: err.message });
        }
        logger.error("Erro ao atualizar dados", { message: err?.message });
        res.status(500).json({ mensagem: "Erro interno ao atualizar dados." });
      }
    },
  );

  router.put(
    "/admin/me/estabelecimento/nome",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    async (req, res) => {
      if (req.user?.role !== "admin") {
        return res
          .status(403)
          .json({ mensagem: "Apenas o administrador da loja pode alterar o nome." });
      }

      const estabelecimentoId =
        req.user?.establishmentId || req.user?.establishment_id;
      if (!estabelecimentoId) {
        return res
          .status(403)
          .json({ mensagem: "Nenhum estabelecimento associado à sessão." });
      }

      const { error, value } = Joi.object({
        nome: Joi.string().strict().required(),
      })
        .unknown(false)
        .validate(req.body);
      const nome = error
        ? null
        : normalizarNomeEstabelecimento(value.nome);
      if (!nome) {
        return res.status(400).json({
          mensagem: "O nome deve conter de 1 a 100 caracteres válidos.",
        });
      }

      const chaveNova = chaveNomeEstabelecimento(nome);
      const estabelecimentoRef = db
        .collection("estabelecimentos")
        .doc(String(estabelecimentoId));
      const novaReservaRef = referenciaReservaNome(db, chaveNova);
      const statusIndiceRef = referenciaStatusIndiceNomes(db);

      try {
        await db.runTransaction(async (tx) => {
          const [statusIndice, estabelecimento] = await Promise.all([
            tx.get(statusIndiceRef),
            tx.get(estabelecimentoRef),
          ]);
          exigirIndiceNomesPronto(
            statusIndice,
            "O índice de nomes precisa ser regularizado antes de alterar nomes.",
          );
          if (!estabelecimento.exists) {
            throw Object.assign(
              new Error("Estabelecimento não encontrado."),
              { statusCode: 404 },
            );
          }

          const chaveAnterior = chaveNomeEstabelecimento(
            estabelecimento.data()?.nome,
          );
          const reservaAnteriorRef = chaveAnterior
            ? referenciaReservaNome(db, chaveAnterior)
            : null;
          const refsReserva = new Map();
          refsReserva.set(chaveNova, novaReservaRef);
          if (chaveAnterior && !refsReserva.has(chaveAnterior)) {
            refsReserva.set(chaveAnterior, reservaAnteriorRef);
          }
          const reservas = new Map(
            await Promise.all(
              [...refsReserva].map(async ([chave, ref]) => [
                chave,
                await tx.get(ref),
              ]),
            ),
          );
          const reservaNova = reservas.get(chaveNova);
          const reservaAnterior = chaveAnterior
            ? reservas.get(chaveAnterior)
            : null;

          if (
            chaveAnterior &&
            (!reservaAnterior?.exists ||
              reservaAnterior.data()?.establishment_id !==
                String(estabelecimentoId))
          ) {
            throw Object.assign(
              new Error(
                "A reserva do nome atual não está regularizada. Contate o suporte.",
              ),
              { statusCode: 409, code: "INDICE_NOMES_PENDENTE" },
            );
          }
          if (
            reservaNova?.exists &&
            reservaNova.data()?.establishment_id !==
              String(estabelecimentoId)
          ) {
            throw Object.assign(
              new Error(
                "Este nome de estabelecimento já está em uso. Escolha outro nome.",
              ),
              { statusCode: 409 },
            );
          }

          if (!reservaNova?.exists) {
            tx.create(novaReservaRef, {
              establishment_id: String(estabelecimentoId),
              nome_normalizado: chaveNova,
              criado_em: FieldValue.serverTimestamp(),
            });
          }
          if (chaveAnterior && chaveAnterior !== chaveNova) {
            tx.delete(reservaAnteriorRef);
          }
          if (estabelecimento.data()?.nome !== nome) {
            tx.update(estabelecimentoRef, { nome });
          }
        });

        return res.status(200).json({
          mensagem: "Nome do estabelecimento atualizado com sucesso.",
          nome,
        });
      } catch (err) {
        const { status, corpo } = classificarErroCadastro(err);
        if (status >= 500) {
          logger.error("Erro ao alterar nome do estabelecimento", err);
          corpo.mensagem =
            status === 500
              ? "Erro interno ao atualizar o nome."
              : corpo.mensagem;
        }
        return res.status(status).json(corpo);
      }
    },
  );

  router.get(
    "/admin/me/estabelecimento",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;

        if (!establishmentId) {
          if (req.user?.role === "superadmin") {
            return res.json({
              nome: "Visão Global SaaS",
              slug: "global",
              status: "active",
              plan: "SaaS Enterprise",
            });
          }
          return res.status(400).json({
            error: "Nenhum estabelecimento associado a este administrador.",
          });
        }

        const doc = await db
          .collection("estabelecimentos")
          .doc(establishmentId)
          .get();
        if (!doc.exists) {
          return res.status(404).json({
            error: "Estabelecimento não encontrado no banco de dados.",
          });
        }

        // Nunca devolvemos o token/chave (nem criptografados) ao navegador,
        // só um indicador de que já foram configurados
        const dados = doc.data();

        res.json({
          ...dadosEstabelecimentoPublicos(doc.id, dados),
          mercadopago_token_configurado: Boolean(
            dados.mercadopago_access_token,
          ),
          mercadopago_secret_key_configurado: Boolean(
            dados.mercadopago_secret_key,
          ),
        });
      } catch (error) {
        logger.error("Erro ao buscar dados do estabelecimento", error);
        res.status(500).json({
          error: "Erro interno do servidor ao processar estabelecimento.",
        });
      }
    },
  );

  router.get(
    "/assinatura/status",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        if (req.user.role === "superadmin")
          return res.json({ status: "ativa" });
        const establishmentId =
          req.user.establishmentId || req.user.establishment_id;
        const dados = establishmentId
          ? await obterStatusAssinatura(establishmentId)
          : null;
        return res.json(dados?.status || { status: "nao_configurada" });
      } catch (err) {
        logger.error("Erro ao consultar status da assinatura", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao consultar assinatura." });
      }
    },
  );

  router.get("/produtos", publicLimiter, async (req, res) => {
    const { slug } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "Slug obrigatório" });
    }

    try {
      const estabSnap = await db
        .collection("estabelecimentos")
        .where("slug", "==", slug)
        .limit(1)
        .get();

      if (estabSnap.empty) {
        return res
          .status(404)
          .json({ error: "Estabelecimento não encontrado" });
      }

      const establishmentId = estabSnap.docs[0].id;

      const produtosSnap = await db
        .collection("produtos")
        .where("establishment_id", "==", establishmentId)
        .select(
          "nome",
          "descricao",
          "categoria",
          "preco",
          "imagem",
          "controla_estoque",
          "estoque",
          "estoque_reservado",
        )
        .get();

      const produtos = produtosSnap.docs.map((doc) =>
        produtoPublico(doc.id, doc.data()),
      );

      res.json(produtos);
    } catch (err) {
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  });

  router.get(
    "/me/produtos",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const establishmentId = req.user.establishmentId;

        let snap;

        if (req.user.role === "superadmin") {
          snap = await db.collection("produtos").get();
        } else {
          if (!establishmentId) {
            return res.status(400).json({
              mensagem: "Admin sem estabelecimento associado",
            });
          }

          snap = await db
            .collection("produtos")
            .where("establishment_id", "==", establishmentId)
            .get();
        }

        const produtos = snap.docs.map((doc) =>
          comEsgotado({ id: doc.id, ...doc.data() }),
        );

        res.json(produtos);
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.post(
    "/me/produtos",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    upload.single("imagem"),
    async (req, res) => {
      try {
        const { error, value } = schemaProduto.validate(req.body);

        if (error) {
          return res.status(400).json({
            erro: error.details[0].message,
          });
        }

        if (!req.file) {
          return res.status(400).json({ erro: "Imagem obrigatória" });
        }

        await validarBuffer(req.file.buffer);

        const result = await uploadCloudinary(req.file.buffer);

        const imagemUrl = result.secure_url;
        const imagemPublicId = result.public_id;

        const {
          nome,
          descricao,
          categoria,
          preco,
          controla_estoque,
          estoque,
          mercado_pago_taxa,
        } = value;

        const controlaEstoque =
          controla_estoque === true || controla_estoque === "true";

        const estoqueFinal = controlaEstoque ? Number(estoque ?? 0) : null;

        if (
          controlaEstoque &&
          (estoqueFinal === null || isNaN(estoqueFinal) || estoqueFinal < 0)
        ) {
          return res.status(400).json({
            erro: "Estoque inválido",
          });
        }

        const establishmentId = req.user.establishmentId;

        await db.collection("produtos").add({
          nome,
          descricao,
          categoria,
          preco,
          imagem: imagemUrl,
          imagem_public_id: imagemPublicId,
          establishment_id: establishmentId,
          controla_estoque: controlaEstoque,
          estoque: estoqueFinal,
          mercado_pago_taxa: mercado_pago_taxa || "assumir",
          estoque_reservado: 0,
          created_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });

        res.status(201).json({
          mensagem: "Produto adicionado com sucesso!",
          imagem: imagemUrl,
        });
      } catch (err) {
        logger.error("Erro na criação de produto", err);
        res.status(err.statusCode || 500).json({
          erro: err.message || "Erro no servidor",
        });
      }
    },
  );

  router.put(
    "/produtos/:id",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    upload.single("imagem"),
    async (req, res) => {
      try {
        const id = req.params.id;

        req.body.controla_estoque = req.body.controla_estoque === "true";

        const {
          nome,
          descricao,
          categoria,
          preco,
          estoque,
          controla_estoque,
          mercado_pago_taxa,
        } = req.body;

        const controlaEstoque = controla_estoque;

        let imagemUrl = null;
        let imagemPublicId = null;

        if (req.file) {
          await validarBuffer(req.file.buffer);
          const result = await uploadCloudinary(req.file.buffer);
          imagemUrl = result.secure_url;
          imagemPublicId = result.public_id;
        }

        if (!nome || !descricao || !categoria || !preco) {
          return res.status(400).json({
            erro: "Nome, descrição, categoria e preço são obrigatórios!",
          });
        }

        const estoqueFinal = controlaEstoque ? Number(estoque ?? 0) : null;

        if (controlaEstoque && (isNaN(estoqueFinal) || estoqueFinal < 0)) {
          return res.status(400).json({
            erro: "Estoque inválido",
          });
        }

        const ref = db.collection("produtos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ erro: "Produto não encontrado" });
        }

        const produto = doc.data();
        const establishmentId = req.user.establishmentId;

        if (
          req.user.role !== "superadmin" &&
          produto.establishment_id !== establishmentId
        ) {
          return res.status(403).json({ mensagem: "Acesso negado" });
        }

        const imagemPublicIdAntigo = produto.imagem_public_id;

        if (imagemUrl && imagemPublicIdAntigo) {
          try {
            await cloudinary.uploader.destroy(imagemPublicIdAntigo);
          } catch (e) {
            logger.error("Erro ao deletar imagem antiga", e);
          }
        }

        const imagemParaSalvar = imagemUrl || produto.imagem;
        const publicIdParaSalvar = imagemPublicId || imagemPublicIdAntigo;

        await ref.update({
          nome,
          descricao,
          categoria,
          preco,
          estoque: estoqueFinal,
          controla_estoque: controlaEstoque,
          mercado_pago_taxa:
            mercado_pago_taxa === "repassar" ? "repassar" : "assumir",
          imagem: imagemParaSalvar,
          imagem_public_id: publicIdParaSalvar,
          updated_at: FieldValue.serverTimestamp(),
        });

        res.json({
          mensagem: "Produto atualizado com sucesso",
          imagem: imagemParaSalvar,
        });
      } catch (err) {
        logger.error("Erro ao atualizar produto", err);
        res.status(500).json({ erro: err.message });
      }
    },
  );

  router.delete(
    "/produtos/:id",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const id = req.params.id;

      try {
        const ref = db.collection("produtos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Produto não encontrado" });
        }

        const produto = doc.data();
        const establishmentId = req.user.establishmentId;

        if (
          req.user.role !== "superadmin" &&
          produto.establishment_id !== establishmentId
        ) {
          return res.status(403).json({ transatlantic: "Acesso negado" });
        }

        if (produto.imagem_public_id) {
          try {
            await cloudinary.uploader.destroy(produto.imagem_public_id);
          } catch (err) {
            logger.error("Erro ao deletar imagem", err);
          }
        }

        await ref.delete();
        res.json({ mensagem: "Produto deletado com sucesso" });
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.patch(
    "/produtos/:id/estoque",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const estoque = Number(req.body.estoque);

      if (estoque === undefined || isNaN(estoque)) {
        return res.status(400).json({ mensagem: "Estoque inválido" });
      }

      try {
        const ref = db.collection("produtos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Produto não encontrado" });
        }

        const produto = doc.data();

        if (
          req.user.role !== "superadmin" &&
          produto.establishment_id !== req.user.establishmentId
        ) {
          return res.status(403).json({ mensagem: "Acesso negado" });
        }

        await ref.update({ estoque });
        res.json({ mensagem: "Estoque atualizado com sucesso" });
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.patch(
    "/produtos/:id/estoque/add",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const quantidade = Number(req.body.quantidade);

      if (quantidade === undefined || isNaN(quantidade)) {
        return res.status(400).json({ mensagem: "Estoque inválido" });
      }

      try {
        const ref = db.collection("produtos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Produto não encontrado" });
        }

        const produto = doc.data();

        if (
          req.user.role !== "superadmin" &&
          produto.establishment_id !== req.user.establishmentId
        ) {
          return res.status(403).json({ mensagem: "Acesso negado" });
        }

        await ref.update({ estoque: FieldValue.increment(quantidade) });
        const atualizado = await ref.get();

        res.json({
          mensagem: "Estoque adicionado",
          estoque: atualizado.data().estoque,
        });
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.patch(
    "/produtos/:id/estoque/remove",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const quantidade = Number(req.body.quantidade);

      if (!quantidade || quantidade <= 0) {
        return res.status(400).json({ mensagem: "Quantidade inválida" });
      }

      try {
        const ref = db.collection("produtos").doc(id);

        const novoEstoque = await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref);

          if (!doc.exists) {
            const err = new Error("Produto não encontrado");
            err.statusCode = 404;
            throw err;
          }

          const produto = doc.data();

          if (
            req.user.role !== "superadmin" &&
            produto.establishment_id !== req.user.establishmentId
          ) {
            const err = new Error("Acesso negado");
            err.statusCode = 403;
            throw err;
          }

          const estoqueAtual = Number(produto.estoque) || 0;

          if (estoqueAtual < quantidade) {
            const err = new Error("Estoque insuficiente");
            err.statusCode = 400;
            throw err;
          }

          const novo = estoqueAtual - quantidade;
          tx.update(ref, { estoque: novo });
          return novo;
        });

        res.json({ mensagem: "Estoque reduzido", estoque: novoEstoque });
      } catch (err) {
        res
          .status(err.statusCode || 500)
          .json({ mensagem: err.message || "Erro no servidor" });
      }
    },
  );

  router.patch(
    "/produtos/:id/controle-estoque",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const { controla_estoque } = req.body;

      try {
        const ref = db.collection("produtos").doc(id);
        const doc = await ref.get();

        if (!doc.exists) {
          return res.status(404).json({ mensagem: "Produto não encontrado" });
        }

        const produto = doc.data();

        if (
          req.user.role !== "superadmin" &&
          produto.establishment_id !== req.user.establishmentId
        ) {
          return res.status(403).json({ mensagem: "Acesso negado" });
        }

        await ref.update({ controla_estoque });

        res.json({
          mensagem: "Controle de estoque atualizado",
        });
      } catch (err) {
        res.status(500).json({ mensagem: "Erro interno no servidor" });
      }
    },
  );

  router.post("/pedidos", publicLimiter, async (req, res) => {
    const { error, value } = schemaPedidoPublico.validate(req.body);
    if (error) {
      return res.status(400).json({ mensagem: error.details[0].message });
    }
    const { itens } = value;

    try {
      const refs = itens.map((item) =>
        db.collection("produtos").doc(String(item.id)),
      );
      const docs = await db.getAll(...refs);

      let total = 0;
      const detalhes = [];

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const doc = docs[i];

        if (!doc.exists) {
          return res.status(400).json({ mensagem: "Produto inválido" });
        }

        const produto = doc.data();
        const subtotal = produto.preco * item.quantidade;
        total += subtotal;

        detalhes.push({
          nome: produto.nome,
          quantidade: item.quantidade,
          preco: produto.preco,
          subtotal,
        });
      }

      res.json({ total, itens: detalhes });
    } catch (err) {
      logger.error("Erro ao calcular pedido", err);
      res.status(500).json({ mensagem: "Erro no servidor" });
    }
  });

  router.post("/pedidos/salvar", publicLimiter, async (req, res) => {
    const { error, value } = schemaPedidoSalvar.validate(req.body);
    if (error) {
      return res.status(400).json({ mensagem: error.details[0].message });
    }

    const {
      slug,
      itens,
      forma_pagamento,
      tipo_entrega,
      mesa,
      nome_cliente,
      endereco,
      precisa_troco,
      troco_para,
    } = value;

    if (
      forma_pagamento === "dinheiro" &&
      precisa_troco === true &&
      (troco_para === undefined || troco_para === null)
    ) {
      return res.status(400).json({
        mensagem: "Informe o valor para troco.",
      });
    }

    try {
      const estabSnap = await db
        .collection("estabelecimentos")
        .where("slug", "==", slug)
        .limit(1)
        .get();

      if (estabSnap.empty) {
        return res.status(404).json({
          mensagem: "Estabelecimento não encontrado",
        });
      }

      const establishmentId = estabSnap.docs[0].id;
      const assinaturaStatus = calcularStatusAssinatura(
        estabSnap.docs[0].data().assinatura,
      );
      if (assinaturaStatus.status === "suspensa") {
        return responderPedidosIndisponiveis(res);
      }
      const pedidoRef = db.collection("pedidos").doc();

      const { total, itensFinal } = await db.runTransaction(async (tx) => {
        const { total, itensFinal, aplicarReservas } =
          await reservarEstoqueDoEstabelecimento({
            db,
            tx,
            FieldValue,
            itens,
            establishmentId,
          });

        const precisaTrocoFinal =
          forma_pagamento === "dinheiro" ? precisa_troco === true : false;

        if (precisaTrocoFinal && Number(troco_para) < total) {
          const err = new Error(
            "O valor para troco deve ser maior ou igual ao total do pedido",
          );
          err.statusCode = 400;
          throw err;
        }

        aplicarReservas();

        tx.set(pedidoRef, {
          establishment_id: establishmentId,
          itens: itensFinal,
          total,
          forma_pagamento,
          tipo_entrega,
          mesa: mesa || null,
          nome_cliente: nome_cliente || null,
          endereco: endereco || null,
          precisa_troco: precisaTrocoFinal,
          troco_para: precisaTrocoFinal ? Number(troco_para) : null,
          status: "pendente",
          created_at: FieldValue.serverTimestamp(),
        });

        return { total, itensFinal };
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`estab_${establishmentId}`).emit("novoPedido", {
          pedido_id: pedidoRef.id,
          establishment_id: establishmentId,
          itens: itensFinal,
          total,
          nome_cliente,
          tipo_entrega,
          mesa,
        });
      }

      res.json({
        mensagem: "Pedido salvo com sucesso",
        pedido_id: pedidoRef.id,
        total,
        itens: itensFinal,
      });
    } catch (err) {
      logger.error("Erro ao salvar pedido", err);
      res
        .status(err.statusCode || 500)
        .json({ mensagem: err.message || "Erro ao salvar pedido" });
    }
  });

  function planoLandingParaPlanoEstabelecimento(plano) {
    const valor = String(plano || "")
      .trim()
      .toLowerCase();
    if (["premium", "medio", "médio", "medium", "pro"].includes(valor)) {
      return "premium";
    }
    if (
      ["basico", "básico", "basic", "starter", "barato"].includes(valor)
    ) {
      return "basico";
    }
    if (
      ["full", "enterprise", "avancado", "avançado"].includes(valor)
    ) {
      return "full";
    }
    return { barato: "basico", medio: "premium", full: "full" }[
      normalizarPlano(plano)
    ];
  }

  async function obterConfiguracaoMercadoPagoVendly() {
    const doc = await db
      .collection("configuracoes")
      .doc("pagamentos_vendly")
      .get();
    if (!doc.exists) return null;

    const dados = doc.data();
    if (!dados.mercadopago_access_token || !dados.mercadopago_webhook_secret)
      return null;

    return {
      accessToken: decryptSensitiveData(dados.mercadopago_access_token),
      webhookSecret: decryptSensitiveData(dados.mercadopago_webhook_secret),
    };
  }

  async function obterValoresAssinatura(estabelecimento, periodicidade = null) {
    const planoId = planoLandingParaPlanoEstabelecimento(
      estabelecimento?.plano,
    );
    const doc = await db
      .collection("configuracoes")
      .doc("planos_landing")
      .get();
    const dadosLanding = doc.exists ? doc.data() : null;
    const planos = Array.isArray(dadosLanding?.planos)
      ? dadosLanding.planos
      : PLANOS_PADRAO_LANDING;
    const configuracao = planos.find((item) => String(item.id) === planoId);
    return calcularValoresAssinatura(
      configuracao,
      periodicidade,
      dadosLanding?.oferta || null,
    );
  }

  router.get(
    "/pagamentos-assinatura/opcoes",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    subscriptionPaymentLimiter,
    async (req, res) => {
      try {
        if (Object.keys(req.query || {}).length > 0) {
          return res
            .status(400)
            .json({ mensagem: "A consulta não aceita parâmetros." });
        }

        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;
        if (!establishmentId || req.user.role !== "admin") {
          return res.status(403).json({
            mensagem:
              "Apenas administradores de estabelecimentos podem consultar os valores.",
          });
        }

        const estabelecimento = await db
          .collection("estabelecimentos")
          .doc(String(establishmentId))
          .get();
        if (!estabelecimento.exists) {
          return res
            .status(404)
            .json({ mensagem: "Estabelecimento não encontrado." });
        }

        const valores = await obterValoresAssinatura(
          estabelecimento.data(),
        );
        if (!valores) {
          return res
            .status(400)
            .json({ mensagem: "Plano sem preço configurado." });
        }
        return res.json(valores);
      } catch (err) {
        logger.error("Erro ao consultar opções de pagamento da assinatura", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao consultar valores da assinatura." });
      }
    },
  );

  router.post(
    "/pagamentos-assinatura/criar-pix",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    subscriptionPaymentLimiter,
    async (req, res) => {
      if (bloquearMercadoPagoNoModoLocal(res)) return;

      try {
        const { error, value } = SCHEMA_CRIACAO_PIX_ASSINATURA.validate(
          req.body || {},
        );
        if (error)
          return res
            .status(400)
            .json({ mensagem: "Dados de cobrança inválidos." });
        const periodicidade = value.periodicidade;

        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;
        if (!establishmentId || req.user.role !== "admin") {
          return res.status(403).json({
            mensagem:
              "Apenas administradores de estabelecimentos podem criar cobranças.",
          });
        }

        const estabelecimento = await db
          .collection("estabelecimentos")
          .doc(String(establishmentId))
          .get();
        if (!estabelecimento.exists)
          return res
            .status(404)
            .json({ mensagem: "Estabelecimento não encontrado." });

        const valores = await obterValoresAssinatura(
          estabelecimento.data(),
          periodicidade,
        );
        if (!valores)
          return res
            .status(400)
            .json({ mensagem: "Plano sem preço configurado." });
        const plano = {
          plano: valores.plano,
          periodicidade: valores.periodicidade,
          valorCentavos: valores.valorCentavos,
          valor: valores.valorCentavos / 100,
          periodoDias: valores.periodoDias,
        };

        const configuracao = await obterConfiguracaoMercadoPagoVendly();
        if (!configuracao)
          return res.status(503).json({
            mensagem: "Pagamento de assinatura temporariamente indisponível.",
          });

        const pagamentoRef = db.collection("pagamentos_assinaturas").doc();
        const pagamentoId = pagamentoRef.id;
        const token = String(configuracao.accessToken).trim();
        const isSandbox = /^TEST-/i.test(token);
        if (!isSandbox && !/^APP_USR-/i.test(token)) {
          return res.status(503).json({
            mensagem: "Pagamento de assinatura temporariamente indisponível.",
          });
        }

        const config = new MercadoPagoConfig({
          accessToken: token,
          options: isSandbox ? { testToken: true } : {},
        });
        const paymentClient = new Payment(config);
        const email = String(req.user.email || req.body?.email || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res
            .status(400)
            .json({ mensagem: "O email da conta administrativa é inválido." });
        }

        const mpResponse = await paymentClient.create({
          body: {
            transaction_amount: plano.valor,
            description: `Assinatura Vendly - ${plano.plano}`,
            payment_method_id: "pix",
            external_reference: pagamentoId,
            payer: { email },
          },
          requestOptions: isSandbox ? { testToken: true } : undefined,
        });
        const mpBody = mpResponse.body || mpResponse.response || mpResponse;
        const txData = mpBody.point_of_interaction?.transaction_data || {};
        const minutosExpiracao =
          Number(process.env.PIX_EXPIRATION_MINUTES) || 30;

        await pagamentoRef.set({
          establishment_id: establishmentId,
          admin_uid: req.user.uid,
          plano: plano.plano,
          periodicidade: plano.periodicidade,
          valor_esperado: plano.valor,
          valor_esperado_centavos: plano.valorCentavos,
          periodo_dias: plano.periodoDias,
          mercado_pago_id: String(mpBody.id),
          referencia_externa: pagamentoId,
          status: "aguardando_pagamento",
          processado: false,
          assinatura_aplicada: false,
          created_at: FieldValue.serverTimestamp(),
          expira_em: Timestamp.fromMillis(
            Date.now() + minutosExpiracao * 60 * 1000,
          ),
        });

        return res.status(201).json({
          pagamento_id: pagamentoId,
          status: mpBody.status || "pending",
          plano: plano.plano,
          periodicidade: plano.periodicidade,
          valor_centavos: plano.valorCentavos,
          valor_formatado: valores.valorFormatado,
          valor: plano.valor,
          expira_em: new Date(
            Date.now() + minutosExpiracao * 60 * 1000,
          ).toISOString(),
          qr_code: txData.qr_code || null,
          qr_code_base64: txData.qr_code_base64 || null,
          copia_e_cola: txData.qr_code || null,
        });
      } catch (err) {
        logger.error("Erro ao criar Pix de assinatura Vendly", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao processar pagamento." });
      }
    },
  );

  router.get(
    "/pagamentos-assinatura/:id/status",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const doc = await db
          .collection("pagamentos_assinaturas")
          .doc(req.params.id)
          .get();
        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;
        if (
          !doc.exists ||
          String(doc.data().establishment_id || "") !==
            String(establishmentId || "")
        ) {
          return res
            .status(404)
            .json({ mensagem: "Pagamento não encontrado." });
        }
        const dados = doc.data();
        const expirado =
          dados.expira_em && timestampParaMillis(dados.expira_em) < Date.now();
        return res.json({
          pagamento_id: doc.id,
          status:
            expirado && dados.status === "aguardando_pagamento"
              ? "expirado"
              : dados.status,
          processado: dados.processado === true,
          assinatura_aplicada: dados.assinatura_aplicada === true,
        });
      } catch (err) {
        logger.error("Erro ao consultar status de assinatura Vendly", err);
        return res
          .status(500)
          .json({ mensagem: "Erro interno ao consultar pagamento." });
      }
    },
  );

  router.post(
    "/pagamentos-assinatura/webhook",
    webhookLimiter,
    async (req, res) => {
      if (bloquearMercadoPagoNoModoLocal(res)) return;

      try {
        const paymentId =
          req.body.data?.id ||
          req.query["data.id"] ||
          req.body.id ||
          req.query.id ||
          null;
        if (!paymentId) return res.json({ ok: true });

        const snap = await db
          .collection("pagamentos_assinaturas")
          .where("mercado_pago_id", "==", String(paymentId))
          .limit(1)
          .get();
        if (snap.empty) return res.json({ ok: true });

        const pagamentoDoc = snap.docs[0];
        const pagamento = pagamentoDoc.data();
        const configuracao = await obterConfiguracaoMercadoPagoVendly();
        if (
          !configuracao ||
          !validateMercadoPagoSignature(req, configuracao.webhookSecret)
        ) {
          logger.error(
            "Webhook de assinatura Vendly com assinatura inválida rejeitado",
          );
          return res.status(401).json({ ok: false });
        }

        if (pagamento.processado === true) return res.json({ ok: true });

        const token = configuracao.accessToken;
        const isSandbox = /^TEST-/i.test(token);
        const config = new MercadoPagoConfig({
          accessToken: token,
          options: isSandbox ? { testToken: true } : {},
        });
        const paymentClient = new Payment(config);
        const mpResponse = await paymentClient.get({
          id: String(paymentId),
          requestOptions: isSandbox ? { testToken: true } : undefined,
        });
        const mpInfo = mpResponse.body || mpResponse.response || mpResponse;
        const valorPagoCentavos = valorParaCentavos(mpInfo.transaction_amount);
        const idValido = String(mpInfo.id || "") === String(paymentId);
        const referenciaValida =
          String(mpInfo.external_reference || "") === pagamentoDoc.id;
        const valorEsperadoCentavos = Number.isSafeInteger(
          pagamento.valor_esperado_centavos,
        )
          ? pagamento.valor_esperado_centavos
          : valorParaCentavos(pagamento.valor_esperado);
        const valorValido =
          Number.isSafeInteger(valorPagoCentavos) &&
          Number.isSafeInteger(valorEsperadoCentavos) &&
          valorPagoCentavos === valorEsperadoCentavos;
        const estabelecimentoValido = Boolean(pagamento.establishment_id);

        if (
          mpInfo.status === "approved" &&
          idValido &&
          referenciaValida &&
          valorValido &&
          estabelecimentoValido
        ) {
          await aplicarAssinaturaPagamento({
            db,
            FieldValue,
            Timestamp,
            pagamentoRef: pagamentoDoc.ref,
          });
        }

        return res.json({ ok: true });
      } catch (err) {
        logger.error("Erro no webhook de assinatura Vendly", err);
        return res
          .status(500)
          .json({ ok: false, mensagem: "Erro interno ao processar webhook." });
      }
    },
  );

  // ROTA: Salvar pedido e gerar pagamento via Pix (Mercado Pago)
  router.post("/pedidos/salvar-com-pix", publicLimiter, async (req, res) => {
    if (bloquearMercadoPagoNoModoLocal(res)) return;

    const { error, value } = schemaPedidoPixSalvar.validate(req.body);
    if (error) {
      return res.status(400).json({ mensagem: error.details[0].message });
    }

    const {
      slug,
      itens,
      tipo_entrega,
      mesa,
      nome_cliente,
      endereco,
      payer_email,
    } = value;
// Email obrigatório e validado
    if (!payer_email || String(payer_email).trim().length === 0) {
      return res.status(400).json({
        mensagem: "Email do pagador é obrigatório para pagamentos Pix",
      });
    }

    const pEmailTrimmed = String(payer_email).trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(pEmailTrimmed)) {
      return res.status(400).json({
        mensagem: "Email inválido. Use um email válido.",
      });
    }

    try {
      const estabSnap = await db
        .collection("estabelecimentos")
        .where("slug", "==", slug)
        .limit(1)
        .get();

      if (estabSnap.empty) {
        return res
          .status(404)
          .json({ mensagem: "Estabelecimento não encontrado" });
      }

      // ID do estabelecimento garantido como String nativa do Firestore
      const establishmentId = String(estabSnap.docs[0].id);
      const estabData = estabSnap.docs[0].data();

      if (
        calcularStatusAssinatura(estabData.assinatura).status === "suspensa"
      ) {
        return responderPedidosIndisponiveis(res);
      }

      if (normalizarPlano(estabData.plano) === "barato") {
        return res.status(403).json({
          mensagem: "Pagamento via Pix não está disponível no plano atual.",
        });
      }

      let mpToken = estabData.mercadopago_access_token;

      if (!mpToken) {
        return res
          .status(400)
          .json({ mensagem: "Loja não configurou Mercado Pago" });
      }

      // Se está encriptado (novo formato), descriptografar
      try {
        if (mpToken.includes(":")) {
          mpToken = decryptSensitiveData(mpToken);
        }
      } catch (err) {
        logger.error("Erro ao descriptografar token Mercado Pago", err);
        return res.status(500).json({
          mensagem: "Erro ao acessar configuração de pagamento",
        });
      }

      // Calcula o total, valida os produtos e RESERVA o estoque atomicamente
      // (evita que dois pedidos Pix simultâneos vendam o mesmo estoque)
      let total = 0;
      let itensValidados = [];
      let reservaAplicada = false;

      try {
        await db.runTransaction(async (tx) => {
          const resultado = await reservarEstoqueDoEstabelecimento({
            db,
            tx,
            FieldValue,
            itens,
            establishmentId,
            mensagemProdutoInvalido: "Produto inválido no carrinho",
          });

          total = resultado.total;
          itensValidados = resultado.itensFinal;
          resultado.aplicarReservas();
        });

        reservaAplicada = true;
      } catch (err) {
        return res
          .status(err.statusCode || 500)
          .json({ mensagem: err.message || "Erro ao validar carrinho" });
      }

      // Configuração de ambiente do token Mercado Pago
      const rawMpToken = String(mpToken || "").trim();
      const isSandboxToken = /^TEST-/i.test(rawMpToken);
      const isLiveToken = /^APP_USR-/i.test(rawMpToken);
      const tokenMode = isSandboxToken
        ? "sandbox"
        : isLiveToken
          ? "live"
          : "unknown";

      if (tokenMode === "unknown") {
        return res.status(400).json({
          mensagem: "Token Mercado Pago inválido ou expirado.",
        });
      }

      const config = new MercadoPagoConfig({
        accessToken: rawMpToken,
        options: isSandboxToken ? { testToken: true } : {},
      });
      const paymentClient = new Payment(config);

      // ID de transação provisória aleatório
      const transacaoProvisoriaId = crypto.randomBytes(12).toString("hex");

      const pEmail = String(payer_email || "").trim();
      const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail);
      const placeholderEmail = `temp-${transacaoProvisoriaId}@example.com`;

      const paymentBody = {
        transaction_amount: Number(total) || 0,
        description: `Pagamento Provisório ${transacaoProvisoriaId}`,
        payment_method_id: "pix",
        external_reference: transacaoProvisoriaId,
        payer: {
          email: isValidEmail ? pEmail : placeholderEmail,
        },
      };

      const requestOptions = isSandboxToken ? { testToken: true } : undefined;
      let mpResponse;
      try {
        mpResponse = await paymentClient.create({
          body: paymentBody,
          requestOptions,
        });
      } catch (mpErr) {
        logger.error("Erro ao criar pagamento no Mercado Pago", {
          message: mpErr?.message,
          status: mpErr?.status || mpErr?.statusCode,
          cause: mpErr?.cause,
          tokenMode,
        });
        await liberarReservaEstoque(itensValidados);
        reservaAplicada = false;
        return res
          .status(500)
          .json({ mensagem: "Erro ao gerar cobrança no Mercado Pago" });
      }

      const mpBody = mpResponse.body || mpResponse.response || mpResponse;
      const txData = mpBody.point_of_interaction?.transaction_data || {};

      // Pedido Pix não pago expira em alguns minutos, liberando o estoque reservado
      const minutosExpiracao = Number(process.env.PIX_EXPIRATION_MINUTES) || 5;
      const expiraEm = Timestamp.fromMillis(
        Date.now() + minutosExpiracao * 60 * 1000,
      );

      // Salvamos o rascunho completo do pedido com TODAS as chaves padronizadas
      await db
        .collection("transacoes_pendentes_pix")
        .doc(transacaoProvisoriaId)
        .set({
          establishment_id: establishmentId,
          estabelecimento_id: establishmentId, // Mantemos ambas para garantir compatibilidade com buscas antigas
          forma_pagamento: "pix",
          itens: itensValidados,
          total,
          tipo_entrega: tipo_entrega || null,
          mesa: mesa || null,
          nome_cliente: nome_cliente || null,
          endereco: endereco || null,
          mercado_pago_id: String(mpBody.id),
          status: "aguardando_pagamento",
          created_at: FieldValue.serverTimestamp(),
          expira_em: expiraEm,
        });

      // A partir daqui a expiração automática (job) cuida de liberar o estoque
      reservaAplicada = false;

      res.json({
        mensagem: "Aguardando pagamento",
        transacao_id: transacaoProvisoriaId,
        total,
        mercado_pago: {
          id: mpBody.id,
          status: mpBody.status,
          qr_code: txData.qr_code || null,
          qr_code_base64: txData.qr_code_base64 || null,
          copia_e_cola: txData.qr_code || null,
        },
      });
    } catch (err) {
      logger.error("Erro ao iniciar fluxo Pix", err);
      if (reservaAplicada) {
        await liberarReservaEstoque(itensValidados);
      }
      res.status(500).json({ mensagem: "Erro ao processar transação" });
    }
  });

  // ROTA: Webhook de pagamentos Mercado Pago
  router.post("/pagamentos/webhook", webhookLimiter, async (req, res) => {
    if (bloquearMercadoPagoNoModoLocal(res)) return;

    try {
      const paymentId =
        req.body.data?.id ||
        req.query["data.id"] ||
        req.body.id ||
        req.query.id ||
        null;

      if (!paymentId) return res.json({ ok: true });

      const snapTransacao = await db
        .collection("transacoes_pendentes_pix")
        .where("mercado_pago_id", "==", String(paymentId))
        .limit(1)
        .get();

      if (snapTransacao.empty) {
        return res.json({ ok: true });
      }

      const transacaoDoc = snapTransacao.docs[0];
      const transacaoId = transacaoDoc.id;
      const transacaoData = transacaoDoc.data();

      const establishmentId = transacaoData.establishment_id;
      const estabDoc = await db
        .collection("estabelecimentos")
        .doc(establishmentId)
        .get();

      // A assinatura é validada com a chave secreta do PRÓPRIO estabelecimento (banco), nunca do .env
      let webhookSecret = estabDoc.exists
        ? estabDoc.data()?.mercadopago_secret_key
        : null;

      if (webhookSecret && webhookSecret.includes(":")) {
        try {
          webhookSecret = decryptSensitiveData(webhookSecret);
        } catch (err) {
          logger.error("Erro ao descriptografar chave secreta do webhook", err);
          webhookSecret = null;
        }
      }

      if (!webhookSecret || !validateMercadoPagoSignature(req, webhookSecret)) {
        logger.error("Webhook com assinatura inválida rejeitado");
        return res.status(401).json({ ok: false });
      }

      if (transacaoData.status === "processado_pago") {
        return res.json({ ok: true });
      }

      let mpToken = estabDoc.exists
        ? estabDoc.data()?.mercadopago_access_token
        : null;

      if (mpToken && mpToken.includes(":")) {
        mpToken = decryptSensitiveData(mpToken);
      }

      const configOptions = {};
      if (String(mpToken).startsWith("TEST-")) {
        configOptions.testToken = true;
      }

      const config = new MercadoPagoConfig({
        accessToken: mpToken,
        options: configOptions,
      });
      const paymentClient = new Payment(config);

      const mpGet = await paymentClient.get({
        id: paymentId,
        requestOptions: { testToken: String(mpToken).startsWith("TEST-") },
      });

      const mpInfo = mpGet.body || mpGet.response || mpGet;
      const status = mpInfo.status;

      if (status === "approved") {
        const pedidoRef = db.collection("pedidos").doc();
        let pedidoCriado = false;

        await db.runTransaction(async (tx) => {
          // Relê a transação dentro da tx para evitar processar duas vezes
          // (webhooks do Mercado Pago podem ser reenviados)
          const transacaoAtual = await tx.get(transacaoDoc.ref);
          if (
            !transacaoAtual.exists ||
            transacaoAtual.data().status !== "aguardando_pagamento"
          ) {
            return;
          }

          tx.set(pedidoRef, {
            establishment_id: establishmentId,
            itens: transacaoData.itens,
            total: transacaoData.total,
            forma_pagamento: "pix",
            estoque_baixado: false,
            tipo_entrega: transacaoData.tipo_entrega,
            mesa: transacaoData.mesa,
            nome_cliente: transacaoData.nome_cliente,
            endereco: transacaoData.endereco,
            status: "pago",
            mercado_pago: {
              id: paymentId,
              status: "approved",
            },
            created_at: FieldValue.serverTimestamp(),
          });

          tx.update(transacaoDoc.ref, {
            status: "processado_pago",
            pedido_criado_id: pedidoRef.id,
          });

          pedidoCriado = true;
        });

        if (pedidoCriado) {
          const io = req.app.get("io");
          if (io) {
            io.to(`estab_${establishmentId}`).emit("novoPedido", {
              pedido_id: pedidoRef.id,
              establishment_id: establishmentId,
              itens: transacaoData.itens,
              total: transacaoData.total,
              nome_cliente: transacaoData.nome_cliente,
              tipo_entrega: transacaoData.tipo_entrega,
              mesa: transacaoData.mesa,
            });
            io.to(`estab_${establishmentId}`).emit("pedidoPago", {
              pedido_id: pedidoRef.id,
            });
          }
        }
      } else if (["rejected", "cancelled"].includes(status)) {
        // Pagamento não vai mais acontecer: libera o estoque reservado
        // imediatamente em vez de esperar a expiração automática
        await db.runTransaction(async (tx) => {
          const transacaoAtual = await tx.get(transacaoDoc.ref);
          if (
            !transacaoAtual.exists ||
            transacaoAtual.data().status !== "aguardando_pagamento"
          ) {
            return;
          }

          const refs = transacaoData.itens.map((item) =>
            db.collection("produtos").doc(String(item.id)),
          );
          const docsProdutos = await Promise.all(
            refs.map((ref) => tx.get(ref)),
          );

          for (let i = 0; i < transacaoData.itens.length; i++) {
            const item = transacaoData.itens[i];
            const docProd = docsProdutos[i];

            if (docProd.exists && docProd.data().controla_estoque === true) {
              tx.update(refs[i], {
                estoque_reservado: FieldValue.increment(-item.quantidade),
              });
            }
          }

          tx.update(transacaoDoc.ref, { status: "cancelado" });
        });
      } else {
        console.log("⏳ Pagamento ainda não foi concluído.");
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("🔴 Erro crítico no webhook", err);
      return res.status(500).json({ mensagem: "Erro interno" });
    }
  });

  router.get("/transacao-pix/:id/status", publicLimiter, async (req, res) => {
    const { id } = req.params;
    try {
      const doc = await db.collection("transacoes_pendentes_pix").doc(id).get();
      if (!doc.exists) {
        return res
          .status(404)
          .json({ mensagem: "Transação temporária não encontrada" });
      }
      const data = doc.data();
      res.json({
        status: data.status,
        pedido_id: data.pedido_criado_id || null,
      });
    } catch (err) {
      res
        .status(500)
        .json({ mensagem: "Erro ao consultar status da transação" });
    }
  });

  router.get("/pedidos/:id/status", publicLimiter, async (req, res) => {
    const { id } = req.params;

    try {
      const pedidoDoc = await db.collection("pedidos").doc(id).get();
      if (pedidoDoc.exists) {
        const pedido = pedidoDoc.data();
        return res.json({
          pedido_id: pedidoDoc.id,
          status: normalizarStatusPedido(pedido.status),
          atualizado_em: pedido.updated_at || pedido.created_at || null,
        });
      }

      const historicoSnap = await db
        .collection("historico_pedidos")
        .where("pedido_id", "==", id)
        .limit(1)
        .get();

      if (!historicoSnap.empty) {
        const historico = historicoSnap.docs[0].data();
        return res.json({
          pedido_id: id,
          status: "finalizado",
          atualizado_em: historico.finalizado_at || null,
        });
      }

      return res.status(404).json({ mensagem: "Pedido não encontrado" });
    } catch (err) {
      logger.error("Erro ao consultar status do pedido", err);
      return res.status(500).json({ mensagem: "Erro ao consultar pedido" });
    }
  });

  router.get(
    "/admin/pedidos",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const establishmentId = req.user.establishmentId;

        const snap = await db
          .collection("pedidos")
          .where("establishment_id", "==", establishmentId)
          .where("status", "in", [
            "pendente",
            "pago",
            "aprovado",
            "preparando",
            "a_caminho",
          ])
          .orderBy("created_at", "desc")
          .get();

        const pedidos = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        res.json(pedidos);
      } catch (err) {
        logger.error("Erro ao buscar pedidos", err);
        res.status(500).json({ mensagem: "Erro ao buscar pedidos" });
      }
    },
  );

  router.delete(
    "/admin/pedidos/:id",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const establishmentId = req.user.establishmentId;

      try {
        await db.runTransaction(async (tx) => {
          const pedidoRef = db.collection("pedidos").doc(id);
          const pedidoDoc = await tx.get(pedidoRef);

          if (
            !pedidoDoc.exists ||
            pedidoDoc.data().establishment_id !== establishmentId
          ) {
            const err = new Error("Pedido não encontrado");
            err.statusCode = 404;
            throw err;
          }

          const itens = pedidoDoc.data().itens || [];
          const produtoRefs = itens.map((item) =>
            db.collection("produtos").doc(String(item.id)),
          );
          const produtoDocs = await Promise.all(
            produtoRefs.map((ref) => tx.get(ref)),
          );

          for (let i = 0; i < itens.length; i++) {
            const item = itens[i];
            const docProduto = produtoDocs[i];

            if (!docProduto.exists) continue;

            const produto = docProduto.data();

            // Produto de outro tenant nunca é alterado; a reserva não é dele.
            if (produto.establishment_id !== establishmentId) {
              logger.warn(
                `[EXCLUIR] Item do pedido ${id} aponta para produto de outro estabelecimento; ignorado.`,
              );
              continue;
            }

            if (produto.controla_estoque === true) {
              const reservadoAtual = Number(produto.estoque_reservado) || 0;
              const novoReservado = Math.max(
                reservadoAtual - item.quantidade,
                0,
              );

              tx.update(produtoRefs[i], { estoque_reservado: novoReservado });
            }
          }

          tx.delete(pedidoRef);
        });

        limparCacheDashboard(establishmentId);

        res.json({
          mensagem: "Pedido excluído e estoque corrigido!",
        });
      } catch (err) {
        logger.error("Erro ao excluir pedido", err);
        res
          .status(err.statusCode || 500)
          .json({ mensagem: err.message || "Erro ao excluir pedido" });
      }
    },
  );

  router.patch(
    "/admin/pedidos/:id/status",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const establishmentId = req.user.establishmentId;

      if (!["preparando", "a_caminho"].includes(status)) {
        return res.status(400).json({ mensagem: "Status inválido" });
      }

      try {
        const pedidoRef = db.collection("pedidos").doc(id);
        const pedidoDoc = await pedidoRef.get();

        if (
          !pedidoDoc.exists ||
          pedidoDoc.data().establishment_id !== establishmentId
        ) {
          return res.status(404).json({ mensagem: "Pedido não encontrado" });
        }

        await pedidoRef.update({
          status,
          updated_at: FieldValue.serverTimestamp(),
        });

        return res.json({ mensagem: "Status atualizado", status });
      } catch (err) {
        logger.error("Erro ao atualizar status do pedido", err);
        return res.status(500).json({ mensagem: "Erro ao atualizar status" });
      }
    },
  );

  router.put(
    "/admin/pedidos/:id/finalizar",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      const pedidoId = req.params.id;
      const establishmentId = req.user.establishmentId;

      logger.info(
        `[FINALIZAR] Iniciando finalização do pedido ${pedidoId} para establishment ${establishmentId}`,
      );

      try {
        const historicoRef = db.collection("historico_pedidos").doc();

        await db.runTransaction(async (tx) => {
          const pedidoRef = db.collection("pedidos").doc(pedidoId);
          const pedidoDoc = await tx.get(pedidoRef);

          if (
            !pedidoDoc.exists ||
            pedidoDoc.data().establishment_id !== establishmentId ||
            ![
              "pendente",
              "pago",
              "aprovado",
              "preparando",
              "a_caminho",
            ].includes(pedidoDoc.data().status)
          ) {
            const err = new Error("Pedido não encontrado");
            err.statusCode = 404;
            throw err;
          }

          const pedido = pedidoDoc.data();
          const itens = pedido.itens || [];
          const consumirEstoque = deveConsumirEstoqueNaFinalizacao(pedido);

          const produtoRefs = itens.map((item) =>
            db.collection("produtos").doc(String(item.id)),
          );
          const produtoDocs = await Promise.all(
            produtoRefs.map((ref) => tx.get(ref)),
          );

          for (let i = 0; i < itens.length; i++) {
            const item = itens[i];
            const docProduto = produtoDocs[i];

            if (!docProduto.exists) {
              const err = new Error("Produto não encontrado");
              err.statusCode = 400;
              throw err;
            }

            const produto = docProduto.data();

            if (produto.establishment_id !== establishmentId) {
              const err = new Error("Pedido inconsistente");
              err.statusCode = 409;
              throw err;
            }

            if (!consumirEstoque || produto.controla_estoque !== true) continue;

            const estoque = Number(produto.estoque) || 0;
            const reservado = Number(produto.estoque_reservado) || 0;
            const disponivel = estoque - reservado + item.quantidade;

            if (disponivel < item.quantidade) {
              const err = new Error(`Estoque insuficiente para ${item.nome}`);
              err.statusCode = 400;
              throw err;
            }
          }

          for (let i = 0; i < itens.length; i++) {
            const item = itens[i];
            const produto = produtoDocs[i].data();

            if (consumirEstoque && produto.controla_estoque === true) {
              tx.update(produtoRefs[i], {
                estoque: FieldValue.increment(-item.quantidade),
                estoque_reservado: FieldValue.increment(-item.quantidade),
              });
            }
          }

          tx.set(historicoRef, {
            pedido_id: pedidoId,
            establishment_id: pedido.establishment_id,
            itens,
            total: pedido.total,
            forma_pagamento: pedido.forma_pagamento,
            tipo_entrega: pedido.tipo_entrega,
            mesa: pedido.mesa,
            nome_cliente: pedido.nome_cliente,
            endereco: pedido.endereco,
            precisa_troco: pedido.precisa_troco || false,
            troco_para: pedido.troco_para ?? null,
            finalizado_at: FieldValue.serverTimestamp(),
          });

          tx.delete(pedidoRef);
        });

        limparCacheDashboard(establishmentId);

        res.json({
          mensagem: "Pedido finalizado com sucesso",
        });
      } catch (err) {
        logger.error("Erro ao finalizar pedido", err);
        res.status(err.statusCode || 500).json({
          mensagem: err.message || "Erro ao finalizar pedido",
        });
      }
    },
  );

  router.get(
    "/admin/historico",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const establishmentId = req.user.establishmentId;

        const snap = await db
          .collection("historico_pedidos")
          .where("establishment_id", "==", establishmentId)
          .orderBy("finalizado_at", "desc")
          .get();

        const historico = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        res.json(historico);
      } catch (err) {
        logger.error("Erro ao buscar histórico", err);
        res.status(500).json({ mensagem: "Erro ao buscar histórico" });
      }
    },
  );

  router.get(
    "/admin/faturamento",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    async (req, res) => {
      try {
        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;

        const planoAtual = normalizarPlano(req.user?.plan || req.user?.plano);
        const habilitadoParaFaturamento =
          req.user?.role === "superadmin" ||
          ["medio", "full"].includes(planoAtual);

        if (!habilitadoParaFaturamento) {
          return res.json({
            totalLojas: req.user?.role === "superadmin" ? 0 : 0,
            faturamento_total: 0,
            faturamento_semana: 0,
            faturamento_mes: 0,
            faturamento_hoje: 0,
            por_forma_pagamento: { dinheiro: 0, cartao: 0, pix: 0 },
            habilitadoParaFaturamento: false,
          });
        }

        if (!establishmentId && req.user?.role !== "superadmin") {
          return res.status(400).json({
            mensagem:
              "Identificador do estabelecimento não fornecido ou sessão inválida.",
          });
        }

        const agora = new Date();
        const inicioHoje = new Date(
          agora.getFullYear(),
          agora.getMonth(),
          agora.getDate(),
          0,
          0,
          0,
        );
        const fimHoje = new Date(
          agora.getFullYear(),
          agora.getMonth(),
          agora.getDate(),
          23,
          59,
          59,
        );

        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(agora.getDate() - 7);

        const trintaDiasAtras = new Date();
        trintaDiasAtras.setDate(agora.getDate() - 30);

        async function sumBetween(inicio, fim, formaPagamento) {
          let query = db.collection("historico_pedidos");

          if (establishmentId) {
            query = query.where("establishment_id", "==", establishmentId);
          }

          if (formaPagamento) {
            query = query.where("forma_pagamento", "==", formaPagamento);
          }

          query = query
            .where("finalizado_at", ">=", inicio)
            .where("finalizado_at", "<=", fim);

          try {
            const aggregateQuery = query.aggregate({
              total: AggregateField.sum("total"),
            });

            const snapshot = await aggregateQuery.get();
            return snapshot.data().total || 0;
          } catch (indexError) {
            logger.error(
              "Aviso/Erro no cálculo de faturamento (verifique os Índices do Firestore):",
              indexError,
            );

            try {
              let fallbackQuery = db
                .collection("historico_pedidos")
                .where("finalizado_at", ">=", inicio);
              fallbackQuery = fallbackQuery.where("finalizado_at", "<=", fim);

              const fallbackSnapshot = await fallbackQuery.get();
              return fallbackSnapshot.docs.reduce((sum, doc) => {
                const data = doc.data();
                if (
                  establishmentId &&
                  data.establishment_id !== establishmentId
                ) {
                  return sum;
                }
                if (formaPagamento && data.forma_pagamento !== formaPagamento) {
                  return sum;
                }
                const totalValue = Number(data.total || 0);
                return sum + (Number.isFinite(totalValue) ? totalValue : 0);
              }, 0);
            } catch (fallbackError) {
              logger.error(
                "Erro no fallback do cálculo de faturamento:",
                fallbackError,
              );
              return 0;
            }
          }
        }

        const [
          faturamento_total,
          faturamento_semana,
          faturamento_mes,
          faturamento_hoje,
        ] = await Promise.all([
          sumBetween(
            Timestamp.fromDate(new Date(0)),
            Timestamp.fromDate(agora),
          ),
          sumBetween(
            Timestamp.fromDate(seteDiasAtras),
            Timestamp.fromDate(agora),
          ),
          sumBetween(
            Timestamp.fromDate(trintaDiasAtras),
            Timestamp.fromDate(agora),
          ),
          sumBetween(
            Timestamp.fromDate(inicioHoje),
            Timestamp.fromDate(fimHoje),
          ),
        ]);

        let totalLojasAtivas = 0;
        if (req.user?.role === "superadmin") {
          const lojasSnap = await db.collection("estabelecimentos").get();
          totalLojasAtivas = lojasSnap.size;
        }

        const [porDinheiro, porCartao, porPix] = await Promise.all([
          sumBetween(
            Timestamp.fromDate(new Date(0)),
            Timestamp.fromDate(agora),
            "dinheiro",
          ),
          sumBetween(
            Timestamp.fromDate(new Date(0)),
            Timestamp.fromDate(agora),
            "cartao",
          ),
          sumBetween(
            Timestamp.fromDate(new Date(0)),
            Timestamp.fromDate(agora),
            "pix",
          ),
        ]);

        res.json({
          totalLojas: totalLojasAtivas,
          faturamento_total,
          faturamento_semana,
          faturamento_mes,
          faturamento_hoje,
          por_forma_pagamento: {
            dinheiro: porDinheiro,
            cartao: porCartao,
            pix: porPix,
          },
        });
      } catch (error) {
        logger.error("Erro ao calcular faturamento", error);
        res.status(500).json({ mensagem: "Erro ao calcular faturamento" });
      }
    },
  );

  // Painel completo com visão geral da loja: exclusivo do plano Full.
  // Nunca aceita establishmentId vindo do cliente — usa apenas o da sessão autenticada.
  router.get(
    "/admin/dashboard-full",
    instrumentarMiddlewareDashboard("autenticacao", verificarToken),
    instrumentarMiddlewareDashboard("csrf", verificarCSRF),
    instrumentarMiddlewareDashboard("assinatura", verificarAssinatura),
    instrumentarMiddlewareDashboard(
      "autorizacao_plano",
      verificarPlanoMinimo("full"),
    ),
    async (req, res) => {
      try {
        const establishmentId =
          req.user?.establishmentId || req.user?.establishment_id;

        if (!establishmentId) {
          return res.status(400).json({
            mensagem:
              "Este painel está disponível apenas para uma conta vinculada a um estabelecimento.",
          });
        }

        const periodoSolicitado = Number(req.query.periodo) || 30;
        const periodoAtivo = [7, 30, 90, 365].includes(periodoSolicitado)
          ? periodoSolicitado
          : 30;
        const inicioRota = process.hrtime.bigint();
        const metricas = { consultas: 0, etapas: {} };
        const cacheKey = dashboardCacheKey(req, establishmentId, periodoAtivo);
        const cacheAtual = dashboardCache.get(cacheKey);

        if (cacheAtual && cacheAtual.expiraEm > Date.now()) {
          if (dashboardPerfLog) {
            logger.info(
              `[DASHBOARD_PERF] cache_hit estabelecimento=${establishmentId} periodo=${periodoAtivo} total_ms=${Number(process.hrtime.bigint() - inicioRota) / 1e6}`,
            );
          }
          return res.json(cacheAtual.dados);
        }

        async function medir(etapa, operacao) {
          const inicio = process.hrtime.bigint();
          const resultado = await operacao();
          metricas.etapas[etapa] =
            Number(process.hrtime.bigint() - inicio) / 1e6;
          return resultado;
        }

        function registrarConsulta() {
          metricas.consultas += 1;
        }

        function imagemProdutoSegura(valor) {
          if (typeof valor !== "string" || !valor.trim()) return null;

          try {
            const url = new URL(valor);
            return url.protocol === "https:" &&
                url.origin === "https://res.cloudinary.com"
              ? url.href
              : null;
          } catch {
            return null;
          }
        }

        const agora = new Date();
        const inicioHoje = new Date(
          agora.getFullYear(),
          agora.getMonth(),
          agora.getDate(),
          0,
          0,
          0,
        );
        const fimHoje = new Date(
          agora.getFullYear(),
          agora.getMonth(),
          agora.getDate(),
          23,
          59,
          59,
        );
        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(agora.getDate() - 7);
        const trintaDiasAtras = new Date();
        trintaDiasAtras.setDate(agora.getDate() - 30);

        async function somarPeriodo(inicio, fim, formaPagamento) {
          let query = db
            .collection("historico_pedidos")
            .where("establishment_id", "==", establishmentId);

          if (formaPagamento) {
            query = query.where("forma_pagamento", "==", formaPagamento);
          }

          query = query
            .where("finalizado_at", ">=", inicio)
            .where("finalizado_at", "<=", fim);

          registrarConsulta();
          const snap = await query
            .aggregate({ total: AggregateField.sum("total") })
            .get();
          return snap.data().total || 0;
        }

        async function contarDocumentos(query) {
          registrarConsulta();
          const snap = await query.count().get();
          return snap.data().count || 0;
        }

        function dataDoHistorico(doc) {
          const valor = doc.finalizado_at;
          return valor && typeof valor.toDate === "function"
            ? valor.toDate()
            : new Date(valor);
        }

        function somarHistoricoPeriodo(historico, inicio, fim) {
          return historico.reduce((soma, doc) => {
            const data = dataDoHistorico(doc);
            if (data < inicio || data > fim) return soma;
            const valor = Number(doc.total || 0);
            return soma + (Number.isFinite(valor) ? valor : 0);
          }, 0);
        }

        function gerarEvolucaoVendas(historico, dias) {
          const labels = [];
          const valores = [];

          if (dias <= 7) {
            for (let i = dias - 1; i >= 0; i -= 1) {
              const dataInicio = new Date(agora);
              dataInicio.setHours(0, 0, 0, 0);
              dataInicio.setDate(agora.getDate() - i);
              const dataFim = new Date(dataInicio);
              dataFim.setHours(23, 59, 59, 999);
              const valor = somarHistoricoPeriodo(
                historico,
                dataInicio,
                dataFim,
              );

              labels.push(
                dataInicio.toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                }),
              );
              valores.push(valor);
            }
            return { labels, valores };
          }

          if (dias <= 30) {
            for (let i = dias - 1; i >= 0; i -= 1) {
              const dataInicio = new Date(agora);
              dataInicio.setHours(0, 0, 0, 0);
              dataInicio.setDate(agora.getDate() - i);
              const dataFim = new Date(dataInicio);
              dataFim.setHours(23, 59, 59, 999);
              const valor = somarHistoricoPeriodo(
                historico,
                dataInicio,
                dataFim,
              );

              labels.push(
                dataInicio.toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                }),
              );
              valores.push(valor);
            }
            return { labels, valores };
          }

          if (dias <= 90) {
            for (let i = 11; i >= 0; i -= 1) {
              const inicio = new Date(agora);
              inicio.setDate(agora.getDate() - (i + 1) * 7);
              inicio.setHours(0, 0, 0, 0);
              const fim = new Date(agora);
              fim.setDate(agora.getDate() - i * 7);
              fim.setHours(23, 59, 59, 999);
              const valor = somarHistoricoPeriodo(historico, inicio, fim);

              labels.push(
                `${inicio.toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                })}`,
              );
              valores.push(valor);
            }
            return { labels, valores };
          }

          for (let i = 11; i >= 0; i -= 1) {
            const dataInicio = new Date(
              agora.getFullYear(),
              agora.getMonth() - i,
              1,
            );
            const dataFim = new Date(
              agora.getFullYear(),
              agora.getMonth() - i + 1,
              0,
              23,
              59,
              59,
              999,
            );

            const valor = somarHistoricoPeriodo(historico, dataInicio, dataFim);

            labels.push(
              dataInicio.toLocaleDateString("pt-BR", {
                month: "short",
              }),
            );
            valores.push(valor);
          }

          return { labels, valores };
        }

        function gerarRankingProdutos(historico, imagensProdutos) {
          const mapa = {};

          historico.forEach((pedido) => {
            (pedido.itens || []).forEach((item) => {
              const chave = item.id || item.nome || Math.random().toString(36);
              const quantidade = Number(item.quantidade || 0);
              const subtotal = Number(item.subtotal || 0);

              if (!mapa[chave]) {
                mapa[chave] = {
                  id: item.id || null,
                  nome: item.nome || "Produto",
                  imagem:
                    imagemProdutoSegura(item.imagem) ||
                    (item.id
                      ? imagemProdutoSegura(imagensProdutos.get(item.id))
                      : null) ||
                    null,
                  quantidade: 0,
                  faturamento: 0,
                };
              }

              mapa[chave].quantidade += quantidade;
              mapa[chave].faturamento +=
                Number.isFinite(subtotal) && subtotal > 0
                  ? subtotal
                  : Number(item.preco || 0) * quantidade;
            });
          });

          return Object.values(mapa)
            .sort(
              (a, b) =>
                b.quantidade - a.quantidade || b.faturamento - a.faturamento,
            )
            .slice(0, 5);
        }

        async function buscarHistoricoDashboard() {
          const inicio = new Date(agora);
          inicio.setHours(0, 0, 0, 0);
          inicio.setDate(agora.getDate() - periodoAtivo);

          registrarConsulta();
          const snap = await db
            .collection("historico_pedidos")
            .where("establishment_id", "==", establishmentId)
            .where("finalizado_at", ">=", Timestamp.fromDate(inicio))
            .where("finalizado_at", "<=", Timestamp.fromDate(agora))
            .orderBy("finalizado_at", "desc")
            .select("finalizado_at", "total", "itens")
            .get();

          return snap.docs.map((doc) => doc.data());
        }

        async function gerarUltimosPedidos(establishmentIdLocal, limite = 5) {
          registrarConsulta();
          const snap = await db
            .collection("historico_pedidos")
            .where("establishment_id", "==", establishmentIdLocal)
            .orderBy("finalizado_at", "desc")
            .limit(limite)
            .select(
              "numero_pedido",
              "total",
              "forma_pagamento",
              "status",
              "finalizado_at",
            )
            .get();

          return snap.docs.map((doc) => {
            const dados = doc.data();
            return {
              id: doc.id,
              numero:
                dados.numero_pedido || `#${doc.id.slice(0, 4).toUpperCase()}`,
              total: Number(dados.total || 0),
              forma_pagamento: dados.forma_pagamento || "pix",
              status: dados.status || "finalizado",
              finalizado_at: dados.finalizado_at || null,
            };
          });
        }

        const faturamentoPromise = medir("faturamento", () =>
          Promise.all([
            somarPeriodo(
              Timestamp.fromDate(new Date(0)),
              Timestamp.fromDate(agora),
            ),
            somarPeriodo(
              Timestamp.fromDate(seteDiasAtras),
              Timestamp.fromDate(agora),
            ),
            somarPeriodo(
              Timestamp.fromDate(trintaDiasAtras),
              Timestamp.fromDate(agora),
            ),
            somarPeriodo(
              Timestamp.fromDate(inicioHoje),
              Timestamp.fromDate(fimHoje),
            ),
            somarPeriodo(
              Timestamp.fromDate(new Date(0)),
              Timestamp.fromDate(agora),
              "dinheiro",
            ),
            somarPeriodo(
              Timestamp.fromDate(new Date(0)),
              Timestamp.fromDate(agora),
              "cartao",
            ),
            somarPeriodo(
              Timestamp.fromDate(new Date(0)),
              Timestamp.fromDate(agora),
              "pix",
            ),
          ]),
        );
        const contagensPromise = medir("contagens", () =>
          Promise.all([
            contarDocumentos(
              db
                .collection("pedidos")
                .where("establishment_id", "==", establishmentId)
                .where("status", "in", [
                  "pendente",
                  "pago",
                  "aprovado",
                  "preparando",
                  "a_caminho",
                ]),
            ),
            contarDocumentos(
              db
                .collection("historico_pedidos")
                .where("establishment_id", "==", establishmentId),
            ),
          ]),
        );
        const produtosPromise = medir("produtos", () => {
          registrarConsulta();
          return db
            .collection("produtos")
            .where("establishment_id", "==", establishmentId)
            .select("controla_estoque", "estoque", "imagem")
            .get();
        });
        const estabelecimentoPromise = medir("estabelecimento", () => {
          registrarConsulta();
          return db.collection("estabelecimentos").doc(establishmentId).get();
        });
        const historicoPromise = medir(
          "evolucao_ranking",
          buscarHistoricoDashboard,
        );
        const ultimosPedidosPromise = medir("ultimos_pedidos", () =>
          gerarUltimosPedidos(establishmentId, 5),
        );

        const [
          [
            faturamentoTotal,
            faturamentoSemana,
            faturamentoMes,
            faturamentoHoje,
            porDinheiro,
            porCartao,
            porPix,
          ],
          [pedidosAtivos, pedidosFinalizados],
          produtosSnap,
          estabDoc,
          historicoDashboard,
          ultimosPedidos,
        ] = await Promise.all([
          faturamentoPromise,
          contagensPromise,
          produtosPromise,
          estabelecimentoPromise,
          historicoPromise,
          ultimosPedidosPromise,
        ]);

        const evolucaoVendas = gerarEvolucaoVendas(
          historicoDashboard,
          periodoAtivo,
        );
        const imagensProdutos = new Map(
          produtosSnap.docs.map((doc) => [
            doc.id,
            imagemProdutoSegura(doc.data().imagem),
          ]),
        );
        const produtosMaisVendidos = gerarRankingProdutos(
          historicoDashboard,
          imagensProdutos,
        );

        const produtos = produtosSnap.docs.map((doc) =>
          comEsgotado(doc.data()),
        );
        const totalProdutos = produtos.length;
        const produtosEsgotados = produtos.filter((p) => p.esgotado).length;
        const produtosBaixoEstoque = produtos.filter(
          (p) =>
            p.controla_estoque === true &&
            Number(p.estoque || 0) > 0 &&
            Number(p.estoque || 0) <= 5,
        ).length;
        const produtosDisponiveis = produtos.filter(
          (p) => p.controla_estoque !== true || Number(p.estoque || 0) > 5,
        ).length;

        const ticketMedio =
          pedidosFinalizados > 0
            ? Number((faturamentoTotal / pedidosFinalizados).toFixed(2))
            : 0;

        const estabData = estabDoc.exists ? estabDoc.data() : {};

        const dadosDashboard = {
          estabelecimento: {
            nome: estabData.nome || null,
            plano: normalizarPlano(estabData.plano || req.user?.plan),
            ativo: estabData.ativo !== false,
          },
          faturamento: {
            total: faturamentoTotal,
            semana: faturamentoSemana,
            mes: faturamentoMes,
            hoje: faturamentoHoje,
          },
          por_forma_pagamento: {
            dinheiro: porDinheiro,
            cartao: porCartao,
            pix: porPix,
          },
          pedidos: {
            ativos: pedidosAtivos,
            finalizados: pedidosFinalizados,
            ticketMedio,
            ultimos: ultimosPedidos,
          },
          produtos: {
            total: totalProdutos,
            esgotados: produtosEsgotados,
            baixo_estoque: produtosBaixoEstoque,
            disponiveis: produtosDisponiveis,
            mais_vendidos: produtosMaisVendidos,
          },
          evolucao_vendas: evolucaoVendas,
          periodo_selecionado: periodoAtivo,
        };

        dashboardCache.set(cacheKey, {
          expiraEm: Date.now() + DASHBOARD_CACHE_TTL_MS,
          dados: dadosDashboard,
        });

        if (dashboardPerfLog) {
          logger.info(
            `[DASHBOARD_PERF] estabelecimento=${establishmentId} periodo=${periodoAtivo} total_ms=${Number(process.hrtime.bigint() - inicioRota) / 1e6} consultas=${metricas.consultas} etapas=${JSON.stringify(metricas.etapas)}`,
          );
        }

        res.json(dadosDashboard);
      } catch (error) {
        logger.error("Erro ao montar dashboard full", error);
        res.status(500).json({ mensagem: "Erro ao carregar o dashboard." });
      }
    },
  );

  router.get(
    "/admin/pedidos-arquivados",
    verificarToken,
    verificarCSRF,
    verificarAssinatura,
    verificarPlanoMinimo("medio"),
    async (req, res) => {
      try {
        const establishmentId = req.user.establishmentId;

        const snap = await db
          .collection("historico_pedidos_arquivados")
          .where("establishment_id", "==", establishmentId)
          .orderBy("arquivado_em", "desc")
          .get();

        const arquivados = snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        res.json(arquivados);
      } catch (error) {
        logger.error("Erro ao buscar pedidos arquivados", error);
        res.status(500).json({
          mensagem: "Erro ao buscar pedidos arquivados",
        });
      }
    },
  );

  return router;
};
