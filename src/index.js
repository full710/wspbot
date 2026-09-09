// ============================================================
// IMPORTS
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const qrcode = require("qrcode-terminal");

const {
  getActiveEvent,
  createEvent,
  setMessageId,
  register,
  setNotGoing,
  listRegistrations,
  listGoing,
  listNotGoing,
  resetEvent,
} = require("./db");

const {
  INACTIVITY_THRESHOLD_DAYS,
  recordActivity,
  seedMembers,
  getInactiveParticipants,
} = require("./activity");

const {
  buildConvocation,
  registrationMessage,
  unregistrationMessage,
  missingPjMessage,
  invalidCommandMessage,
} = require("./messages");

// ============================================================
// CONFIGURACIÓN
// ============================================================

const ALLOWED_GROUP_JID = "120363428768217690@g.us";

// ============================================================
// IDENTIFICAR USUARIO
// ============================================================

// Normaliza un identificador de WhatsApp quitando sufijos de
// dispositivo/agente y unificando el servidor (@lid o @s.whatsapp.net).
// Devuelve null si el valor no es un JID válido.
function normalizeId(value) {
  if (!value || typeof value !== "string") return null;

  const normalized = jidNormalizedUser(value);

  return normalized || null;
}

function getParticipantId(participant) {
  if (!participant) return null;

  if (typeof participant === "string") {
    return normalizeId(participant);
  }

  return normalizeId(
    participant.id ||
    participant.lid ||
    participant.jid ||
    participant.phoneNumber ||
    null
  );
}

// Un participante del grupo puede ser referenciado tanto por su LID
// como por su número de teléfono. Devolvemos TODOS sus identificadores
// conocidos (ya normalizados y sin duplicados) para poder cruzarlo
// contra los registros sin importar en qué formato se guardaron.
function getParticipantIdentifiers(participant) {
  if (!participant || typeof participant !== "object") return [];

  const ids = [
    participant.id,
    participant.jid,
    participant.lid,
    participant.phoneNumber,
  ]
    .map(normalizeId)
    .filter(Boolean);

  return [...new Set(ids)];
}

function getUserId(message) {
  const key = message.key || {};

  // key.participantAlt no existe en Baileys. Los identificadores reales
  // del emisor en un mensaje de grupo son participant / participantPn /
  // participantLid.
  const participant =
    key.participant ||
    key.participantPn ||
    key.participantLid ||
    null;

  return getParticipantId(participant);
}

// ============================================================
// EVENTO ACTIVO
// ============================================================
function getArgentinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getOrCreateCurrentEvent() {
  let event = getActiveEvent(ALLOWED_GROUP_JID);

  if (event) {
    return event;
  }

  event = createEvent({
  name: "Castle Siege",
  eventDate: getArgentinaDate(),
  eventTime: "21:30",
  gatherTime: "20:30",
  chatJid: ALLOWED_GROUP_JID,
});

  console.log("🏰 Evento creado:", event);

  return event;
}

// ============================================================
// OBTENER PARTICIPANTES DEL GRUPO
// ============================================================

async function getGroupParticipants(sock) {
  const metadata = await sock.groupMetadata(ALLOWED_GROUP_JID);

  return metadata.participants || [];
}

// ============================================================
// ACTUALIZAR CONVOCATORIA
// ============================================================

async function updateConvocation(sock, event) {
  try {
    const registrations = listGoing(event.id);

    const text = buildConvocation(event, registrations);

    // Si ya existe un mensaje de convocatoria,
    // intentamos editarlo.
    if (event.message_id) {
      try {
        await sock.sendMessage(
          ALLOWED_GROUP_JID,
          {
            text,
            edit: event.message_id,
          }
        );

        console.log("✏️ Convocatoria actualizada.");

        return;
      } catch (error) {
        console.log(
          "⚠️ No se pudo editar la convocatoria anterior."
        );

        console.log(error.message);
      }
    }

    // Si no existe mensaje anterior,
    // enviamos uno nuevo.
    const sent = await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text,
      }
    );

    if (sent?.key?.id) {
      setMessageId(event.id, sent.key.id);

      console.log(
        "📢 Nueva convocatoria enviada:",
        sent.key.id
      );
    }

  } catch (error) {
    console.error(
      "❌ Error actualizando convocatoria:"
    );

    console.error(error);
  }
}

// ============================================================
// COMANDO !VOY
// ============================================================

