// routes/payment.js
// Whop checkout flow — create a checkout session and activate the gift from webhook confirmation.
//
// 1. POST /api/payment/create-order  → creates a local pending order and a Whop checkout session
// 2. POST /api/payment/whop/webhook  → verifies Whop webhook signature and activates the gift
// 3. POST /api/payment/free-gift     → free products skip payment, go straight to gift

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router  = express.Router();
const axios   = require('axios');
const { getDb } = require('../db/database');
const { nanoid } = require('nanoid');

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'gifts');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${nanoid(10)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

function normalizeBaseUrl(url) {
  let baseUrl = (url || '').trim();
  if (!baseUrl) {
    baseUrl = 'http://localhost:3000';
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }
  return baseUrl.replace(/\/+$/, '');
}

function getPaypalMode() {
  const mode = (process.env.PAYPAL_ENV || process.env.PAYPAL_MODE || 'live').trim().toLowerCase();
  if (!mode) {
    return 'live';
  }
  if (mode !== 'live' && mode !== 'sandbox') {
    throw new Error('PAYPAL_ENV or PAYPAL_MODE must be either "live" or "sandbox"');
  }
  return mode;
}

function resolvePaymentMethod(preferredMethod) {
  const requested = (preferredMethod || '').toLowerCase();
  if (requested === 'paypal' || requested === 'whop') {
    return requested;
  }

  const whopApiKey = process.env.WHOP_API_KEY;
  const whopCompanyId = process.env.WHOP_COMPANY_ID;
  const whopWebhookSecret = process.env.WHOP_WEBHOOK_SECRET;
  const whopPlanId = process.env.WHOP_PLAN_ID;
  const paypalClientId = process.env.PAYPAL_CLIENT_ID;
  const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET;

  const whopEnabled = Boolean(whopApiKey && whopCompanyId && whopWebhookSecret && whopPlanId);
  const paypalEnabled = Boolean(paypalClientId && paypalClientSecret && getPaypalMode());

  if (paypalEnabled && !whopEnabled) return 'paypal';
  if (whopEnabled && !paypalEnabled) return 'whop';
  if (!paypalEnabled && !whopEnabled) return 'whop';

  return 'whop';
}

function getPaymentConfig() {
  const whopApiKey = process.env.WHOP_API_KEY;
  const whopCompanyId = process.env.WHOP_COMPANY_ID;
  const whopWebhookSecret = process.env.WHOP_WEBHOOK_SECRET;
  const whopPlanId = process.env.WHOP_PLAN_ID;
  const paypalClientId = process.env.PAYPAL_CLIENT_ID;
  const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const paypalMode = getPaypalMode();

  const whopEnabled = Boolean(whopApiKey && whopCompanyId && whopWebhookSecret && whopPlanId);
  const paypalEnabled = Boolean(paypalClientId && paypalClientSecret && paypalMode);

  return {
    whopEnabled,
    paypalEnabled,
    preferredMethod: resolvePaymentMethod(),
    paypalClientId: paypalEnabled ? paypalClientId : null,
    paypalMode: paypalEnabled ? paypalMode : null,
  };
}

function verifyWhopSignature(payload, signatureHeader, timestampHeader, secret) {
  if (!payload || !signatureHeader || !timestampHeader || !secret) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${payload}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signatureHeader.replace(/^v1=/, ''));

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function paypalBase() {
  return getPaypalMode() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getPayPalRedirectUrls(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || process.env.BASE_URL || process.env.FRONTEND_URL);
  return {
    returnUrl: `${normalizedBaseUrl}/api/payment/paypal/return`,
    cancelUrl: `${normalizedBaseUrl}/api/payment/paypal/cancel`,
  };
}

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured in environment variables');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await axios.post(
    `${paypalBase()}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data.access_token;
}

async function createPayPalOrder(orderRef, product, amountCents, metadata) {
  const token = await getPayPalToken();
  const amountStr = (amountCents / 100).toFixed(2);
  const response = await axios.post(
    `${paypalBase()}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderRef,
          description: `LoversGift – ${product.title}`,
          amount: {
            currency_code: 'USD',
            value: amountStr,
          },
          custom_id: product.slug || undefined,
        },
      ],
      application_context: {
        brand_name: 'LoversGift',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

async function capturePayPalOrder(paypalOrderId) {
  const token = await getPayPalToken();
  const response = await axios.post(
    `${paypalBase()}/v2/checkout/orders/${paypalOrderId}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

async function createWhopCheckoutSession(orderRef, product, amountCents, metadata) {
  const apiKey = process.env.WHOP_API_KEY;
  const companyId = process.env.WHOP_COMPANY_ID;
  const planId = process.env.WHOP_PLAN_ID;

  if (!apiKey || !companyId || !planId) {
    throw new Error('Whop credentials not configured in environment variables');
  }

  const amount = (amountCents / 100).toFixed(2);
  const successUrl = `${normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL)}/payment-success`;
  const apiBaseUrl = process.env.WHOP_API_BASE_URL || 'https://api.whop.com/v2';
  const commonHeaders = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };

  const attempts = [
    {
      endpoint: `${apiBaseUrl}/checkout_sessions`,
      body: {
        plan_id: planId,
        redirect_url: successUrl,
        metadata: {
          order_ref: orderRef,
          ...metadata,
        },
      },
    },
    {
      endpoint: `${apiBaseUrl}/checkout_configurations`,
      body: {
        mode: 'payment',
        plan_id: planId,
        plan: {
          company_id: companyId,
          currency: 'usd',
          initial_price: parseFloat(amount),
          renewal_price: 0,
          plan_type: 'one_time',
          release_method: 'buy_now',
          title: `LoversGift – ${product.title}`,
          visibility: 'hidden',
          product: {
            external_identifier: orderRef,
            title: `LoversGift – ${product.title}`,
            visibility: 'hidden',
          },
        },
        metadata: {
          order_ref: orderRef,
          ...metadata,
        },
        redirect_url: successUrl,
      },
    },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const response = await axios.post(attempt.endpoint, attempt.body, commonHeaders);
      return response.data;
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Whop checkout attempt failed for ${attempt.endpoint}:`, err.response?.data || err.message);
    }
  }

  throw lastError || new Error('Whop checkout creation failed');
}

