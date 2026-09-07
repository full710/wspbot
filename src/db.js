const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "bot.db");

const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

// ============================================================
// CREAR TABLAS
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_time TEXT NOT NULL,
    gather_time TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    message_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS registrations (
    event_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    pj_name TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (event_id, phone),

    FOREIGN KEY (event_id)
      REFERENCES events(id)
      ON DELETE CASCADE
  );
`);

// ============================================================
// MIGRACIÓN DE BASES EXISTENTES
// ============================================================
//
// Si la tabla ya existía sin "status", la agregamos.
// ============================================================

try {
  db.prepare(`
    ALTER TABLE registrations
    ADD COLUMN status INTEGER NOT NULL DEFAULT 1
  `).run();

  console.log("✅ Columna status agregada a registrations.");
} catch (error) {
  // SQLite dará error si la columna ya existe.
  // En ese caso no hacemos nada.
}

// ============================================================
// EVENTO ACTIVO
// ============================================================

function getActiveEvent(chatJid) {
  return db
    .prepare(`
      SELECT *
      FROM events
      WHERE chat_jid = ?
        AND active = 1
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(chatJid);
}

// ============================================================
// CREAR EVENTO
// ============================================================

function createEvent({
  name,
  eventDate,
  eventTime,
  gatherTime,
  chatJid,
}) {
  const result = db
    .prepare(`
      INSERT INTO events (
        name,
        event_date,
        event_time,
        gather_time,
        chat_jid
      )
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      name,
      eventDate,
      eventTime,
      gatherTime,
      chatJid
    );

  return db
    .prepare(`
      SELECT *
      FROM events
      WHERE id = ?
    `)
    .get(result.lastInsertRowid);
}

// ============================================================
// GUARDAR ID DEL MENSAJE DE CONVOCATORIA
// ============================================================

function setMessageId(eventId, messageId) {
  db
    .prepare(`
      UPDATE events
      SET message_id = ?
      WHERE id = ?
    `)
    .run(messageId, eventId);
}

// ============================================================
// REGISTRAR QUE VA
// ============================================================

function register(eventId, phone, pjName) {
  db
    .prepare(`
      INSERT INTO registrations (
        event_id,
        phone,
        pj_name,
        status
      )
      VALUES (?, ?, ?, 1)

      ON CONFLICT(event_id, phone)
      DO UPDATE SET
        pj_name = excluded.pj_name,
        status = 1,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(
      eventId,
      phone,
      pjName
    );
}

// ============================================================
// REGISTRAR QUE NO VA
// ============================================================

function setNotGoing(eventId, phone) {
  db
    .prepare(`
      INSERT INTO registrations (
        event_id,
        phone,
        pj_name,
        status
      )
      VALUES (?, ?, '', 0)

      ON CONFLICT(event_id, phone)
      DO UPDATE SET
        status = 0,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(
      eventId,
      phone
    );
}

// ============================================================
// LISTA COMPLETA
// ============================================================

function listRegistrations(eventId) {
  return db
    .prepare(`
      SELECT
        phone,
        pj_name,
        status,
        created_at,
        updated_at
      FROM registrations
      WHERE event_id = ?
      ORDER BY created_at ASC
    `)
    .all(eventId);
}

// ============================================================
// LOS QUE VAN
// ============================================================

function listGoing(eventId) {
  return db
    .prepare(`
      SELECT
        phone,
        pj_name,
        status
      FROM registrations
      WHERE event_id = ?
        AND status = 1
      ORDER BY created_at ASC
    `)
    .all(eventId);
}

// ============================================================
// LOS QUE NO VAN
// ============================================================

function listNotGoing(eventId) {
  return db
    .prepare(`
      SELECT
        phone,
        pj_name,
        status
      FROM registrations
      WHERE event_id = ?
        AND status = 0
      ORDER BY created_at ASC
    `)
    .all(eventId);
}

// ============================================================
// REINICIAR EVENTO
// ============================================================

function resetEvent(chatJid, eventDate, eventTime, gatherTime) {
  // Desactivar el evento actual
  db
    .prepare(`
      UPDATE events
      SET active = 0
      WHERE chat_jid = ?
        AND active = 1
    `)
    .run(chatJid);

  // Crear nuevo evento
  const result = db
    .prepare(`
      INSERT INTO events (
        name,
        event_date,
        event_time,
        gather_time,
        chat_jid,
        message_id,
        active
      )
      VALUES (?, ?, ?, ?, ?, NULL, 1)
    `)
    .run(
      "Castle Siege",
      eventDate,
      eventTime,
      gatherTime,
      chatJid
    );

  return db
    .prepare(`
      SELECT *
      FROM events
      WHERE id = ?
    `)
    .get(result.lastInsertRowid);
}

// ============================================================
// EXPORTAR
// ============================================================

module.exports = {
  getActiveEvent,
  createEvent,
  setMessageId,
  register,
  setNotGoing,
  listRegistrations,
  listGoing,
  listNotGoing,
  resetEvent,
};