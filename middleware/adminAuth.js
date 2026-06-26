// middleware/adminAuth.js
// Protects admin routes with a password from your .env file.
// Usage: router.use(adminAuth) before any admin route.

function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;

  // Check Authorization header: "Bearer YOUR_PASSWORD"
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Also accept ?key=PASSWORD in query string for quick browser testing
  const queryKey = req.query.key;

  if (token === password || queryKey === password) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    hint: 'Send Authorization: Bearer YOUR_ADMIN_PASSWORD header',
  });
}

module.exports = adminAuth;
