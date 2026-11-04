const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");

assert.equal(
  process.env.USE_FIREBASE_EMULATOR,
  "true",
  "Teste exige USE_FIREBASE_EMULATOR=true",
);

const {
  db: dbReal,
  auth: authReal,
  FieldValue,
  Timestamp,
  AggregateField,
} = require("../../config/firebase");
const createApi = require("../../api");

const EMAIL_PADRAO = "default-sa@vendly.test";
process.env.DEFAULT_SUPERADMIN_EMAIL = EMAIL_PADRAO;

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// Flags de falha simulada, consultadas pelos proxies de db e auth.
const falhas = {};

const auth = new Proxy(authReal, {
  get(target, prop) {
    const valor = target[prop];
    if (prop === "updateUser" && falhas.authUpdate) {
      return async () => {
        const err = new Error("falha simulada auth");
        err.code = "auth/internal-error";
        throw err;
      };
    }
    if (prop === "deleteUser" && falhas.authDelete) {
      return async () => {
        const err = new Error("falha simulada auth delete");
        err.code = "auth/internal-error";
        throw err;
      };
    }
    return typeof valor === "function" ? valor.bind(target) : valor;
  },
});

function envolverRef(ref, colecao) {
  return new Proxy(ref, {
    get(target, prop) {
      if (
        prop === "update" &&
        colecao === "admin" &&
        falhas.adminUpdate
      ) {
        return async () => {
          throw new Error("falha simulada firestore");
        };
      }
      if (
        prop === "delete" &&
        colecao === "admin" &&
        falhas.adminDelete
      ) {
        return async () => {
          throw new Error("falha simulada delete");
        };
      }
      const valor = target[prop];
      return typeof valor === "function" ? valor.bind(target) : valor;
    },
  });
}

const db = new Proxy(dbReal, {
  get(target, prop) {
    if (prop === "collection") {
      return (nome) => {
        const col = target.collection(nome);
        return new Proxy(col, {
          get(c, p) {
            if (p === "doc") {
              return (...args) => envolverRef(c.doc(...args), nome);
            }
            const v = c[p];
            return typeof v === "function" ? v.bind(c) : v;
          },
        });
      };
    }
    if (prop === "runTransaction") {
      return (fn, ...resto) =>
        target.runTransaction((tx) => {
          if (!falhas.segundaEscritaTx) return fn(tx);
          let escritas = 0;
          const txEnvolvida = new Proxy(tx, {
            get(t, p) {
              const v = t[p];
              if (p === "update") {
                return (...a) => {
                  if (++escritas === 2) throw new Error("falha simulada tx");
                  return v.apply(t, a);
                };
              }
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
          return fn(txEnvolvida);
        }, ...resto);
    }
    const valor = target[prop];
    return typeof valor === "function" ? valor.bind(target) : valor;
  },
});

function criarApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/",
    createApi({
      db,
      auth,
      FieldValue,
      Timestamp,
      AggregateField,
      verificarToken(req, res, next) {
        const role = req.get("x-test-role") || "admin";
        req.user = {
          uid: req.get("x-test-uid") || "test-user-chamador",
          establishmentId: req.get("x-test-estab") || null,
          role,
          plan: "full",
          email: req.get("x-test-email") || "admin@vendly.test",
        };
        next();
      },
      verificarCSRF(req, res, next) {
        if (req.get("x-csrf-token") !== "emulator-csrf") {
          return res
            .status(403)
            .json({ mensagem: "CSRF inválido.", code: "CSRF_INVALIDO" });
        }
        next();
      },
      verificarSuperAdmin(req, res, next) {
        if (req.user?.role !== "superadmin") {
          return res.status(403).json({ mensagem: "Acesso negado!" });
        }
        next();
      },
      upload: { single: () => (req, res, next) => next() },
      loginLimiter: (req, res, next) => next(),
      webhookLimiter: (req, res, next) => next(),
      subscriptionPaymentLimiter: (req, res, next) => next(),
      publicLimiter: (req, res, next) => next(),
      logger,
    }),
  );
  return app;
}

async function iniciar(context) {
  Object.keys(falhas).forEach((k) => delete falhas[k]);
  const server = criarApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Por padrão age como superadmin comum (não o padrão).
  return (
    path,
    { method = "PUT", body, role = "superadmin", email, uid, estab, csrf = true } = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
        ...(email ? { "x-test-email": email } : {}),
        ...(uid ? { "x-test-uid": uid } : {}),
        ...(estab ? { "x-test-estab": estab } : {}),
        ...(csrf ? { "x-csrf-token": "emulator-csrf" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

async function criarAdminFicticio(context, extra = {}, estabId = null) {
  const id = `sec-new-${randomUUID()}`;
  const email = `${id}@vendly.test`;
  await authReal.createUser({ uid: id, email, password: randomUUID() });
  const ref = dbReal.collection("admin").doc(id);
  await ref.set({
    email,
    role: "admin",
    active: true,
    plan: "medio",
    establishment_id: estabId,
    ...extra,
  });
  context.after(async () => {
    await ref.delete();
    await authReal.deleteUser(id).catch(() => {});
  });
  return { id, email, ref };
}

async function criarLoja(context, extra = {}) {
  const id = `sec-new-loja-${randomUUID()}`;
  const ref = dbReal.collection("estabelecimentos").doc(id);
  await ref.set({
    nome: `Loja ${id}`,
    slug: `menu-${id}`,
    status: "active",
    plano: "medio",
    ...extra,
  });
  context.after(() => ref.delete());
  return { id, ref };
}

const dias = (n) => Timestamp.fromMillis(Date.now() - n * 24 * 60 * 60 * 1000);

test("status: desativar e reativar atualiza Firestore e Auth", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);

  let r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: false },
  });
  assert.equal(r.status, 200);
  assert.equal((await alvo.ref.get()).data().active, false);
  assert.equal((await authReal.getUser(alvo.id)).disabled, true);

  r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: true },
  });
  assert.equal(r.status, 200);
  const dados = (await alvo.ref.get()).data();
  assert.equal(dados.active, true);
  assert.equal(dados.deactivated_at, null);
  assert.equal((await authReal.getUser(alvo.id)).disabled, false);
});

