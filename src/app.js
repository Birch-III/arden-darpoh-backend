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