async function commandVoy(sock, message, event, argument) {
  const userId = getUserId(message);

  console.log("👤 Usuario !voy:", userId);
  console.log("⚔️ PJ:", argument);

  if (!userId) {
    console.log(
      "❌ No se pudo identificar al usuario."
    );

    return;
  }

  if (!argument) {
    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text: missingPjMessage(),
      },
      {
        quoted: message,
      }
    );

    return;
  }

  register(
    event.id,
    userId,
    argument
  );

  await sock.sendMessage(
    ALLOWED_GROUP_JID,
    {
      text: registrationMessage(argument),
    },
    {
      quoted: message,
    }
  );

  
}

// ============================================================
// COMANDO !NOVOY
// ============================================================

async function commandNoVoy(sock, message, event) {
  const userId = getUserId(message);

  console.log("👤 Usuario !novoy:", userId);

  if (!userId) {
    console.log(
      "❌ No se pudo identificar al usuario."
    );

    return;
  }

  setNotGoing(
    event.id,
    userId
  );

  await sock.sendMessage(
    ALLOWED_GROUP_JID,
    {
      text: unregistrationMessage(),
    },
    {
      quoted: message,
    }
  );

  
}

// ============================================================
// COMANDO !LISTA
// ============================================================

async function commandLista(sock, message, event) {
  const registrations = listGoing(event.id);

  if (!registrations.length) {
    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text: "📋 Todavía no hay jugadores confirmados.",
      },
      {
        quoted: message,
      }
    );

    return;
  }

  let text = "📋 LISTA CASTLE SIEGE\n\n";

  const mentions = [];

  registrations.forEach((player, index) => {
    const userId = player.phone;

    mentions.push(userId);

    text += `${index + 1}. 🟢 @${userId.split("@")[0]} — ${player.pj_name}\n`;
  });

  text += `\n👥 TOTAL: ${registrations.length}`;

  await sock.sendMessage(
    ALLOWED_GROUP_JID,
    {
      text,
      mentions,
    },
    {
      quoted: message,
    }
  );
}

// ============================================================
// COMANDO !CONVOCAR
// ============================================================

async function commandConvocar(sock, message, event) {
  await updateConvocation(
    sock,
    event
  );
}

// ============================================================
// COMANDO !CONFIRMAR
// ============================================================

async function commandConfirmar(sock, message, event) {
  try {
    const participants =
      await getGroupParticipants(sock);

    const registrations =
      listRegistrations(event.id);

    // Existe una fila por cada persona que respondió (haya dicho
    // !voy o !novoy). Normalizamos por si hay registros antiguos
    // guardados sin normalizar.
    const registered = new Set(
      registrations
        .map((registration) =>
          normalizeId(registration.phone)
        )
        .filter(Boolean)
    );

    // Identificadores del propio bot, para no auto-mencionarse.
    const selfIds = new Set(
      [sock.user?.id, sock.user?.lid]
        .map(normalizeId)
        .filter(Boolean)
    );

    const pending = participants.filter((participant) => {
      const ids = getParticipantIdentifiers(participant);

      if (!ids.length) {
        return false;
      }

      // Es el propio bot.
      if (ids.some((id) => selfIds.has(id))) {
        return false;
      }

      // Ya respondió (con cualquiera de sus identificadores).
      if (ids.some((id) => registered.has(id))) {
        return false;
      }

      return true;
    });

    if (!pending.length) {
      await sock.sendMessage(
        ALLOWED_GROUP_JID,
        {
          text:
            "✅ Todos los integrantes ya respondieron.",
        },
        {
          quoted: message,
        }
      );

      return;
    }

    // Para la mención usamos el id con el que WhatsApp direcciona
    // el grupo (participant.id), así la notificación llega bien.
    const mentions =
      pending
        .map((participant) =>
          getParticipantId(participant)
        )
        .filter(Boolean);

    let text =
      "⚠️ FALTAN CONFIRMAR\n\n";

    mentions.forEach((id) => {
      text += `👉 @${id.split("@")[0]}\n`;
    });

    text +=
      "\n🟢 !voy <nombre-pj>\n🔴 !novoy";

    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text,
        mentions,
      },
      {
        quoted: message,
      }
    );

  } catch (error) {
    console.error(
      "❌ Error en !confirmar:"
    );

    console.error(error);

    try {
      await sock.sendMessage(
        ALLOWED_GROUP_JID,
        {
          text:
            "❌ No se pudo generar la lista de pendientes. Probá de nuevo en unos segundos.",
        },
        {
          quoted: message,
        }
      );
    } catch (_) {
      // Si tampoco se puede avisar del error, no hacemos nada más.
    }
  }
}