test("status: falha no Auth ao desativar não altera nada e não retorna sucesso", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);
  falhas.authUpdate = true;

  const r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: false },
  });
  assert.equal(r.status, 502);
  assert.equal((await alvo.ref.get()).data().active, true);
  assert.equal((await authReal.getUser(alvo.id)).disabled, false);
});

test("status: falha no Firestore ao desativar compensa o Auth e sinaliza falha parcial", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);
  falhas.adminUpdate = true;

  const r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: false },
  });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, "STATUS_PARCIAL");
  // Firestore continuava ativo e o Auth estava habilitado antes: voltou ao estado original.
  assert.equal((await alvo.ref.get()).data().active, true);
  assert.equal((await authReal.getUser(alvo.id)).disabled, false);
});

test("status: compensação não reativa conta que já estava desabilitada no Auth", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);
  await authReal.updateUser(alvo.id, { disabled: true });
  falhas.adminUpdate = true;

  const r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: false },
  });
  assert.equal(r.status, 502);
  assert.equal((await authReal.getUser(alvo.id)).disabled, true);
});

test("status: falha no Auth ao ativar reverte o Firestore e a conta segue bloqueada", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context, {
    active: false,
    deactivated_at: dias(1),
  });
  await authReal.updateUser(alvo.id, { disabled: true });
  falhas.authUpdate = true;

  const r = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: true },
  });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, "STATUS_PARCIAL");
  const dados = (await alvo.ref.get()).data();
  assert.equal(dados.active, false);
  assert.ok(dados.deactivated_at);
  assert.equal((await authReal.getUser(alvo.id)).disabled, true);

  // Reenvio sem falha reconcilia.
  falhas.authUpdate = false;
  const ok = await chamar(`/admin/${alvo.id}/status`, {
    method: "PATCH",
    body: { active: true },
  });
  assert.equal(ok.status, 200);
  assert.equal((await authReal.getUser(alvo.id)).disabled, false);
});

