/**
 * preview-server.js
 * Müşteriye göstermek için mock data ile çalışan demo sunucu.
 * Gerçek WhatsApp bağlantısı yok — tamamen sahte veri.
 *
 * Çalıştır: node preview-server.js
 * Açıl:    http://localhost:3001
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const PORT = 3001;
const now  = () => Math.floor(Date.now() / 1000);

// ── Mock medya üreticileri ─────────────────────────────────────────────────────

/** Gradient + emoji ile fotoğraf placeholder SVG → base64 */
function photoSvg(emoji, from, to, caption = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
    </defs>
    <rect width="400" height="300" fill="url(#g)" rx="16"/>
    <text x="200" y="145" font-size="90" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
    ${caption ? `<text x="200" y="258" font-size="19" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-family="system-ui,sans-serif">${caption}</text>` : ''}
  </svg>`;
  return { mimetype: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
}

/** Animasyonlu play-button video thumbnail SVG → base64
 *  Frontend bunu image olarak render eder, görsel olarak video karesine benzer. */
function videoThumbSvg(emoji, from, to) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
    </defs>
    <rect width="400" height="300" fill="url(#g)" rx="16"/>
    <text x="200" y="128" font-size="62" text-anchor="middle" dominant-baseline="middle" opacity="0.55">${emoji}</text>
    <!-- video süre etiketi -->
    <rect x="318" y="262" width="64" height="22" rx="5" fill="rgba(0,0,0,0.55)"/>
    <text x="350" y="277" font-size="12" text-anchor="middle" fill="white" font-family="monospace">0:14</text>
    <!-- play butonu -->
    <circle cx="200" cy="195" r="30" fill="rgba(0,0,0,0.52)"/>
    <polygon points="191,182 191,208 216,195" fill="white"/>
  </svg>`;
  return { mimetype: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
}

// Hazır medya nesneleri
const MEDIA = {
  photo_sunset:   photoSvg('🌅', '#ff6b35', '#f7c59f', 'Ofis binasından gün batımı'),
  photo_meeting:  photoSvg('📊', '#2c3e50', '#3498db', 'Toplantı notları'),
  photo_lunch:    photoSvg('🍝', '#e74c3c', '#f39c12', 'Öğle yemeği'),
  photo_deploy:   photoSvg('🎉', '#8e44ad', '#3498db', 'Deploy sonrası kutlama'),
  photo_screen:   photoSvg('💻', '#1a1a2e', '#16213e', 'Ekran görüntüsü'),
  photo_whiteboard: photoSvg('🗒️', '#f5f5f5'.replace('f5f5f5', 'eceff1'), '#b0bec5', 'Beyaz tahta'),
  video_standup:  videoThumbSvg('🎥', '#0f2027', '#2c5364'),
  video_demo:     videoThumbSvg('🚀', '#1a1a2e', '#533483'),
  video_funny:    videoThumbSvg('😂', '#134e5e', '#71b280'),
};

// Konum verileri (gerçek koordinatlar)
const LOCS = {
  taksim:   { latitude: 41.0369,  longitude: 28.9851,  description: 'Taksim Meydanı, İstanbul' },
  levent:   { latitude: 41.0782,  longitude: 29.0128,  description: 'Levent, İstanbul' },
  restaurant: { latitude: 41.0302, longitude: 28.9784,  description: 'Osmanlı Restaurant' },
  ankara:   { latitude: 39.9208,  longitude: 32.8541,  description: 'Kızılay, Ankara' },
  izmir:    { latitude: 38.4192,  longitude: 27.1287,  description: 'Konak, İzmir' },
  office:   { latitude: 41.0557,  longitude: 29.0108,  description: 'Ofis — Maslak, İstanbul' },
};

// ── Kişi profilleri ───────────────────────────────────────────────────────────
// Kayıtlı: gerçek ad
// Kayıtsız handle: @kullaniciadi (rehbere eklenmemiş, WA handle'ı görünür)
// Kayıtsız numara: sadece +90... (hiç kayıt yok)

const P = {
  ahmet:   { a: 'Ahmet Yılmaz',   id: '905551234567@c.us' },  // kayıtlı
  zeynep:  { a: 'Zeynep Kaya',    id: '905557654321@c.us' },  // kayıtlı
  murat:   { a: 'Murat Demir',    id: '905553456789@c.us' },  // kayıtlı
  elif:    { a: 'Elif Şahin',     id: '905559876543@c.us' },  // kayıtlı
  omer:    { a: 'Ömer Çelik',     id: '905552345678@c.us' },  // kayıtlı
  // Kayıtsız — handle görünür
  handle1: { a: '@berk.arslan',   id: '905554321098@c.us' },
  handle2: { a: '@selin_y',       id: '905556789012@c.us' },
  // Kayıtsız — numara görünür
  num1:    { a: '+90 533 812 44 67', id: '905338124467@c.us' },
  num2:    { a: '+90 542 907 33 21', id: '905429073321@c.us' },
};

// ── Geçmiş mesajlar ────────────────────────────────────────────────────────────
const HISTORY = [
  // ── Proje Ekibi ──
  { g: 'Proje Ekibi 🚀', ...P.ahmet,  t: -7200, b: 'Günaydın ekip 👋 Bugün deploy günümüz.' },
  { g: 'Proje Ekibi 🚀', ...P.zeynep, t: -7100, b: 'Günaydın! Testleri sabah bitirdim, hazır ✅' },
  { g: 'Proje Ekibi 🚀', ...P.murat,  t: -7050, b: 'Ben de loglara bakıyorum, sorun yok görünüyor.' },
  // Kayıtsız biri de konuşmaya katılıyor
  { g: 'Proje Ekibi 🚀', ...P.handle1, t: -7020, b: 'Harika, ben de hazırım 💪' },

  // Fotoğraf: toplantı notları
  { g: 'Proje Ekibi 🚀', ...P.elif,    t: -6950, b: 'Sabah notlarını çektim 📸', media: MEDIA.photo_meeting },

  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t: -6800, b: 'Harika. Staging\'i bir daha kontrol edelim önce.' },
  { g: 'Proje Ekibi 🚀', ...P.zeynep,  t: -6600, b: 'Staging tamam, validasyonlar çalışıyor 🎉' },
  // Kayıtsız numara — sadece telefon numarası görünüyor
  { g: 'Proje Ekibi 🚀', ...P.num1,    t: -6550, b: 'Ben de onayladım, looks good 👍' },
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t: -6500, b: 'Deploy\'a geçelim. Murat hazır mısın?' },
  { g: 'Proje Ekibi 🚀', ...P.murat,   t: -6400, b: 'Hazırım, CI pipeline\'ı başlattım ✅' },

  // Video: standup kaydı
  { g: 'Proje Ekibi 🚀', ...P.elif,    t: -6200, b: '🎥 Dünkü standup kaydı', media: MEDIA.video_standup },

  { g: 'Proje Ekibi 🚀', ...P.zeynep,  t: -6000, b: 'Deploy tamamlandı! 🚀 v2.4.1 production\'da.' },
  // Fotoğraf: kutlama
  { g: 'Proje Ekibi 🚀', ...P.murat,   t: -5950, b: '🎊', media: MEDIA.photo_deploy },
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t: -5800, b: 'Tebrikler herkese, harika iş çıkardık 💪' },

  // ── Ofis Genel ──
  { g: 'Ofis Genel 💼', ...P.omer,     t: -5400, b: 'Merhaba! Öğle yemeği için kim var? 🍕' },
  { g: 'Ofis Genel 💼', ...P.zeynep,   t: -5350, b: 'Ben varım! Nereye gidiyoruz?' },
  // Kayıtsız handle — WhatsApp handle'ı görünüyor
  { g: 'Ofis Genel 💼', ...P.handle2,  t: -5330, b: 'Ben de geliyorum!' },
  { g: 'Ofis Genel 💼', ...P.murat,    t: -5300, b: 'Köşedeki Osmanlı\'ya gidelim mi?' },
  // Konum: restaurant
  { g: 'Ofis Genel 💼', ...P.omer,     t: -5260, b: '📍 Osmanlı Restaurant', location: LOCS.restaurant },
  { g: 'Ofis Genel 💼', ...P.elif,     t: -5200, b: 'Ben biraz geç gelebilirim ama katılmaya çalışırım 😅' },
  // Fotoğraf: yemek
  { g: 'Ofis Genel 💼', ...P.omer,     t: -4900, b: 'Enfes 😋', media: MEDIA.photo_lunch },
  // Kayıtsız numara yorum yapıyor
  { g: 'Ofis Genel 💼', ...P.num2,     t: -4860, b: 'Gelemiyorum bugün 😞' },
  { g: 'Ofis Genel 💼', ...P.ahmet,    t: -4800, b: 'Yarınki toplantı iptal mi? Takvimde gördüm.' },
  { g: 'Ofis Genel 💼', ...P.omer,     t: -4700, b: 'Evet iptal, Perşembe\'ye alındı.' },
  // Fotoğraf: gün batımı
  { g: 'Ofis Genel 💼', ...P.zeynep,   t: -4600, b: 'Ofisten böyle görünüyor şu an 🌅', media: MEDIA.photo_sunset },

  // ── Müşteri Destek ──
  { g: 'Müşteri Destek ⚡', ...P.zeynep,  t: -4200, b: 'Müşteri #1423 için ticket geldi. Ödeme sayfasında hata.' },
  { g: 'Müşteri Destek ⚡', ...P.murat,   t: -4100, b: 'Bakıyorum hemen.' },
  // Kayıtsız handle destek grubunda
  { g: 'Müşteri Destek ⚡', ...P.handle1, t: -4080, b: 'Müşteri canlı chat\'te de yazıyor, hızlı çözelim.' },
  // Fotoğraf: ekran görüntüsü
  { g: 'Müşteri Destek ⚡', ...P.zeynep,  t: -4050, b: 'Müşterinin gönderdiği ekran görüntüsü:', media: MEDIA.photo_screen },
  { g: 'Müşteri Destek ⚡', ...P.murat,   t: -4000, b: 'Buldum — ödeme gateway\'inde timeout. Destek ekibine ilettim.' },
  { g: 'Müşteri Destek ⚡', ...P.zeynep,  t: -3900, b: 'Müşteriyi bilgilendiriyorum 🙏' },
  { g: 'Müşteri Destek ⚡', ...P.elif,    t: -3600, b: 'Gateway düzeldi ✅ Ticket kapatabilirsin.' },

  // ── Proje Ekibi — devam ──
  { g: 'Proje Ekibi 🚀', ...P.zeynep,  t: -2400, b: 'Deploy sonrası hata oranı %3\'ten %0.2\'ye düştü 📉' },
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t: -2300, b: 'Bu veriyi raporda kullanacağız.' },
  // Video: demo kaydı
  { g: 'Proje Ekibi 🚀', ...P.murat,   t: -2100, b: '🎥 Yeni API\'nin demo kaydı', media: MEDIA.video_demo },
  { g: 'Proje Ekibi 🚀', ...P.elif,    t: -2000, b: 'Çok akıcı olmuş, tebrikler 🔥' },
  // Kayıtsız numara övgü yapıyor
  { g: 'Proje Ekibi 🚀', ...P.num1,    t: -1950, b: '🔥🔥' },

  // ── Ofis Genel — devam ──
  { g: 'Ofis Genel 💼', ...P.omer,    t: -1800, b: 'Mutfakta pasta var 🎂' },
  { g: 'Ofis Genel 💼', ...P.elif,    t: -1750, b: 'Geliyo geliyo!! 🏃‍♀️' },
  // Konum: Ankara remote
  { g: 'Ofis Genel 💼', ...P.murat,   t: -1700, b: '📍 Remote\'dayım bugün', location: LOCS.ankara },
  // Kayıtsız handle konum soruyor
  { g: 'Ofis Genel 💼', ...P.handle2, t: -1660, b: 'Ne zaman dönüyorsun Murat?' },
  { g: 'Ofis Genel 💼', ...P.murat,   t: -1640, b: 'Cuma 🙂' },

  // ── Müşteri Destek — devam ──
  { g: 'Müşteri Destek ⚡', ...P.murat,   t: -1200, b: 'Yeni ticket: Müşteri #1891 mobil uygulamada bildirim almıyor.' },
  { g: 'Müşteri Destek ⚡', ...P.elif,    t: -1100, b: 'Bakıyorum. Push token sorunu olabilir.' },
  { g: 'Müşteri Destek ⚡', ...P.handle1, t: -1050, b: 'Aynı sorunu ben de test ortamında gördüm.' },

  // ── Proje Ekibi — son mesajlar ──
  { g: 'Proje Ekibi 🚀', ...P.elif,    t:  -600, b: 'Bir sonraki sprint için kart: dark mode desteği 🌙' },
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t:  -550, b: 'Süper fikir! Ekleyelim.' },
  // Fotoğraf: sprint planı beyaz tahta
  { g: 'Proje Ekibi 🚀', ...P.zeynep,  t:  -480, b: 'Sprint planı 📋', media: MEDIA.photo_whiteboard },
  { g: 'Proje Ekibi 🚀', ...P.murat,   t:  -430, b: 'Dark mode kullanıcıların %60\'ı tercih ediyor 😅' },
  { g: 'Proje Ekibi 🚀', ...P.zeynep,  t:  -400, b: 'Kesinlikle öncelikli yapmalıyız!' },
  // Konum: akşam buluşması
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   t:  -300, b: 'Akşam kutlama için buluşuyoruz 🎉', location: LOCS.taksim },
  // Kayıtsız numara katılıyor
  { g: 'Proje Ekibi 🚀', ...P.num2,    t:  -280, b: 'Ben de gelirim!' },
];