// ============================================================
// COMANDO !NOVAN
// ============================================================

async function commandNoVan(sock, message, event) {
  const registrations =
    listNotGoing(event.id);

  if (!registrations.length) {
    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text:
          "🟢 Nadie indicó que no va.",
      },
      {
        quoted: message,
      }
    );

    return;
  }

  const mentions =
    registrations
      .map(
        (player) => player.phone
      )
      .filter(Boolean);

  let text =
    "🔴 NO VAN\n\n";

  registrations.forEach(
    (player) => {
      const id = player.phone;

      text +=
        `❌ @${id.split("@")[0]}\n`;
    }
  );

  await sock.sendMessage(
    ALLOWED_GROUP_JID,
    {
      text,
      mentions,
    },
    {
      quoted: message,
    }
  );
}

// ============================================================
// COMANDO !REINICIAR
// ============================================================

async function commandReiniciar(sock, message) {
  try {
    const newEvent = resetEvent(
      ALLOWED_GROUP_JID,
      getArgentinaDate(),
      "21:30",
      "20:30"
    );

    console.log(
      "🔄 Evento reiniciado:",
      newEvent
    );

    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text:
          `🔄 EVENTO REINICIADO\n\n` +
          `🏰 Nuevo Castle Siege\n` +
          `🕘 Inicio: 21:30\n` +
          `⏰ Presentarse: 20:30\n\n` +
          `📋 La lista está nuevamente vacía.\n\n` +
          `Usá !voy <nombre-pj> para anotarte.`
      },
      {
        quoted: message,
      }
    );

  } catch (error) {
    console.error(
      "❌ Error reiniciando evento:",
      error
    );
  }
}

// ============================================================
// CONTROL DE INACTIVIDAD
// ============================================================
//
// Registro y detección de miembros inactivos. Es un sistema
// aparte de las inscripciones a eventos: sólo mira quién envió
// mensajes al grupo y cuándo. Todavía NO elimina a nadie.
// ============================================================

// Identificadores del propio bot (para excluirlo siempre).
function getSelfIds(sock) {
  return new Set(
    [sock.user?.id, sock.user?.lid]
      .map(normalizeId)
      .filter(Boolean)
  );
}

function isAdminParticipant(participant) {
  return (
    participant.admin === "admin" ||
    participant.admin === "superadmin"
  );
}

// Devuelve los participantes inactivos del grupo y cuántos días
// llevan sin enviar mensajes. Excluye siempre a administradores
// y al propio bot.
async function findInactiveParticipants(sock, options = {}) {
  const participants = await getGroupParticipants(sock);

  const selfIds = getSelfIds(sock);

  const members = participants
    .filter((participant) => !isAdminParticipant(participant))
    .map((participant) => ({
      id: getParticipantId(participant),
      identifiers: getParticipantIdentifiers(participant),
    }))
    .filter((member) => {
      if (!member.id) {
        return false;
      }

      // Es el propio bot.
      return !member.identifiers.some((id) => selfIds.has(id));
    });

  return getInactiveParticipants(
    ALLOWED_GROUP_JID,
    members,
    options
  );
}

// Registra la actividad del emisor de un mensaje del grupo.
function trackMessageActivity(message) {
  if (message.key?.fromMe) {
    return;
  }

  const senderId = getUserId(message);

  if (!senderId) {
    return;
  }

  recordActivity(
    ALLOWED_GROUP_JID,
    senderId,
    message.messageTimestamp
  );
}

// ============================================================
// COMANDO !INACTIVOS
// ============================================================

async function commandInactivos(sock, message) {
  try {
    const inactive = await findInactiveParticipants(sock);

    if (!inactive.length) {
      await sock.sendMessage(
        ALLOWED_GROUP_JID,
        {
          text:
            `✅ No hay miembros inactivos ` +
            `(sin mensajes hace ${INACTIVITY_THRESHOLD_DAYS}+ días).`,
        },
        {
          quoted: message,
        }
      );

      return;
    }

    const mentions = inactive.map((item) => item.id);

    let text =
      `😴 MIEMBROS INACTIVOS ` +
      `(${INACTIVITY_THRESHOLD_DAYS}+ días sin mensajes)\n\n`;

    inactive.forEach((item) => {
      const dias =
        item.inactiveDays === null
          ? "sin registro"
          : `${item.inactiveDays} días`;

      text += `😴 @${item.id.split("@")[0]} — ${dias}\n`;
    });

    text += `\n👥 TOTAL: ${inactive.length}`;
    text += `\n\nℹ️ Detección solamente: no se elimina a nadie.`;

    await sock.sendMessage(
      ALLOWED_GROUP_JID,
      {
        text,
        mentions,
      },
      {
        quoted: message,
      }
    );

  } catch (error) {
    console.error("❌ Error en !inactivos:");
    console.error(error);
  }
}

