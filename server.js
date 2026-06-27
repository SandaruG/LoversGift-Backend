// server.js — LoversGift Backend
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const { getDb }           = require('./db/database');
const { startCleanupJob } = require('./db/cleanup');
const productsRouter      = require('./routes/products');
const giftsRouter         = require('./routes/gifts');
const paymentRouter       = require('./routes/payment');
const adminAuth           = require('./middleware/adminAuth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Init DB ────────────────────────────────────────────────────
getDb();

// ── CORS ───────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));

// ── Body parsers ───────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Static: uploaded gift photos ───────────────────────────────
app.use('/gifts', express.static(path.join(__dirname, 'public', 'gifts')));

// ── Gift view pages ────────────────────────────────────────────
// GET /g/:code  → serves the animated love letter HTML
// The page fetches its own data from /api/gifts/:code/view
app.get('/g/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gift-letter.html'));
});

// ── Rate limiting ──────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests.' },
});
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many payment attempts. Please try again in 15 minutes.' },
});
const freeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Free gift limit reached. Please try again in an hour.' },
});

app.use('/api/', generalLimiter);
app.use('/api/payment/create-order', paymentLimiter);
app.use('/api/payment/capture',      paymentLimiter);
app.use('/api/payment/free-gift',    freeLimiter);

// ── API Routes ─────────────────────────────────────────────────
app.use('/api/products', productsRouter);
app.use('/api/gifts',    giftsRouter);
app.use('/api/payment',  paymentRouter);

// ── Admin routes ───────────────────────────────────────────────
app.post  ('/api/admin/products',     adminAuth, (req, res, next) => { req.url = '/'; next(); }, productsRouter);
app.patch ('/api/admin/products/:id', adminAuth, (req, res, next) => next(), productsRouter);
app.delete('/api/admin/products/:id', adminAuth, (req, res, next) => next(), productsRouter);

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const db = getDb();
  const productCount = db.prepare('SELECT COUNT(*) as n FROM products WHERE active=1').get().n;
  const activeGifts  = db.prepare("SELECT COUNT(*) as n FROM gifts WHERE expires_at > datetime('now')").get().n;
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    products: productCount,
    activeGifts,
    paypal: process.env.PAYPAL_ENV || 'sandbox',
  });
});

// ── Root ───────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'LoversGift API 💕',
    version: '2.0.0',
    routes: {
      giftPage:       'GET  /g/:code  → animated love letter page',
      products:       'GET  /api/products',
      createOrder:    'POST /api/payment/create-order',
      capturePayment: 'POST /api/payment/capture',
      freeGift:       'POST /api/payment/free-gift',
      viewGift:       'GET  /api/gifts/:code/view',
      adminStats:     'GET  /api/gifts/admin/stats  (auth required)',
    },
  });
});

// ── 404 ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error ───────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('❌', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  const env = process.env.PAYPAL_ENV || 'sandbox';
  console.log(`
💕 LoversGift Backend v2.0
   ┌──────────────────────────────────────────┐
   │  http://localhost:${PORT}                     │
   │  Gift pages: /g/:code                    │
   │  PayPal: ${env === 'live' ? '🟢 LIVE (real money)    ' : '🟡 SANDBOX (test mode) '}   │
   │  DB: SQLite (loversgift.db)              │
   └──────────────────────────────────────────┘
  `);
  startCleanupJob();
});

module.exports = app;
