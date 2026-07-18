const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const groupsRoutes = require('./routes/groups.routes');
const plotsRoutes = require('./routes/plots.routes');
const buyersRoutes = require('./routes/buyers.routes');
const paymentsRoutes = require('./routes/payments.routes');
const documentsRoutes = require('./routes/documents.routes');
const adminRoutes = require('./routes/admin.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const reportsRoutes = require('./routes/reports.routes');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  // Render (and most hosts) sit behind a reverse proxy. Without this,
  // express-rate-limit and req.ip would see every request as coming from
  // the proxy's IP instead of the real client — making rate limiting either
  // useless (can't tell users apart) or wrongly block everyone at once.
  // '1' means trust exactly one hop of proxy (Render's own), not an
  // arbitrary chain, which keeps this from being spoofable via headers.
  app.set('trust proxy', 1);

  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'Arden Darpoh Family Land API' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/groups', groupsRoutes);
  app.use('/api/plots', plotsRoutes);
  app.use('/api/buyers', buyersRoutes);
  app.use('/api/payments', paymentsRoutes);
  app.use('/api/documents', documentsRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/reports', reportsRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
