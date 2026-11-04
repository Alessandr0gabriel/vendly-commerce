const crypto = require("node:crypto");

const COLECAO_RESERVAS = "reservas_nomes_estabelecimentos";
const ID_STATUS_INDICE = "_meta";
const MAX_CARACTERES_NOME = 100;

function normalizarNomeEstabelecimento(valor) {
  if (typeof valor !== "string") return null;

  const nome = valor.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (
    !nome ||
    [...nome].length > MAX_CARACTERES_NOME ||
    /[\u0000-\u001f\u007f-\u009f<>]/u.test(nome)
  ) {
    return null;
  }

  return nome;
}

function chaveNomeEstabelecimento(nome) {
  if (typeof nome !== "string" || !nome.trim()) return null;

  const normalizado = nome
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

  return normalizado || null;
}

function referenciaReservaNome(db, chave) {
  const id = crypto.createHash("sha256").update(chave, "utf8").digest("hex");
  return db.collection(COLECAO_RESERVAS).doc(id);
}

function referenciaStatusIndiceNomes(db) {
  return db.collection(COLECAO_RESERVAS).doc(ID_STATUS_INDICE);
}

const CODIGOS_FIRESTORE_TRANSITORIOS = new Set([4, 8, 10, 14]);
const CODIGOS_TRANSITORIOS_TEXTO = new Set([
  "deadline-exceeded",
  "resource-exhausted",
  "aborted",
  "unavailable",
]);

// Lança erro tipado (sem detalhes internos) quando o _meta não está pronto.
// Ausente e "em migração/pendente" são distinguidos apenas no código interno.
function exigirIndiceNomesPronto(statusSnap, mensagem) {
  const dados = statusSnap.exists ? statusSnap.data() : null;
  if (dados?.ready === true) return;
  throw Object.assign(
    new Error(
      mensagem ||
        "O índice de nomes de estabelecimentos ainda não foi regularizado. Um administrador do sistema deve executar a migração antes de novos cadastros.",
    ),
    {
      statusCode: 409,
      code: "INDICE_NOMES_PENDENTE",
      motivoIndice: statusSnap.exists ? "pendente" : "ausente",
    },
  );
}

function erroNomeDuplicado() {
  return Object.assign(
    new Error(
      "Este nome de estabelecimento já está em uso. Escolha outro nome.",
    ),
    { statusCode: 409, code: "NOME_DUPLICADO" },
  );
}

function erroFirestoreTransitorio(err) {
  return (
    CODIGOS_FIRESTORE_TRANSITORIOS.has(err?.code) ||
    CODIGOS_TRANSITORIOS_TEXTO.has(String(err?.code || "").replace(/^firestore\//, ""))
  );
}

// Converte um erro em { status, corpo } seguro para o cliente.
function classificarErroCadastro(err) {
  if (err?.statusCode && err?.code) {
    return {
      status: err.statusCode,
      corpo: { mensagem: err.message, code: err.code },
    };
  }
  if (err?.statusCode) {
    return { status: err.statusCode, corpo: { mensagem: err.message } };
  }
  if (erroFirestoreTransitorio(err)) {
    return {
      status: 503,
      corpo: {
        mensagem: "Serviço temporariamente indisponível. Tente novamente.",
        code: "SERVICO_INDISPONIVEL",
      },
    };
  }
  return { status: 500, corpo: { mensagem: "Erro no servidor" } };
}

module.exports = {
  classificarErroCadastro,
  erroNomeDuplicado,
  exigirIndiceNomesPronto,
  COLECAO_RESERVAS,
  ID_STATUS_INDICE,
  MAX_CARACTERES_NOME,
  chaveNomeEstabelecimento,
  normalizarNomeEstabelecimento,
  referenciaReservaNome,
  referenciaStatusIndiceNomes,
};
