
// ============================================================
// CONVOCATORIA
// ============================================================

function buildConvocation(event, registrations) {
  const total = registrations.length;

  let playerList;

  if (total === 0) {
    playerList =
      "Todavía no hay jugadores confirmados.";
  } else {
    playerList = registrations
      .map((player, index) => {
        return `${index + 1}. 🟢 ${player.pj_name}`;
      })
      .join("\n");
  }

  return `🏰 CASTLE SIEGE 🏰

⚔️ Evento: ${event.name}
🕘 Inicio: ${event.event_time}
⏰ Presentarse: ${event.gather_time}
📢 Una hora antes para organizar las Partys.

━━━━━━━━━━━━━━━━━━

📝 COMANDOS

🟢 !voy <nombre-pj>
Para confirmar que vas e indicar con qué PJ.

🔴 !novoy
Para confirmar que NO vas.

📋 !lista
Para mostrar la lista de respuestas.

⚠️ !confirmar
Para mencionar a quienes todavía no respondieron.

🔴 !novan
Para mostrar quiénes dijeron que no van.

📢 !convocar
Para actualizar esta convocatoria.

━━━━━━━━━━━━━━━━━━

👥 CONFIRMADOS: ${total}

${playerList}

━━━━━━━━━━━━━━━━━━

⚠️ La inscripción es por PERSONA.
Indicá correctamente el PJ con el que vas.

⚔️ ¡Nos vemos en el CS!`;
}

// ============================================================
// MENSAJE !VOY
// ============================================================

function registrationMessage(pjName) {
  return `✅ Confirmación registrada.

🟢 ESTADO: VOY
⚔️ PJ: ${pjName}

⏰ Recordá estar a las 20:30 hs para organizar las Partys.

Si querés cambiar tu respuesta, podés usar:

🔴 !novoy`;
}

// ============================================================
// MENSAJE !NOVOY
// ============================================================

function unregistrationMessage() {
  return `🔴 Confirmación registrada.

❌ ESTADO: NO VOY

Si cambiás de opinión, podés confirmar tu participación con:

🟢 !voy <nombre-pj>`;
}

// ============================================================
// MENSAJE SIN PJ
// ============================================================

function missingPjMessage() {
  return `⚠️ Tenés que indicar el nombre de tu PJ.

Ejemplo:

🟢 !voy DarkLord`;
}

// ============================================================
// COMANDO INVÁLIDO
// ============================================================

function invalidCommandMessage() {
  return `❓ Comando no reconocido.

Usá:

🟢 !voy <nombre-pj>
🔴 !novoy
📋 !lista
📢 !convocar
⚠️ !confirmar
🔴 !novan`;
}

// ============================================================
// EXPORTAR
// ============================================================

module.exports = {
  buildConvocation,
  registrationMessage,
  unregistrationMessage,
  missingPjMessage,
  invalidCommandMessage,
};

