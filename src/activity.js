// ============================================================
// CONTROL DE INACTIVIDAD DE MIEMBROS
// ============================================================
//
// Este módulo es independiente de la lógica de inscripciones a
// eventos (tabla "registrations"). Sólo registra la última vez
// que cada participante envió un mensaje al grupo y permite
// detectar a los que llevan mucho tiempo sin actividad.
//
// Por ahora NO elimina a nadie: únicamente registra y detecta.
// ============================================================

const { db } = require("./db");

// Días sin enviar ningún mensaje para considerar inactivo a un
// participante.
const INACTIVITY_THRESHOLD_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================
// TABLA
// ============================================================
//
// Una fila por (grupo, participante). "participant_id" se guarda
// ya normalizado (mismo formato que usa el resto del bot).
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS member_activity (
    chat_jid        TEXT NOT NULL,
    participant_id  TEXT NOT NULL,
    last_message_at TEXT NOT NULL,

    PRIMARY KEY (chat_jid, participant_id)
  );
`);

// ============================================================
// NORMALIZAR FECHA
// ============================================================

function toDate(value) {
  if (value instanceof Date) {
    return value;
  }

  if (value == null) {
    return new Date();
  }

  // El timestamp de Baileys puede venir como número (segundos) o
  // como un objeto tipo Long con .toNumber().
  let seconds = value;

  if (typeof value === "object" && typeof value.toNumber === "function") {
    seconds = value.toNumber();
  }

  seconds = Number(seconds);

  if (Number.isFinite(seconds) && seconds > 0) {
    // Heurística: si parece estar en segundos lo pasamos a ms.
    return new Date(seconds < 1e12 ? seconds * 1000 : seconds);
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// ============================================================
// REGISTRAR ACTIVIDAD
// ============================================================
//
// Guarda / actualiza la última fecha de actividad de un
// participante. Nunca retrocede la fecha (si llega un mensaje
// más viejo que el registrado, se ignora).
// ============================================================

const recordStmt = db.prepare(`
  INSERT INTO member_activity (chat_jid, participant_id, last_message_at)
  VALUES (@chatJid, @participantId, @at)

  ON CONFLICT(chat_jid, participant_id)
  DO UPDATE SET
    last_message_at = excluded.last_message_at
  WHERE excluded.last_message_at > member_activity.last_message_at
`);

function recordActivity(chatJid, participantId, when) {
  if (!chatJid || !participantId) {
    return;
  }

  recordStmt.run({
    chatJid,
    participantId,
    at: toDate(when).toISOString(),
  });
}

// ============================================================
// SEMBRAR MIEMBROS
// ============================================================
//
// Cuando el bot arranca todavía no tiene historial de mensajes.
// Para que la ventana de 30 días empiece a contar de forma
// justa, registramos "ahora" como última actividad de todo
// miembro que aún no tenga ninguna fila. A los que ya tienen
// registro NO se los toca (INSERT OR IGNORE).
// ============================================================

const seedStmt = db.prepare(`
  INSERT OR IGNORE INTO member_activity (chat_jid, participant_id, last_message_at)
  VALUES (?, ?, ?)
`);

function seedMembers(chatJid, participantIds) {
  if (!chatJid || !Array.isArray(participantIds) || !participantIds.length) {
    return;
  }

  const now = new Date().toISOString();

  const seed = db.transaction((ids) => {
    for (const id of ids) {
      if (id) {
        seedStmt.run(chatJid, id, now);
      }
    }
  });

  seed(participantIds);
}

// ============================================================
// CONSULTAR ÚLTIMA ACTIVIDAD
// ============================================================

const lastActivityStmt = db.prepare(`
  SELECT last_message_at
  FROM member_activity
  WHERE chat_jid = ?
    AND participant_id = ?
`);

function getLastActivity(chatJid, participantId) {
  const row = lastActivityStmt.get(chatJid, participantId);

  return row ? row.last_message_at : null;
}

// ============================================================
// DETECTAR PARTICIPANTES INACTIVOS
// ============================================================
//
// members: array de objetos { id, identifiers }
//   - id: identificador principal (para mostrar / mencionar)
//   - identifiers: todos los identificadores conocidos del
//     participante (LID, teléfono, etc.). La última actividad se
//     busca contra cualquiera de ellos.
//
// El filtrado de administradores y del propio bot se hace ANTES
// de llamar a esta función (se le pasan sólo los miembros
// candidatos).
//
// Devuelve un array de:
//   {
//     id,                // identificador principal
//     identifiers,       // todos los identificadores
//     lastMessageAt,     // ISO string o null si nunca se registró
//     inactiveDays,      // días enteros sin actividad
//   }
// ordenado del más inactivo al menos inactivo.
// ============================================================

function getInactiveParticipants(chatJid, members, options = {}) {
  const {
    now = new Date(),
    thresholdDays = INACTIVITY_THRESHOLD_DAYS,
  } = options;

  const nowMs = now.getTime();

  const inactive = [];

  for (const member of members || []) {
    if (!member || !member.id) {
      continue;
    }

    const identifiers =
      Array.isArray(member.identifiers) && member.identifiers.length
        ? member.identifiers
        : [member.id];

    // Última actividad conocida con cualquiera de sus identificadores.
    let lastMs = null;

    for (const id of identifiers) {
      const iso = getLastActivity(chatJid, id);

      if (!iso) {
        continue;
      }

      const ms = Date.parse(iso);

      if (!Number.isNaN(ms) && (lastMs === null || ms > lastMs)) {
        lastMs = ms;
      }
    }

    const inactiveDays =
      lastMs === null
        ? null
        : Math.floor((nowMs - lastMs) / MS_PER_DAY);

    // Sin registro (no debería pasar si se sembró al conectar) o
    // por encima del umbral => inactivo.
    if (lastMs === null || inactiveDays >= thresholdDays) {
      inactive.push({
        id: member.id,
        identifiers,
        lastMessageAt: lastMs === null ? null : new Date(lastMs).toISOString(),
        inactiveDays,
      });
    }
  }

  inactive.sort((a, b) => {
    if (a.inactiveDays === null) return -1;
    if (b.inactiveDays === null) return 1;
    return b.inactiveDays - a.inactiveDays;
  });

  return inactive;
}

// ============================================================
// EXPORTAR
// ============================================================

module.exports = {
  INACTIVITY_THRESHOLD_DAYS,
  recordActivity,
  seedMembers,
  getLastActivity,
  getInactiveParticipants,
};