// ============================================================
// PROCESAR COMANDOS
// ============================================================

async function processCommand(
  sock,
  message,
  messageText
) {
  console.log(
    "🔎 processCommand recibió:",
    JSON.stringify(messageText)
  );

  const text =
    messageText.trim();

  if (!text.startsWith("!")) {
    console.log(
      "ℹ️ No es un comando."
    );

    return;
  }

  const parts =
    text.split(/\s+/);

  const command =
    parts[0].toLowerCase();

  const argument =
    parts.slice(1).join(" ").trim();

  console.log(
    "🎯 Comando:",
    command
  );

  console.log(
    "📝 Argumento:",
    argument
  );

  const event =
    getOrCreateCurrentEvent();

  switch (command) {

    case "!voy":

      await commandVoy(
        sock,
        message,
        event,
        argument
      );

      break;

    case "!novoy":

      await commandNoVoy(
        sock,
        message,
        event
      );

      break;

    case "!lista":

      await commandLista(
        sock,
        message,
        event
      );

      break;

    case "!convocar":

      await commandConvocar(
        sock,
        message,
        event
      );

      break;

    case "!confirmar":

      await commandConfirmar(
        sock,
        message,
        event
      );

      break;

    case "!novan":

      await commandNoVan(
        sock,
        message,
        event
      );

      break;

    case "!reiniciar":

        await commandReiniciar(
            sock,
            message
        );

        break;

    case "!inactivos":

      await commandInactivos(
        sock,
        message
      );

      break;


    default:

      console.log(
        "❓ Comando desconocido:",
        command
      );

      await sock.sendMessage(
        ALLOWED_GROUP_JID,
        {
          text:
            invalidCommandMessage(),
        },
        {
          quoted: message,
        }
      );

      break;
  }
}

// ============================================================
// INICIAR BOT
// ============================================================

