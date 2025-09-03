// index.js
// Baileys: bienvenida (con imagen) + MENÚ de REQUISITOS (1 = Sí, 2 = No) con EMOJIS
// Requiere: npm i @whiskeysockets/baileys qrcode-terminal pino
// Coloca "bienvenida.jpg" junto a este archivo.

// Mantener Render activo
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot activo ✅\n');
}).listen(PORT, () => {
  console.log(`🌐 Keep-alive HTTP server en puerto ${PORT}`);
});
// Mantener Render activo

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const DELAY_MS = 3000; // 3s “humano”
const WELCOME_IMG_PATH = path.join(__dirname, 'bienvenidas.jpg');
const GREETED_FILE = path.join(__dirname, 'greeted.json');
const SESSION_PATH = process.env.SESSION_PATH || 'auth';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Persistencia: a quién ya saludamos
function loadGreeted() {
  try {
    if (!fs.existsSync(GREETED_FILE)) return new Set();
    const arr = JSON.parse(fs.readFileSync(GREETED_FILE, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveGreeted(set) {
  try { fs.writeFileSync(GREETED_FILE, JSON.stringify([...set], null, 2), 'utf8'); }
  catch (e) { console.error('⚠️ No se pudo guardar greeted.json:', e.message); }
}
const greeted = loadGreeted();

// Bloque de requisitos (más vivo con emojis)
function buildRequisitosTexto() {
  return [
    '*¿Quiénes pueden inscribirse a este programa gratuito de Formación de Lecturistas?*',
    '',
    '• 👩 *Mujeres*',
    '• 📍 *Residir en Lima o Callao*',
    '• 📆 *18 a 45 años*',
    '• 🎓 *Secundaria completa*',
    '• 📋 *No tener antecedentes penales ni policiales*',
    '• ⏳ *Disponibilidad para asistir a las clases presenciales en Tecsup-Lima*',
    '',
    '*Confirma si cumples con los requisitos*',
    '*Responde 1 (Sí) o 2 (No)*',
    '1. ✅ Sí, cumplo con los requisitos.',
    '2. ❌ No.'
  ].join('\n');
}

// Extrae texto del mensaje
function extractText(m) {
  let msg = m.message;
  if (!msg) return '';
  if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message;
  if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message;
  if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message;
  if (msg.extendedTextMessage?.text) return (msg.extendedTextMessage.text || '').trim();
  if (msg.conversation) return (msg.conversation || '').trim();
  if (msg.imageMessage?.caption) return (msg.imageMessage.caption || '').trim();
  if (msg.videoMessage?.caption) return (msg.videoMessage.caption || '').trim();
  return '';
}

// --- Mejoras de robustez ---
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e?.message || e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED', e));

// Envío seguro: no intentes enviar si WS no está OPEN
async function safeSend(sock, jid, content, opt) {
  try {
    const open = sock?.ws && sock.ws.readyState === 1; // 1 = OPEN
    if (!open) throw new Error('WS not open');
    return await sock.sendMessage(jid, content, opt);
  } catch (e) {
    console.warn('⏸️ No enviado; socket no abierto. Se reintentará tras reconectar:', e.message);
  }
}

// Backoff de reconexión
let retries = 0;
function restartWithBackoff(startFn) {
  const wait = Math.min(30000, 2000 * (1 + retries++)); // hasta 30s
  console.log(`↻ Reintentando en ${wait} ms`);
  setTimeout(() => startFn().catch(() => {}), wait);
}

// --- Núcleo ---

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    browser: ['Windows', 'Chrome', '10']
  });

  // Conexión / QR
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexión cerrada.', { shouldReconnect });
      if (shouldReconnect) start();
      else console.log('🔒 Sesión cerrada. Borra la carpeta "auth" para reescanear.');
    } else if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Mensajes
  sock.ev.on('messages.upsert', async (upsert) => {
    try {
      const m = upsert.messages && upsert.messages[0];
      if (!m || !m.message) return;
      if (m.key?.fromMe) return;

      const jid = m.key.remoteJid;
      if (jid.endsWith('@g.us')) return; // solo privado

      // 👋 Bienvenida solo 1ra vez
      const greetedNow = await greetIfFirstTime(sock, jid, m);
      if (greetedNow) return;

      const bodyRaw = extractText(m);
      const body = (bodyRaw || '').toLowerCase();

      // ——— LÓGICA DE RESPUESTAS ———
      // 1) Respuestas válidas (solo NÚMEROS 1 ó 2)
      if (body === '1') {
        await enviarRespondiendo(
          sock, jid,
          '🎉 *¡Excelente!* Cumples los requisitos.\n' +
          '📝 Haz clic en el siguiente enlace y completa el formulario. Por favor, recuerda llenar tus datos correctamente:\n' +
          'https://forms.gle/sRYpg8RDdqbUAQr28',
          m
        );
        return;
      }
      if (body === '2') {
        await enviarRespondiendo(
          sock, jid,
          '🙏 *Gracias por confirmar.*\n' +
          'El perfil que buscamos debe cumplir con todos los requisitos. Gracias por comunicarse con nosotros.',
          m
        );
        return;
      }

      // 2) Si/No escritos (en cualquier forma) → instrucción de usar números
      const siWords = ['si','sí','sii','siii','si.','sí.','si!','sí!','si,','sí,'];
      const noWords = ['no','no.','no!','nop','nel','noup','no,'];
      if (siWords.includes(body) || noWords.includes(body)) {
        await enviarRespondiendo(
          sock, jid,
          '⚠️ *Responde con el número de la opción:*\n' +
          '1 = Sí  |  2 = No',
          m
        );
        await enviarRequisitos(sock, jid, m);
        return;
      }

      // 3) Cualquier otro texto → mostrar menú (siempre)
      await enviarRequisitos(sock, jid, m);
    } catch (err) {
      console.error('❌ Error en messages.upsert:', err);
    }
  });

  // —— Helpers ——
  async function greetIfFirstTime(sock, jid, quotedMsg) {
  if (greeted.has(jid)) return false;   // ya saludado
  greeted.add(jid);
  saveGreeted(greeted);

  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(400);

    const bienvenidaTexto =
      '🙋‍♀️ *¡Bienvenidas a las inscripciones del Programa de Formación de Lecturistas para mujeres!* ✨\n' +
      '*Dirigido a mujeres que buscan empoderarse a través del conocimiento.*\n' +
      '¡Gracias por ponerte en contacto! En breve te responderemos.';

    if (fs.existsSync(WELCOME_IMG_PATH)) {
      const buffer = fs.readFileSync(WELCOME_IMG_PATH);
      await sock.sendMessage(jid, { image: buffer, caption: bienvenidaTexto }, { quoted: quotedMsg });
    } else {
      await sock.sendMessage(jid, { text: bienvenidaTexto }, { quoted: quotedMsg });
      console.warn('⚠️ No se encontró "bienvenida.jpg". Se envió solo texto.');
    }

    await sock.sendPresenceUpdate('paused', jid);
    await sleep(DELAY_MS);

    // Enviar requisitos inmediatamente tras la bienvenida (una sola vez)
    await enviarRequisitos(sock, jid, quotedMsg);

    return true;   // 👈 IMPORTANTE: avisa al caller que ya se envió el menú
  } catch (e) {
    console.error('❌ Error enviando bienvenida:', e);
    return false;  // en error, deja que el flujo siga normalmente
  }
  }

  async function enviarRespondiendo(sock, jid, text, quotedMsg) {
    try {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(DELAY_MS);
      const sent = await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
      await sock.sendPresenceUpdate('paused', jid);
      return sent;
    } catch (e) {
      console.error('❌ Error al enviar:', e);
    }
  }

  async function enviarRequisitos(sock, jid, quotedMsg) {
    const msg = buildRequisitosTexto();
    return enviarRespondiendo(sock, jid, msg, quotedMsg);
  }
}

start();
