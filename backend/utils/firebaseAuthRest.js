async function signInWithPassword(email, senha) {
  let endpoint;

  if (process.env.USE_FIREBASE_EMULATOR === "true") {
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (!host || host.includes("://") || /[/?#]/.test(host)) {
      throw new Error("FIREBASE_AUTH_EMULATOR_HOST local inválido.");
    }

    let emulatorUrl;
    try {
      emulatorUrl = new URL(`http://${host}`);
    } catch {
      throw new Error("FIREBASE_AUTH_EMULATOR_HOST local inválido.");
    }

    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(emulatorUrl.hostname) ||
      !emulatorUrl.port ||
      emulatorUrl.username ||
      emulatorUrl.password
    ) {
      throw new Error(
        "Login local só pode usar um Authentication Emulator local.",
      );
    }

    endpoint = `${emulatorUrl.origin}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  } else {
    const apiKey =
      process.env.FIREBASE_WEB_API_KEY ||
      process.env.FIREBASE_API_KEY ||
      process.env.API_KEY;

    if (!apiKey) {
      throw new Error(
        "A chave de API do Firebase não foi encontrada em NENHUMA variável de ambiente (FIREBASE_WEB_API_KEY, FIREBASE_API_KEY, API_KEY)",
      );
    }

    endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  }

  const resposta = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: senha,
      returnSecureToken: true,
    }),
  });

  const dados = await resposta.json();

  if (!resposta.ok) {
    const erro = new Error(
      dados?.error?.message || "Email ou senha incorretos",
    );

    erro.code = dados?.error?.message;
    throw erro;
  }

  return dados;
}

module.exports = { signInWithPassword };
