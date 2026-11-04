const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const Joi = require("joi");
const xss = require("xss");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");

require("./config/loadEnv")();
// 'secret' é a chave secreta do webhook cadastrada por estabelecimento (banco), não mais o .env
function validateMercadoPagoSignature(request, secret) {
  const signature = request.headers["x-signature"];
  const requestId = request.headers["x-request-id"];

  if (!signature || !requestId) return false;

  if (!secret) return false;

  try {
    const parts = signature.split(",");
    let ts = "";
    let hash = "";

    // Extrai o Timestamp (ts) e o Hash (v1) enviados pelo Mercado Pago
    for (const part of parts) {
      const [key, value] = part.trim().split("=");
      if (key === "ts") ts = value;
      if (key === "v1") hash = value;
    }

    if (!ts || !hash) return false;

    // 1. Pega o ID do pagamento (Pode vir na URL ou no Corpo, dependendo do evento)
    const dataId =
      request.query["data.id"] ||
      request.query.id ||
      request.body?.data?.id ||
      request.body?.id ||
      "";

    // 2. Monta o "Manifesto" EXATAMENTE como a documentação do Mercado Pago exige
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

    // 3. Criptografa o manifesto usando a sua chave secreta do Render
    const expectedHash = crypto
      .createHmac("sha256", secret)
      .update(manifest)
      .digest("hex");

    // 4. Compara com segurança
    if (/^[0-9a-f]{64}$/i.test(hash) && crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(expectedHash, "hex"),
    )) {
      return true;
    } else {
      logger.error(
        "Falha na validação da assinatura do webhook do Mercado Pago.",
      );
      return false;
    }
  } catch (err) {
    console.error("Erro ao validar assinatura do webhook", err);
    return false;
  }
}
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_IV_SIZE = 16;
const ENCRYPTION_TAG_SIZE = 16;

let ENCRYPTION_KEY = null;

function initEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET não configurado no .env");
  }

  ENCRYPTION_KEY = crypto.pbkdf2Sync(
    secret,
    process.env.ENCRYPTION_SALT || "default-salt",
    100000,
    32,
    "sha256",
  );
}

function encryptSensitiveData(data) {
  if (!ENCRYPTION_KEY) {
    throw new Error("Encryption key not initialized");
  }

  try {
    const iv = crypto.randomBytes(ENCRYPTION_IV_SIZE);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      ENCRYPTION_KEY,
      iv,
    );

    let encrypted = cipher.update(String(data), "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (err) {
    console.error("Erro ao encriptar dados", err);
    throw err;
  }
}

function decryptSensitiveData(encryptedData) {
  if (!ENCRYPTION_KEY) {
    throw new Error("Encryption key not initialized");
  }

  try {
    const parts = encryptedData.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted data format");
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      ENCRYPTION_KEY,
      iv,
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    console.error("Erro ao decriptar dados", err);
    throw err;
  }
}

// Inicializar chave no startup
try {
  initEncryptionKey();
  console.log("[INFO] Chave de encriptação inicializada com sucesso");
} catch (err) {
  console.error("FALHA AO INICIALIZAR ENCRIPTAÇÃO:", err);
  process.exit(1);
}

const connectionReady = require("./database/connection");
const {
  auth,
  FieldValue,
  Timestamp,
  AggregateField,
} = require("./config/firebase");
const { fileTypeFromBuffer } = require("file-type");
const streamifier = require("streamifier");
const limparHistorico = require("./jobs/historicoArquivar");
const limparPixExpirados = require("./jobs/limparPixExpirados");

// IMPORTA SUA API
const createApi = require("./api");

let db; // Firestore — preenchido depois que connectionReady resolver

