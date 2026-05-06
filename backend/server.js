import express from 'express';
import cors from 'cors';
import { runMigrations } from './lib/db.js';
import adminSessionRouter from './routes/admin-session.js';
import adminAllowedEmailsRouter from './routes/admin-allowed-emails.js';
import requestLinkRouter from './routes/request-link.js';
import verifyTokenRouter from './routes/verify-token.js';
import submitRouter from './routes/submit.js';

const app = express();

app.set('trust proxy', 1); // Railway sits behind a proxy

// EXTRA_ALLOWED_ORIGINS: optional CSV of additional exact-match origins (no wildcards,
// no glob expansion — a literal string like "*.github.io" will simply never match).
const extraAllowed = (process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  process.env.FRONTEND_BASE_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5173',
  ...extraAllowed,
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl, server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
}));

app.use(express.json({ limit: '5mb' }));

// Lightweight request logger (no body — signature data URLs are huge and tokens are sensitive).
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use('/api/admin/session', adminSessionRouter);
app.use('/api/admin/allowed-emails', adminAllowedEmailsRouter);
app.use('/api/request-link', requestLinkRouter);
app.use('/api/verify-token', verifyTokenRouter);
app.use('/api/submit', submitRouter);

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3000);

(async () => {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[boot] migration failed', err);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[boot] District 6 Compliance API listening on :${PORT}`);
  });
})();
