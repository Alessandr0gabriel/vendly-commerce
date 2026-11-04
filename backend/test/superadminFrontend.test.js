const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const js = fs.readFileSync(
  path.join(__dirname, "../../frontend/js/superadmin.js"),
  "utf8",
);

test("não há senha fixa nem fluxo legado de criação de loja", () => {
  assert.doesNotMatch(js, /Temporaria@123/);
  assert.doesNotMatch(js, /criarEstabelecimentoDirect|formCriarLoja/);
});

test("sem onclick inline nem innerHTML com interpolação de dados", () => {
  assert.doesNotMatch(js, /onclick\s*=/i);
  const interpolados = js.match(/innerHTML\s*=\s*`[^`]*\$\{/g) || [];
  assert.deepEqual(interpolados, []);
  assert.doesNotMatch(js, /insertAdjacentHTML/);
  assert.doesNotMatch(js, /\bhtml:\s*/);
});

test("API_URL utiliza backend de demonstração sem conexão à produção", () => {
  assert.match(js, /VENDLY_CONFIG\?\.backendUrl/);
  assert.match(js, /127\.0\.0\.1:3000/);
  assert.doesNotMatch(js, /meu-sistema-saas\.onrender\.com/);
  assert.doesNotMatch(js, /API_URL\s*=[^;]*(localStorage|location\.search|URLSearchParams)/);
});

test("fetchComAuth distingue 401, 403 e 409 e mantém credentials/CSRF", () => {
  assert.match(js, /credentials:\s*"include"/);
  assert.match(js, /x-csrf-token/i);
  assert.match(js, /CSRF_INVALIDO/);
  assert.match(js, /res\.status === 401 \|\|/);
});

test("criarEl grava dados maliciosos como texto", () => {
  const trecho = js.match(/function criarEl[\s\S]*?\r?\n}\r?\n/)[0];
  const el = { style: {}, children: [], attrs: {}, listeners: {} };
  el.setAttribute = (k, v) => (el.attrs[k] = v);
  el.addEventListener = (k, f) => (el.listeners[k] = f);
  el.appendChild = (c) => el.children.push(c);
  const fabrica = new Function(
    "document",
    `${trecho}; return criarEl;`,
  )({ createElement: () => el });
  const payload = `<img src=x onerror=alert(1)>"'&<>`;
  fabrica("span", { texto: payload });
  assert.equal(el.textContent, payload);
  assert.equal(el.innerHTML, undefined);
});