function sanitizar(req, res, next) {
  if (req.body) {
    for (const key in req.body) {
      if (typeof req.body[key] === "string") {
        req.body[key] = xss(req.body[key]);
      }
    }
  }

  next();
}
const logger = {
  error: (msg, err) => {
    if (process.env.NODE_ENV === "production") {
      console.error(
        JSON.stringify({
          level: "error",
          msg,
          error: err?.message,
          stack: err?.stack,
        }),
      );
    } else {
      console.error(`[ERROR] ${msg}`, err);
    }
  },
  info: (msg) => {
    console.log(`[INFO] ${msg}`);
  },
};
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { mensagem: "Muitas requisições. Aguarde alguns minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { mensagem: "Muitas tentativas. Tente novamente em 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit específico para webhook
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 50, // máximo 50 webhooks por minuto por IP
  skipSuccessfulRequests: false,
  message: { ok: false, error: "Too many webhook requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

const subscriptionPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    mensagem: "Muitas tentativas de cobrança. Aguarde alguns minutos.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit para rotas públicas
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60, // 60 requisições por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    mensagem: "Muitas requisições. Tente novamente em alguns minutos.",
  },
});
const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = [".jpg", ".jpeg", ".png", ".webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Tipo inválido"));
    }

    if (!allowedExt.includes(ext)) {
      return cb(new Error("Extensão inválida"));
    }

    cb(null, true);
  },
});
const schemaProduto = Joi.object({
  nome: Joi.string().min(3).max(100).required(),
  descricao: Joi.string().max(500).required(),
  categoria: Joi.string().required(),
  preco: Joi.number().positive().required(),
  controla_estoque: Joi.boolean().optional(),
  estoque: Joi.number().min(0).optional(),
  mercado_pago_taxa: Joi.string().valid("assumir", "repassar").optional(),
});
const app = express();

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(",").forEach((o) => {
    const originTrimmed = o.trim();
    if (originTrimmed && !allowedOrigins.includes(originTrimmed)) {
      allowedOrigins.push(originTrimmed);
    }
  });
}

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ["Content-Type", "x-csrf-token"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);
app.use(cookieParser());
app.use(sanitizar);
app.use(limiter);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: process.env.NODE_ENV === "production",
    },
    contentSecurityPolicy: (() => {
      const base = {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.socket.io", "https://unpkg.com"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
        connectSrc: ["'self'"],
      };

      // O CSP do servidor usa somente origens configuradas no ambiente Node.js.

      for (const origin of allowedOrigins) {
        if (origin.startsWith("http://") || origin.startsWith("https://")) {
          base.connectSrc.push(origin.replace(/^http/, "ws"), origin);
        }
      }

      if (process.env.NODE_ENV !== "production") {
        base.styleSrc.push("'unsafe-inline'");
      }

      return { directives: base };
    })(),
  }),
);

async function verificarToken(req, res, next) {
  const sessionCookie = req.cookies && req.cookies.token;
  const sessionId = req.cookies && req.cookies["session-id"];

  if (
    !sessionCookie ||
    sessionCookie === "null" ||
    sessionCookie === "undefined"
  ) {
    return res
      .status(401)
      .json({ mensagem: "Acesso negado! Sessão inválida ou expirada." });
  }

  try {
    const decodedClaims = await auth.verifySessionCookie(sessionCookie, true);

    const adminDoc = await db.collection("admin").doc(decodedClaims.uid).get();

    if (!adminDoc.exists) {
      return res
        .status(401)
        .json({ mensagem: "Usuário administrativo não localizado." });
    }

    const adminData = adminDoc.data();

    if (adminData.primeiro_login === true) {
      const rotaPermitida =
        req.originalUrl.includes("/trocar-senha.html") ||
        req.originalUrl.includes("/auth/primeiro-acesso") ||
        req.originalUrl.includes("/logout");

      if (!rotaPermitida) {
        return res.status(403).json({
          mensagem: "Acesso bloqueado. Troca de senha obrigatória.",
          code: "FORCAR_TROCA_SENHA",
        });
      }
    }

    if (!sessionId || adminData.session_id !== sessionId) {
      return res.status(401).json({
        mensagem: "Sua sessão foi encerrada porque houve um novo login.",
      });
    }

    if (adminData.active !== true) {
      return res
        .status(403)
        .json({ mensagem: "Esta conta administrativa está desativada." });
    }

    const establishmentId = adminData.establishment_id || null;
    let plano = "barato";

    if (establishmentId) {
      const establishmentDoc = await db
        .collection("estabelecimentos")
        .doc(establishmentId)
        .get();

      if (establishmentDoc.exists) {
        plano = establishmentDoc.data()?.plano || "barato";
      }
    }

    req.user = {
      ...decodedClaims,
      role: adminData.role,
      establishmentId,
      establishment_id: establishmentId,
      plan: plano,
    };

    next();
  } catch (error) {
    logger.error("Erro ao verificar token de sessão:", error);
    return res
      .status(401)
      .json({ mensagem: "Sessão expirada. Faça login novamente." });
  }
}

function verificarSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== "superadmin") {
    return res.status(403).json({ mensagem: "Acesso negado!" });
  }
  next();
}

function verificarCSRF(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const cookieToken = req.cookies && req.cookies["csrf-token"];
  const headerToken = req.get("x-csrf-token");

  if (
    !cookieToken ||
    !headerToken ||
    cookieToken.length !== headerToken.length ||
    !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
  ) {
    return res
      .status(403)
      .json({ mensagem: "Token CSRF inválido.", code: "CSRF_INVALIDO" });
  }

  next();
}
async function validarBuffer(buffer) {
  const type = await fileTypeFromBuffer(buffer);

  if (!type || !allowedTypes.includes(type.mime)) {
    const err = new Error("Arquivo fraudado detectado!");
    err.statusCode = 400;
    throw err;
  }
}

function uploadCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "produtos" },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      },
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
connectionReady
  .then((conn) => {
    db = conn.db;
    logger.info("Banco de dados conectado com sucesso");

    limparHistorico({ db, FieldValue, Timestamp, logger });
    limparPixExpirados({ db, FieldValue, Timestamp, logger });
    const server = http.createServer(app);
    const socketConnections = new Map();
    const io = new Server(server, {
      cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
      },
    });

    io.use((socket, next) => {
      const ip =
        socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
      const now = Date.now();

      if (!socketConnections.has(ip)) {
        socketConnections.set(ip, []);
      }

      const connections = socketConnections
        .get(ip)
        .filter((time) => now - time < 60000);

      if (connections.length >= 10) {
        return next(new Error("Muitas conexões. Tente novamente."));
      }

      connections.push(now);
      socketConnections.set(ip, connections);

      const cookies = socket.handshake.headers.cookie || "";
      let sessionCookie = cookies
        .split(";")
        .find((c) => c.trim().startsWith("token="))
        ?.split("=")[1];

      if (!sessionCookie) {
        return next(new Error("Token não encontrado"));
      }

      // Tenta validar em modo duplo no Socket também
      auth
        .verifyIdToken(sessionCookie)
        .catch(() => auth.verifySessionCookie(sessionCookie, true))
        .then(async (decoded) => {
          const adminDoc = await db.collection("admin").doc(decoded.uid).get();

          if (!adminDoc.exists) {
            return next(new Error("Usuário não encontrado"));
          }

          const data = adminDoc.data();

          const socketSessionId = cookies
            .split(";")
            .find((cookie) => cookie.trim().startsWith("session-id="))
            ?.split("=")[1];

          if (!socketSessionId || data.session_id !== socketSessionId) {
            return next(new Error("Sessão encerrada por um novo login"));
          }

          if (data.active !== true) {
            return next(new Error("Usuário desativado"));
          }

          socket.user = {
            id: decoded.uid,
            role: data.role,
            establishmentId: data.establishment_id || null,
          };

          next();
        })
        .catch(() => next(new Error("Token inválido")));
    });

    io.on("connection", (socket) => {
      console.log("🟢 Socket conectado:", socket.id);

      if (!socket.user) {
        return socket.disconnect();
      }

      const { establishmentId, id, role } = socket.user;

      if (establishmentId) {
        const room = `estab_${establishmentId}`;
        socket.join(room);
      }

      socket.on("disconnect", () => {
        console.log("🔴 Socket desconectado:", socket.id);
      });
    });

    app.set("io", io);
    app.use(
      "/api",
      createApi({
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
      }),
    );
    app.use((err, req, res, next) => {
      logger.error("Erro não tratado", err);

      if (res.headersSent) {
        return next(err);
      }

      res.status(err.statusCode || 500).json({
        mensagem:
          process.env.NODE_ENV === "production"
            ? "Erro interno do servidor"
            : err.message,
      });
    });
    app.use((req, res) => {
      res.status(404).json({ error: "Rota não encontrada" });
    });
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(
        `Servidor rodando na porta ${PORT} - NODE_ENV: ${process.env.NODE_ENV}`,
      );
    });
  })
  .catch((err) => {
    const destino =
      process.env.USE_FIREBASE_EMULATOR === "true"
        ? "Firebase Emulators (Firestore/Auth)"
        : "Firebase";
    console.error(`[FATAL] Falha ao conectar ao ${destino}: ${err.message}`);
    process.exit(1);
  });