async function startBot() {

  console.log(
    "🚀 Iniciando bot..."
  );

  const {
    state,
    saveCreds,
  } =
    await useMultiFileAuthState(
      "./auth"
    );

  // ==========================================================
  // VERSIÓN WHATSAPP
  // ==========================================================

  let version;

  try {

    const result =
      await fetchLatestWaWebVersion();

    version =
      result.version;

    console.log(
      "📱 Versión WhatsApp:",
      version
    );

  } catch (error) {

    console.log(
      "⚠️ No se pudo obtener la versión más reciente."
    );

    console.log(error.message);

    version =
      [2, 3000, 1015901307];
  }

  // ==========================================================
  // SOCKET
  // ==========================================================

  const sock =
    makeWASocket({

      version,

      auth: state,

      logger:
        P({
          level: "silent",
        }),

      browser: [
        "Google Ubuntu",
        "Chrome",
        "1.0.0",
      ],

      printQRInTerminal: false,

      generateHighQualityLinkPreview:
        false,
    });

  // ==========================================================
  // GUARDAR CREDENCIALES
  // ==========================================================

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  // ==========================================================
  // QR
  // ==========================================================

  sock.ev.on(
    "connection.update",
    async (update) => {

      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      if (qr) {

        console.log(
          "\n📱 ESCANEÁ ESTE QR:\n"
        );

        qrcode.generate(
          qr,
          {
            small: true,
          }
        );
      }

      if (
        connection === "open"
      ) {

        console.log(
          "\n================================="
        );

        console.log(
          "✅ CONECTADO A WHATSAPP"
        );

        console.log(
          "=================================\n"
        );

        console.log(
          "👥 Grupo permitido:",
          ALLOWED_GROUP_JID
        );

        console.log(
          "🤖 Bot listo para recibir comandos."
        );

        // Sembrar el control de inactividad: a los miembros
        // actuales sin registro previo les marcamos "ahora"
        // como última actividad, para que la ventana de
        // inactividad empiece a contar desde este momento.
        try {
          const participants = await getGroupParticipants(sock);

          const ids = participants
            .map((participant) => getParticipantId(participant))
            .filter(Boolean);

          seedMembers(ALLOWED_GROUP_JID, ids);

          console.log(
            `🗓️ Control de inactividad listo (${ids.length} miembros).`
          );
        } catch (error) {
          console.error(
            "⚠️ No se pudo sembrar el control de inactividad:"
          );

          console.error(error);
        }
      }

      if (
        connection === "close"
      ) {

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        console.log(
          "\n❌ CONEXIÓN CERRADA"
        );

        console.log(
          "Código:",
          statusCode
        );

        if (
          statusCode !==
          DisconnectReason.loggedOut
        ) {

          console.log(
            "🔄 Reiniciando bot..."
          );

          startBot();

        } else {

          console.log(
            "🚪 Sesión cerrada definitivamente."
          );

        }
      }
    }
  );

  // ==========================================================
  // MENSAJES RECIBIDOS
  // ==========================================================

  sock.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {

      console.log(
        "\n================================="
      );

      console.log(
        "📨 messages.upsert"
      );

      console.log(
        "📌 Tipo:",
        type
      );

      console.log(
        "📦 Cantidad:",
        messages.length
      );

      console.log(
        "================================="
      );

      for (
        const message of messages
      ) {

        try {

          console.log(
            "\n📩 MENSAJE RECIBIDO:"
          );

          console.log(
            JSON.stringify(
              message,
              null,
              2
            )
          );

          // --------------------------------------------------
          // IGNORAR MENSAJES SIN CONTENIDO
          // --------------------------------------------------

          if (
            !message.message
          ) {

            console.log(
              "⚠️ El mensaje no contiene message."
            );

            continue;
          }

          // --------------------------------------------------
          // OBTENER GRUPO
          // --------------------------------------------------

          const remoteJid =
            message.key?.remoteJid;

          console.log(
            "📍 remoteJid:",
            remoteJid
          );

          // --------------------------------------------------
          // COMPROBAR GRUPO
          // --------------------------------------------------

          if (
            remoteJid !==
            ALLOWED_GROUP_JID
          ) {

            console.log(
              "⛔ Mensaje ignorado: grupo no permitido."
            );

            continue;
          }

          console.log(
            "✅ Mensaje pertenece al grupo correcto."
          );

          // --------------------------------------------------
          // REGISTRAR ACTIVIDAD DEL EMISOR
          // --------------------------------------------------
          // Independiente de la lógica de eventos: sólo anota
          // que esta persona envió un mensaje y cuándo.

          trackMessageActivity(message);

          // --------------------------------------------------
          // OBTENER TEXTO
          // --------------------------------------------------

          let messageText = "";

          if (
            message.message.conversation
          ) {

            messageText =
              message.message.conversation;

          } else if (
            message.message
              .extendedTextMessage
              ?.text
          ) {

            messageText =
              message.message
                .extendedTextMessage
                .text;

          } else if (
            message.message
              .imageMessage
              ?.caption
          ) {

            messageText =
              message.message
                .imageMessage
                .caption;

          } else if (
            message.message
              .videoMessage
              ?.caption
          ) {

            messageText =
              message.message
                .videoMessage
                .caption;
          }

          console.log(
            "💬 TEXTO DETECTADO:",
            JSON.stringify(
              messageText
            )
          );

          // --------------------------------------------------
          // SI NO HAY TEXTO
          // --------------------------------------------------

          if (
            !messageText
          ) {

            console.log(
              "⚠️ No se detectó texto."
            );

            continue;
          }

          // --------------------------------------------------
          // IDENTIFICAR USUARIO
          // --------------------------------------------------

          const userId =
            getUserId(message);

          console.log(
            "👤 USER ID:",
            userId
          );

          // --------------------------------------------------
          // PROCESAR COMANDO
          // --------------------------------------------------

          console.log(
            "⚙️ Ejecutando processCommand..."
          );

          await processCommand(
            sock,
            message,
            messageText
          );

          console.log(
            "✅ processCommand finalizado."
          );

        } catch (error) {

          console.error(
            "\n❌ ERROR PROCESANDO MENSAJE:"
          );

          console.error(
            error
          );

          console.error(
            error?.stack
          );
        }
      }

      console.log(
        "\n=================================\n"
      );
    }
  );
}

// ============================================================
// INICIAR
// ============================================================

startBot().catch(
  (error) => {

    console.error(
      "💥 ERROR FATAL:"
    );

    console.error(
      error
    );

  }
);

const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server escuchando en puerto ${PORT}`);
});