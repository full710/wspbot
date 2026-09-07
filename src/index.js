// ============================================================
// IMPORTS
// ============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
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

function getParticipantId(participant) {
  if (!participant) return null;

  if (typeof participant === "string") {
    return participant;
  }

  return (
    participant.id ||
    participant.lid ||
    participant.jid ||
    participant.phoneNumber ||
    null
  );
}

function getUserId(message) {
  const key = message.key || {};

  const participant =
    key.participant ||
    key.participantAlt ||
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

    const registered = new Set(
      registrations.map(
        (registration) =>
          registration.phone
      )
    );

    const pending =
      participants.filter(
        (participant) => {
          const id =
            getParticipantId(participant);

          return (
            id &&
            !registered.has(id)
          );
        }
      );

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