function buildMessages() {
  const base = now();
  return HISTORY.map(h => ({
    groupName:    h.g,
    author:       h.a,
    body:         h.b,
    timestamp:    base + h.t,
    contactId:    h.id,
    chatId:       h.g.toLowerCase().replace(/[^a-z0-9]/g, '') + '@g.us',
    media:        h.media   || null,
    location:     h.location || null,
    hasAuthorPic: false,
    hasGroupPic:  false,
  }));
}

// ── Canlı mesaj simülasyonu (bağlanınca otomatik düşer) ───────────────────────
const LIVE_MSGS = [
  { g: 'Proje Ekibi 🚀', ...P.ahmet,   b: 'Dark mode için tasarımcıya yazdım, taslak geliyor 🎨', delay: 8000 },
  { g: 'Ofis Genel 💼',  ...P.omer,    b: 'Pasta bitti btw 😂',                                    delay: 16000 },
  // Kayıtsız handle canlı yazıyor
  { g: 'Proje Ekibi 🚀', ...P.handle1, b: 'Dark mode için purple tema öneririm 👀',                delay: 20000 },
  // Canlı fotoğraf
  { g: 'Ofis Genel 💼',  ...P.elif,    b: 'Harika bir gün 🌆', delay: 25000,
    media: photoSvg('🌆', '#fc4445', '#3b1f2b', 'İstanbul akşamı') },
  { g: 'Müşteri Destek ⚡', ...P.elif, b: 'Push token yenilendi, bildirimler çalışıyor ✅',        delay: 33000 },
  // Kayıtsız numara canlı
  { g: 'Müşteri Destek ⚡', ...P.num2, b: 'Teşekkürler, müşteri onayladı.',                        delay: 37000 },
  // Canlı konum
  { g: 'Ofis Genel 💼',  ...P.murat,   b: '📍 Levent ofisindeyim', delay: 43000, location: LOCS.levent },
  { g: 'Proje Ekibi 🚀', ...P.zeynep,  b: 'Tasarım geldi, harika görünüyor 🌙✨',                  delay: 52000 },
  // Canlı video
  { g: 'Proje Ekibi 🚀', ...P.murat,   b: '🎥 Dark mode prototype', delay: 62000,
    media: videoThumbSvg('🌙', '#0f0c29', '#302b63') },
  // Kayıtsız handle video'ya tepki
  { g: 'Proje Ekibi 🚀', ...P.handle2, b: 'Çok güzel çıkmış 😍',                                  delay: 67000 },
  { g: 'Müşteri Destek ⚡', ...P.zeynep, b: 'Bugün 5 ticket kapattık 💪',                         delay: 74000 },
  { g: 'Ofis Genel 💼',  ...P.ahmet,   b: 'Herkese iyi akşamlar! 🌆',                             delay: 86000 },
];

// ── Express + Socket.io ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/messages', (_req, res) => res.json(buildMessages()));
app.get('/api/proxy-pic', (_req, res) => res.status(404).end());
app.get('/health', (_req, res) => res.json({ status: 'preview', mode: 'mock', ts: Date.now() }));

io.on('connection', (socket) => {
  setTimeout(() => socket.emit('wa_status', { status: 'ready' }), 600);

  const timers = LIVE_MSGS.map(({ g, a, id, b, delay, media, location }) =>
    setTimeout(() => {
      io.emit('new_message', {
        groupName:    g,
        author:       a,          // P.* spread'den gelir
        body:         b,
        timestamp:    now(),
        contactId:    id,         // P.* spread'den gelir
        chatId:       g.toLowerCase().replace(/[^a-z0-9]/g, '') + '@g.us',
        media:        media    || null,
        location:     location || null,
        hasAuthorPic: false,
        hasGroupPic:  false,
      });
    }, delay)
  );

  socket.on('disconnect', () => timers.forEach(clearTimeout));
});

server.listen(PORT, () => {
  console.log(`\n[preview] Demo sunucu hazır → http://localhost:${PORT}`);
  console.log('[preview] Mock veri: metin + fotoğraf + video thumbnail + konum\n');
});