test("status: admin comum, CSRF inválido, payload inválido e superadmin alvo", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);
  const outroSa = await criarAdminFicticio(context, { role: "superadmin" });

  const path = `/admin/${alvo.id}/status`;
  assert.equal(
    (await chamar(path, { method: "PATCH", role: "admin", body: { active: false } })).status,
    403,
  );
  assert.equal(
    (await chamar(path, { method: "PATCH", csrf: false, body: { active: false } })).status,
    403,
  );
  assert.equal(
    (await chamar(path, { method: "PATCH", body: { active: "false" } })).status,
    400,
  );
  assert.equal(
    (await chamar(`/admin/${outroSa.id}/status`, { method: "PATCH", body: { active: false } })).status,
    403,
  );
  assert.equal((await authReal.getUser(alvo.id)).disabled, false);
  assert.equal((await authReal.getUser(outroSa.id)).disabled, false);
});

test("conta desativada não consegue gerar token de login (Auth disabled)", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarAdminFicticio(context);
  await chamar(`/admin/${alvo.id}/status`, { method: "PATCH", body: { active: false } });

  await assert.rejects(
    authReal.updateUser(alvo.id, {}).then(async () => {
      const u = await authReal.getUser(alvo.id);
      if (u.disabled) throw new Error("conta desabilitada");
    }),
    /desabilitada/,
  );
});

test("plano: superadmin atualiza estabelecimento e admin juntos", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvo = await criarAdminFicticio(context, {}, loja.id);

  const r = await chamar(`/admin/${alvo.id}/plan`, { body: { plan: "full" } });
  assert.equal(r.status, 200);
  assert.equal((await loja.ref.get()).data().plano, "full");
  assert.equal((await alvo.ref.get()).data().plan, "full");
});

test("plano: admin comum não altera por nenhuma das rotas", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvo = await criarAdminFicticio(context, {}, loja.id);

  assert.equal(
    (await chamar(`/admin/${alvo.id}/plan`, { role: "admin", estab: loja.id, body: { plan: "full" } })).status,
    403,
  );
  assert.equal(
    (await chamar(`/estabelecimentos/${loja.id}/dados`, { role: "admin", estab: loja.id, body: { plan: "full" } })).status,
    403,
  );
  assert.equal((await loja.ref.get()).data().plano, "medio");
  assert.equal((await alvo.ref.get()).data().plan, "medio");
});

test("plano: falha em uma escrita não deixa gravação parcial", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvo = await criarAdminFicticio(context, {}, loja.id);
  falhas.segundaEscritaTx = true;

  const r = await chamar(`/admin/${alvo.id}/plan`, { body: { plan: "full" } });
  assert.equal(r.status, 500);
  assert.equal((await loja.ref.get()).data().plano, "medio");
  assert.equal((await alvo.ref.get()).data().plan, "medio");
});

test("plano: admin ou loja inexistente retorna 404 sem criar documentos", async (context) => {
  const chamar = await iniciar(context);
  const semLoja = await criarAdminFicticio(context, {}, `inexistente-${randomUUID()}`);

  assert.equal(
    (await chamar(`/admin/nao-existe-${randomUUID()}/plan`, { body: { plan: "full" } })).status,
    404,
  );
  assert.equal(
    (await chamar(`/admin/${semLoja.id}/plan`, { body: { plan: "full" } })).status,
    404,
  );
  assert.equal(
    (await dbReal.collection("estabelecimentos").doc(semLoja.id).get()).exists,
    false,
  );
});

test("plano via PUT /dados também mantém admin.plan consistente", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvo = await criarAdminFicticio(context, {}, loja.id);

  const r = await chamar(`/estabelecimentos/${loja.id}/dados`, { body: { plan: "barato" } });
  assert.equal(r.status, 200);
  assert.equal((await loja.ref.get()).data().plano, "barato");
  assert.equal((await alvo.ref.get()).data().plan, "barato");
});

