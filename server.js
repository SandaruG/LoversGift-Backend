// server.js — LoversGift Backend
// Run: node server.js  (or  npm start)

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const { getDb }           = require('./db/database');
const { startCleanupJob } = require('./db/cleanup');
const productsRouter      = require('./routes/products');
const giftsRouter         = require('./routes/gifts');
const adminAuth           = require('./middleware/adminAuth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Initialise database on startup ─────────────────────────────
getDb();

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({
  // In production, change this to your actual frontend domain:
  // e.g. 'https://loversgift.io' or your Netlify/GitHub Pages URL
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Serve uploaded photos as static files ──────────────────────
// Photos are accessible at: GET /gifts/filename.jpg
app.use('/gifts', express.static(path.join(__dirname, 'public', 'gifts')));

// ── Rate limiting (prevents abuse) ────────────────────────────
const createGiftLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 gifts per 15 mins per IP
  message: { error: 'Too many gifts created. Please try again in 15 minutes.' },
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests.' },
});

app.use('/api/', generalLimiter);
app.use('/api/gifts', createGiftLimiter);

// ── API Routes ─────────────────────────────────────────────────

// Products — public endpoints
app.use('/api/products', productsRouter);

// Gifts — public endpoints
app.use('/api/gifts', giftsRouter);

// Admin — all protected by ADMIN_PASSWORD ──────────────────────
// Products admin
app.post  ('/api/admin/products',     adminAuth, (req, res, next) => { req.url = '/'; next(); }, productsRouter);
app.patch ('/api/admin/products/:id', adminAuth, (req, res, next) => { req.params; next(); },   productsRouter);
app.delete('/api/admin/products/:id', adminAuth, (req, res, next) => { next(); },               productsRouter);

// These admin sub-routes are handled inside the routers themselves
// GET /api/admin/gifts  → giftsRouter handles /admin/all
// GET /api/admin/stats  → giftsRouter handles /admin/stats

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Root info ──────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'LoversGift API',
    version: '1.0.0',
    endpoints: {
      products:    'GET /api/products',
      product:     'GET /api/products/:slug',
      createGift:  'POST /api/gifts',
      viewGift:    'GET /api/gifts/:code',
      openGift:    'GET /api/gifts/:code/view',
      adminStats:  'GET /api/admin/stats  (requires admin password)',
      adminGifts:  'GET /api/admin/gifts  (requires admin password)',
    },
  });
});

// ── 404 handler ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
💕 LoversGift Backend running
   ┌─────────────────────────────────────────┐
   │  http://localhost:${PORT}                    │
   │  Environment: ${process.env.NODE_ENV || 'development'}               │
   └─────────────────────────────────────────┘
  `);

  // Start the gift expiry cleanup job
  startCleanupJob();
});

module.exports = app;