// ── Helper: create the gift after payment confirmed ─────────────
function activateGift(db, order) {
  const code      = nanoid(8);
  const expiryHrs = parseInt(process.env.GIFT_EXPIRY_HOURS) || 24;
  const expiresAt = new Date(Date.now() + expiryHrs * 60 * 60 * 1000).toISOString();
  const baseUrl   = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL);

  let parsedExtraData = {};
  try {
    parsedExtraData = order.extra_data ? JSON.parse(order.extra_data) : {};
  } catch (_err) {
    parsedExtraData = {};
  }
  const photoPath = parsedExtraData.photo_path || null;

  // Insert the gift row
  db.prepare(`
    INSERT INTO gifts
      (code, product_id, order_id, sender_name, receiver_name,
       message, special_date, theme, extra_data, photo_path, expires_at, paid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    code,
    order.product_id,
    order.id,
    order.sender_name,
    order.receiver_name,
    order.message,
    order.special_date,
    order.theme,
    JSON.stringify(parsedExtraData || {}),
    photoPath,
    expiresAt
  );

  // Link the gift code back to the order
  db.prepare(`UPDATE orders SET gift_code = ?, status = 'paid', paid_at = datetime('now') WHERE id = ?`)
    .run(code, order.id);

  return {
    code,
    expiresAt,
    shareUrl: `${baseUrl}/g/${code}`,
  };
}

// ── Format gift link response ───────────────────────────────────
function giftResponse(gift, product) {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL);
  return {
    success:      true,
    giftCode:     gift.code,
    shareUrl:     `${baseUrl}/g/${gift.code}`,
    expiresAt:    gift.expiresAt,
    product:      product ? { title: product.title, emoji: product.emoji } : null,
    whatsappUrl:  `https://wa.me/?text=${encodeURIComponent(`💌 I made you something special → ${baseUrl}/g/${gift.code}`)}`,
    messengerUrl: `fb-messenger://share/?link=${encodeURIComponent(`${baseUrl}/g/${gift.code}`)}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// STEP 1 — POST /api/payment/create-order
// Frontend calls this when user clicks "Pay"
// Returns: { checkoutUrl, orderRef, checkoutId }
// ═══════════════════════════════════════════════════════════════
router.post('/create-order', upload.single('photo'), async (req, res) => {
  try {
    const db = getDb();
    const rawExtraData = req.body.extraData || {};
    let extraData = {};
    try {
      extraData = typeof rawExtraData === 'string' ? JSON.parse(rawExtraData) : rawExtraData || {};
    } catch (_err) {
      extraData = {};
    }

    const {
      productId,
      senderName,
      receiverName,
      message,
      specialDate,
      theme = 'rose',
      paymentMethod,
    } = req.body;

    if (!productId || !senderName || !receiverName || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'senderName', 'receiverName', 'message'],
      });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.price_cents === 0) {
      return res.status(400).json({ error: 'This is a free product. Use /api/payment/free-gift instead.' });
    }

    const paymentType = resolvePaymentMethod(paymentMethod);
    const orderRef = `LG-${nanoid(8).toUpperCase()}`;
    const photoPath = req.file ? req.file.filename : extraData.photo_path || null;
    const normalizedExtraData = { ...extraData, ...(photoPath ? { photo_path: photoPath } : {}) };

    db.prepare(`
      INSERT INTO orders
        (order_ref, product_id, amount_cents, currency, sender_name,
         receiver_name, message, special_date, theme, extra_data, status)
      VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderRef,
      product.id,
      product.price_cents,
      senderName.trim(),
      receiverName.trim(),
      message.trim(),
      specialDate || null,
      theme,
      JSON.stringify(normalizedExtraData)
    );

    if (paymentType === 'paypal') {
      const paypalOrder = await createPayPalOrder(orderRef, product, product.price_cents, {
        sender_name: senderName.trim(),
        receiver_name: receiverName.trim(),
        message: message.trim(),
      });
      db.prepare('UPDATE orders SET provider_order_id = ? WHERE order_ref = ?').run(paypalOrder.id || orderRef, orderRef);
      return res.json({
        orderRef,
        paymentMethod: 'paypal',
        paypalOrderId: paypalOrder.id,
      });
    }

    let checkout;
    try {
      checkout = await createWhopCheckoutSession(orderRef, product, product.price_cents, {
        sender_name: senderName.trim(),
        receiver_name: receiverName.trim(),
        message: message.trim(),
        product_slug: product.slug || null,
      });
    } catch (whopErr) {
      const paypalEnabled = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && getPaypalMode());
      if (paypalEnabled) {
        const paypalOrder = await createPayPalOrder(orderRef, product, product.price_cents, {
          sender_name: senderName.trim(),
          receiver_name: receiverName.trim(),
          message: message.trim(),
        });
        db.prepare('UPDATE orders SET provider_order_id = ? WHERE order_ref = ?').run(paypalOrder.id || orderRef, orderRef);
        return res.json({
          orderRef,
          paymentMethod: 'paypal',
          paypalOrderId: paypalOrder.id,
        });
      }
      throw whopErr;
    }

    db.prepare('UPDATE orders SET provider_order_id = ? WHERE order_ref = ?').run(checkout.id || checkout.purchase_url || checkout.redirect_url || orderRef, orderRef);

    res.json({
      orderRef,
      paymentMethod: 'whop',
      checkoutId: checkout.id || null,
      checkoutUrl: checkout.purchase_url || checkout.redirect_url || null,
    });
  } catch (err) {
    console.error('❌ create-order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create checkout. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STEP 2 — POST /api/payment/capture
// Kept for compatibility: actual activation happens from the Whop webhook.
// ═══════════════════════════════════════════════════════════════
router.post('/capture', async (req, res) => {
  try {
    const db = getDb();
    const { orderRef, paymentMethod, paypalOrderId } = req.body;

    if (!orderRef) {
      return res.status(400).json({ error: 'Missing orderRef' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status === 'paid') {
      const gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      return res.json(giftResponse({ code: gift.code, expiresAt: gift.expires_at }, product));
    }

    if ((paymentMethod || resolvePaymentMethod()).toLowerCase() === 'paypal') {
      const captureData = await capturePayPalOrder(paypalOrderId);
      const captureStatus = captureData.status;
      const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      if (captureStatus !== 'COMPLETED' || captureUnit?.status !== 'COMPLETED') {
        db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
        return res.status(402).json({ error: 'PayPal payment was not completed.' });
      }
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      const gift = activateGift(db, order);
      return res.json(giftResponse(gift, product));
    }

    return res.status(202).json({ status: 'pending', message: 'Payment confirmation is pending webhook activation.' });
  } catch (err) {
    console.error('❌ capture error:', err.message);
    res.status(500).json({ error: 'Capture failed.' });
  }
});

router.get('/config', (_req, res) => {
  res.json(getPaymentConfig());
});

router.get('/paypal/return', async (req, res) => {
  try {
    const db = getDb();
    const { orderRef } = req.query;
    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);

    if (!order) {
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel`);
    }

    if (order.status === 'paid') {
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=success&orderRef=${orderRef}`);
    }

    const captureData = await capturePayPalOrder(order.provider_order_id || order.order_ref);
    const captureStatus = captureData.status;
    const captureUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];

    if (captureStatus !== 'COMPLETED' || captureUnit?.status !== 'COMPLETED') {
      db.prepare("UPDATE orders SET status = 'failed' WHERE order_ref = ?").run(orderRef);
      return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel&orderRef=${orderRef}`);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const gift = activateGift(db, order);
    console.log(`💕 Gift activated from PayPal return: ${gift.code} | Order: ${orderRef}`);

    return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=success&orderRef=${orderRef}`);
  } catch (err) {
    console.error('❌ paypal return error:', err.message);
    return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel`);
  }
});

router.get('/paypal/cancel', (req, res) => {
  const { orderRef } = req.query;
  return res.redirect(`${normalizeBaseUrl(process.env.FRONTEND_URL || process.env.BASE_URL)}?payment=cancel&orderRef=${orderRef || ''}`);
});

router.post('/whop/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const db = getDb();
    const rawPayload = req.body ? req.body.toString('utf8') : '';
    const signatureHeader = req.get('webhook-signature') || req.get('x-whop-signature');
    const timestampHeader = req.get('webhook-timestamp') || req.get('x-whop-timestamp');
    const secret = process.env.WHOP_WEBHOOK_SECRET;

    if (!verifyWhopSignature(rawPayload, signatureHeader, timestampHeader, secret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    let payload = {};
    try {
      payload = JSON.parse(rawPayload || '{}');
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const eventType = payload.event || payload.event_type || payload.type || '';
    if (eventType !== 'payment.succeeded' && eventType !== 'payment_paid' && payload?.data?.status !== 'paid') {
      return res.json({ received: true });
    }

    const orderRef = payload?.data?.metadata?.order_ref || payload?.metadata?.order_ref || payload?.data?.plan?.metadata?.order_ref || payload?.data?.product?.metadata?.order_ref;
    let order = null;
    if (orderRef) {
      order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    }

    const fallbackProviderIds = [
      payload?.data?.id,
      payload?.data?.checkout_id,
      payload?.data?.payment_id,
      payload?.data?.purchase_id,
      payload?.data?.order_id,
      payload?.data?.plan?.id,
      payload?.data?.product?.id,
      payload?.data?.product?.external_identifier,
    ].filter(Boolean);

    if (!order && fallbackProviderIds.length) {
      const query = db.prepare('SELECT * FROM orders WHERE provider_order_id = ? OR provider_order_id LIKE ?');
      for (const providerId of fallbackProviderIds) {
        order = query.get(providerId, `%${providerId}%`);
        if (order) break;
      }
    }

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid') {
      return res.json({ received: true, already_processed: true });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const gift = activateGift(db, order);
    console.log(`💕 Gift activated from Whop webhook: ${gift.code} | Order: ${orderRef} | Product: ${product?.title || 'unknown'}`);

    res.json({ received: true, giftCode: gift.code });
  } catch (err) {
    console.error('❌ webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// FREE GIFTS — POST /api/payment/free-gift
// For the "Simple Love Note" (price_cents = 0)
// No PayPal needed — creates gift immediately
// ═══════════════════════════════════════════════════════════════
router.post('/free-gift', (req, res) => {
  try {
    const db = getDb();
    const {
      productId,
      senderName,
      receiverName,
      message,
      specialDate,
      theme = 'rose',
      extraData = {},
    } = req.body;

    if (!productId || !senderName || !receiverName || !message) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'senderName', 'receiverName', 'message'],
      });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.price_cents !== 0) {
      return res.status(400).json({ error: 'This product requires payment. Use /api/payment/create-order instead.' });
    }

    // Rate limit free gifts more strictly (handled by express-rate-limit in server.js)
    // Create a fake "paid" order record for consistency
    const orderRef = `LG-FREE-${nanoid(8).toUpperCase()}`;
    db.prepare(`
      INSERT INTO orders
        (order_ref, product_id, amount_cents, currency, sender_name,
         receiver_name, message, special_date, theme, extra_data, status)
      VALUES (?, ?, 0, 'USD', ?, ?, ?, ?, ?, ?, 'paid')
    `).run(
      orderRef, product.id,
      senderName.trim(), receiverName.trim(), message.trim(),
      specialDate || null, theme, JSON.stringify(extraData)
    );

    const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef);
    const gift  = activateGift(db, order);

    res.json(giftResponse(gift, product));

  } catch (err) {
    console.error('❌ free-gift error:', err.message);
    res.status(500).json({ error: 'Failed to create gift. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POLL — GET /api/payment/status/:orderRef
// Frontend polls this after PayPal redirect (fallback for popup blockers)
// ═══════════════════════════════════════════════════════════════
router.get('/status/:orderRef', (req, res) => {
  const db    = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(req.params.orderRef);

  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'paid' && order.gift_code) {
    const gift    = db.prepare('SELECT * FROM gifts WHERE code = ?').get(order.gift_code);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000');
    return res.json({
      status: 'paid',
      shareUrl:     `${baseUrl}/g/${order.gift_code}`,
      giftCode:     order.gift_code,
      expiresAt:    gift?.expires_at,
      whatsappUrl:  `https://wa.me/?text=${encodeURIComponent(`💌 I made you something special → ${baseUrl}/g/${order.gift_code}`)}`,
      messengerUrl: `fb-messenger://share/?link=${encodeURIComponent(`${baseUrl}/g/${order.gift_code}`)}`,
      product:      product ? { title: product.title, emoji: product.emoji } : null,
    });
  }

  res.json({ status: order.status });
});

module.exports = { router, normalizeBaseUrl, verifyWhopSignature, getPayPalRedirectUrls };