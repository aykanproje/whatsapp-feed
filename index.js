require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const qrcode     = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const db         = require('./db');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3000', 10);
const DB_PATH     = process.env.DB_PATH     || './data/messages.db';
const SESSION_DIR = process.env.SESSION_DIR || './session-data';
const PIC_TTL_MS  = 60 * 60 * 1000; // 1 saat

// ── Database ──────────────────────────────────────────────────────────────────
db.init(DB_PATH);
console.log(`[db] SQLite ready at ${DB_PATH}`);

// ── Profile pic cache (id → { url, ts }) ─────────────────────────────────────
const picCache = new Map();

async function getProfilePicUrl(id) {
  const cached = picCache.get(id);
  if (cached && Date.now() - cached.ts < PIC_TTL_MS) return cached.url;

  let url = null;
  try {
    // requestProfilePicFromServer isNewsletter hatasını fırlatıyor —
    // önce profilePicFind ile cache'e bakalım, yoksa server'a sor
    url = await waClient.pupPage.evaluate(async (contactId) => {
      try {
        const chatWid = window.Store.WidFactory.createWid(contactId);
        if (!chatWid) return null;

        // Önce local cache dene
        const cached = await window.Store.ProfilePic.profilePicFind(chatWid);
        if (cached?.eurl) return cached.eurl;

        // Local yoksa server'dan iste, ama isNewsletter hatasını yakala
        const result = await window.Store.ProfilePic.requestProfilePicFromServer(chatWid)
          .catch(() => null);
        return result?.eurl ?? null;
      } catch (_) {
        return null;
      }
    }, id);
  } catch (_) {
    url = null;
  }

  picCache.set(id, { url: url || null, ts: Date.now() });
  return url || null;
}

// ── HTTP + Socket.io ──────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

app.get('/api/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  res.json(db.getRecent(limit));
});

// Profil fotoğrafını backend üzerinden proxy et (CDN URL'leri doğrudan açılamıyor)
app.get('/api/proxy-pic', async (req, res) => {
  const { id } = req.query;
  if (!id || !waClient) return res.status(404).end();

  const url = await getProfilePicUrl(id);
  if (!url) return res.status(404).end();

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(404).end();
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(Buffer.from(buf));
  } catch (_) {
    res.status(500).end();
  }
});

io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);
  socket.on('disconnect', () =>
    console.log(`[ws] client disconnected: ${socket.id}`)
  );
});

server.listen(PORT, () =>
  console.log(`[http] listening on http://localhost:${PORT}`)
);

// ── WhatsApp client ───────────────────────────────────────────────────────────
let waClient = null;

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath: (() => {
        const { execSync } = require('child_process');
        for (const cmd of ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable']) {
          try { return execSync(`which ${cmd}`).toString().trim(); } catch (_) {}
        }
        return undefined;
      })(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n[whatsapp] Scan QR code with your phone:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('[whatsapp] authenticated'));

  client.on('ready', () => {
    console.log('[whatsapp] client ready — listening for group messages');
    io.emit('wa_status', { status: 'ready' });
  });

  client.on('auth_failure', (msg) => {
    console.error('[whatsapp] auth failure:', msg);
    io.emit('wa_status', { status: 'auth_failure', msg });
  });

  client.on('disconnected', (reason) => {
    console.warn('[whatsapp] disconnected:', reason);
    io.emit('wa_status', { status: 'disconnected', reason });
    setTimeout(() => {
      console.log('[whatsapp] attempting reconnect…');
      createClient();
    }, 10_000);
  });

  // ── Core: read-only group message handler ──────────────────────────────────
  async function handleMsg(msg) {
    const chatId = msg.fromMe ? msg.to : msg.from;
    if (!chatId || !chatId.endsWith('@g.us')) return;

    // Metin, medya veya konum — üçü de geçerli
    const hasMedia = msg.hasMedia;
    if (!hasMedia && !msg.body && msg.type !== 'location') return;

    let groupName = chatId;
    try {
      const chat = await msg.getChat();
      groupName  = chat.name || chatId;
    } catch (_) {}

    let author    = msg.fromMe ? 'Sen' : (msg.author || msg.from);
    let contactId = msg.fromMe ? client.info?.wid?._serialized : msg.author;

    try {
      const contact = await msg.getContact();
      author    = contact.name || contact.pushname || author;
      contactId = contact.id._serialized;
    } catch (_) {}

    // Konum mesajı
    let locationData = null;
    let mediaData    = null;
    let body         = msg.body || '';

    if (msg.type === 'location' && msg.location) {
      const { latitude, longitude, description } = msg.location;
      locationData = { latitude, longitude, description: description || null };
      body = description || `📍 ${latitude}, ${longitude}`;
    } else if (hasMedia) {
      // Medya mesajı: indir, base64 olarak gönder (sadece image/video/audio)
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const isViewable = media.mimetype.startsWith('image/') ||
                             media.mimetype.startsWith('video/') ||
                             media.mimetype.startsWith('audio/');
          if (isViewable) {
            mediaData = { mimetype: media.mimetype, data: media.data };
          }
          if (!body) {
            const type = media.mimetype.split('/')[0];
            const icons = { image: '📷 Fotoğraf', video: '🎥 Video', audio: '🎵 Ses' };
            body = icons[type] || '📎 Dosya';
          }
        }
      } catch (_) {
        body = body || '📎 Medya';
      }
    }

    const timestamp = msg.timestamp;

    // Profil fotoğraflarını paralel çek (proxy endpoint için id'leri gönder)
    const [hasPicAuthor, hasPicGroup] = await Promise.all([
      contactId ? getProfilePicUrl(contactId).then(u => !!u) : Promise.resolve(false),
      getProfilePicUrl(chatId).then(u => !!u),
    ]);

    db.insert(groupName, author, body, timestamp, mediaData, locationData, contactId, chatId);

    const payload = {
      groupName, author, body, timestamp,
      contactId, chatId,
      // Frontend proxy URL'lerini kullanacak — boolean gönder yeterli
      hasAuthorPic: hasPicAuthor,
      hasGroupPic:  hasPicGroup,
      media:    mediaData,
      location: locationData,
    };
    io.emit('new_message', payload);

    console.log(`[msg] [${groupName}] ${author}: ${body.slice(0, 80)}`);
  }

  client.on('message', handleMsg); // başkalarından gelen
  client.on('message_create', msg => { if (msg.fromMe) handleMsg(msg); }); // sadece kendi gönderilenleri

  client.initialize();
  waClient = client;
}

createClient();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  try { if (waClient) await waClient.destroy(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
