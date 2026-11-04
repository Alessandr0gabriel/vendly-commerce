const test = require("node:test");
const assert = require("node:assert/strict");
const { consolidarItensPorProduto } = require("../utils/reservaEstoque");

test("consolida itens repetidos somando quantidades", () => {
  assert.deepEqual(
    consolidarItensPorProduto([
      { id: "a", quantidade: 1 },
      { id: "b", quantidade: 4 },
      { id: "a", quantidade: 2 },
    ]),
    [
      { id: "a", quantidade: 3 },
      { id: "b", quantidade: 4 },
    ],
  );
});
