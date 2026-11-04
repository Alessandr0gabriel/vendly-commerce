const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulo = pathToFileURL(
  path.join(__dirname, "../../frontend/js/ui/modais.js"),
).href;

function criarDom(ids) {
  const elementos = ids.map((id) => {
    const classes = new Set(["panel-form-view"]);
    return {
      id,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    };
  });
  const padrao = { classList: { add() {}, remove() {} } };
  global.document = {
    getElementById: (id) =>
      elementos.find((e) => e.id === id) ||
      (id === "panelDefaultContent" || id === "panelLoading" ? padrao : null),
    querySelectorAll: () =>
      elementos.filter((e) => e.classList.contains("active")),
  };
  return elementos;
}

const ativos = (els) => els.filter((e) => e.classList.contains("active"));

test("apenas uma view do painel fica ativa ao alternar, repetir e abrir em sequência", async () => {
  const { abrirModal, fecharModal, registerModalHooks } = await import(modulo);
  let fechamentos = 0;
  registerModalHooks({ afterCloseAssinatura: () => fechamentos++ });
  const els = criarDom(["modalProduto", "modalDados", "modalAssinatura"]);

  await abrirModal("produto");
  await abrirModal("assinatura");
  assert.deepEqual(ativos(els).map((e) => e.id), ["modalAssinatura"]);

  await Promise.all([abrirModal("assinatura"), abrirModal("assinatura")]);
  await abrirModal("assinatura");
  assert.deepEqual(ativos(els).map((e) => e.id), ["modalAssinatura"]);

  await abrirModal("dados");
  assert.deepEqual(ativos(els).map((e) => e.id), ["modalDados"]);
  assert.equal(fechamentos, 1, "estado da assinatura foi limpo ao trocar de tela");

  await abrirModal("assinatura");
  fecharModal(undefined, "modalAssinatura");
  assert.equal(ativos(els).length, 0);
  assert.equal(fechamentos, 2);
});

test("admin.html tem uma única instância do modal de assinatura e sem IDs duplicados", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../../frontend/html/admin.html"),
    "utf8",
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const assinatura = ids.filter((id) => /^assinatura|^modalAssinatura$|^btnCriarPixAssinatura$/.test(id));
  assert.equal(new Set(assinatura).size, assinatura.length);
  assert.equal(ids.filter((id) => id === "modalAssinatura").length, 1);
});
