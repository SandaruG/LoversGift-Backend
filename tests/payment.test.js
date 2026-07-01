const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { normalizeBaseUrl, verifyWhopSignature, getPayPalRedirectUrls } = require('../routes/payment');

test('normalizeBaseUrl adds https and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeBaseUrl('example.com'), 'https://example.com');
  assert.equal(normalizeBaseUrl(''), 'http://localhost:3000');
});

test('verifyWhopSignature validates the expected HMAC payload', () => {
  const body = JSON.stringify({ event: 'payment.succeeded' });
  const timestamp = '1712345678';
  const secret = 'whop-secret';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  assert.equal(verifyWhopSignature(body, `v1=${expected}`, timestamp, secret), true);
  assert.equal(verifyWhopSignature(body, 'v1=bad-signature', timestamp, secret), false);
});

test('getPayPalRedirectUrls points PayPal back to the backend callback routes', () => {
  const urls = getPayPalRedirectUrls('https://example.com/');
  assert.equal(urls.returnUrl, 'https://example.com/api/payment/paypal/return');
  assert.equal(urls.cancelUrl, 'https://example.com/api/payment/paypal/cancel');
});