async function criarInativoAntigo(context, extra = {}, estabId = null) {
  const a = await criarAdminFicticio(
    context,
    { active: false, deactivated_at: dias(10), ...extra },
    estabId,
  );
  await authReal.updateUser(a.id, { disabled: true });
  return a;
}

const limpar = (chamar, body, opcoes = {}) =>
  chamar("/admin/inativos/limpeza", { method: "POST", email: EMAIL_PADRAO, body, ...opcoes });

test("limpeza: dry-run é o padrão e não exclui nada", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const alvo = await criarInativoAntigo(context, {}, loja.id);

  const r = await limpar(chamar, undefined);
  assert.equal(r.status, 200);
  const corpo = await r.json();
  assert.equal(corpo.dryRun, true);
  assert.ok(corpo.ids.includes(alvo.id));
  assert.ok(corpo.estabelecimentos_preservados.includes(loja.id));
  assert.equal((await alvo.ref.get()).exists, true);
  await authReal.getUser(alvo.id);
});

test("limpeza: exclusão real exige confirmação e remove só inativos antigos fictícios", async (context) => {
  const chamar = await iniciar(context);
  const loja = await criarLoja(context);
  const antigo = await criarInativoAntigo(context, {}, loja.id);
  const recente = await criarAdminFicticio(context, { active: false, deactivated_at: dias(1) });
  const ativo = await criarAdminFicticio(context);
  const superInativo = await criarInativoAntigo(context, { role: "superadmin" });
  const padrao = await criarInativoAntigo(context, { email: EMAIL_PADRAO });

  const semConfirmar = await limpar(chamar, { dryRun: false });
  assert.equal(semConfirmar.status, 400);
  assert.equal((await antigo.ref.get()).exists, true);

  const r = await limpar(chamar, { dryRun: false, confirmar: "EXCLUIR_DEFINITIVAMENTE" });
  assert.equal(r.status, 200);
  const corpo = await r.json();
  assert.ok(corpo.removidos >= 1);

  assert.equal((await antigo.ref.get()).exists, false);
  await assert.rejects(authReal.getUser(antigo.id), (e) => e.code === "auth/user-not-found");
  for (const preservado of [recente, ativo, superInativo, padrao]) {
    assert.equal((await preservado.ref.get()).exists, true, preservado.id);
  }
  // O estabelecimento vinculado nunca é apagado.
  assert.equal((await loja.ref.get()).exists, true);
});

test("limpeza: admin comum, superadmin não padrão e CSRF inválido são negados", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarInativoAntigo(context);
  const corpo = { dryRun: false, confirmar: "EXCLUIR_DEFINITIVAMENTE" };

  assert.equal((await limpar(chamar, corpo, { role: "admin" })).status, 403);
  assert.equal((await limpar(chamar, corpo, { email: "outro-sa@vendly.test" })).status, 403);
  assert.equal((await limpar(chamar, corpo, { csrf: false })).status, 403);
  assert.equal((await limpar(chamar, { dryRun: "false" })).status, 400);
  assert.equal((await limpar(chamar, { extra: 1 })).status, 400);
  assert.equal((await alvo.ref.get()).exists, true);
});

test("limpeza: falha parcial retorna 207, preserva o doc e a repetição conclui", async (context) => {
  const chamar = await iniciar(context);
  const alvo = await criarInativoAntigo(context);
  falhas.authDelete = true;

  const r = await limpar(chamar, { dryRun: false, confirmar: "EXCLUIR_DEFINITIVAMENTE" });
  assert.equal(r.status, 207);
  assert.ok((await r.json()).falhas.includes(alvo.id));
  // Falha no Auth: nada foi apagado; a próxima execução conclui.
  assert.equal((await alvo.ref.get()).exists, true);
  await authReal.getUser(alvo.id);

  falhas.authDelete = false;
  const ok = await limpar(chamar, { dryRun: false, confirmar: "EXCLUIR_DEFINITIVAMENTE" });
  assert.equal(ok.status, 200);
  assert.equal((await alvo.ref.get()).exists, false);
});
