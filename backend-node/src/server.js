import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { authRequired } from './auth.js';
import authRouter from './routes/auth.js';
import cardsRouter from './routes/cards.js';
import dashboardRouter from './routes/dashboard.js';
import clickRouter from './routes/click.js';
import transfersRouter from './routes/transfers.js';
import cryptoRouter from './routes/crypto.js';
import ratingRouter from './routes/rating.js';
import rouletteRouter from './routes/roulette.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: config.corsOrigin === '*' ? '*' : config.corsOrigin }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'RE Bank API' }));
app.use('/api/auth', authRouter);
app.use('/api/cards', authRequired, cardsRouter);
app.use('/api/dashboard', authRequired, dashboardRouter);
app.use('/api/click', authRequired, clickRouter);
app.use('/api/transfers', authRequired, transfersRouter);
app.use('/api/crypto', authRequired, cryptoRouter);
app.use('/api', authRequired, ratingRouter);
app.use('/api/roulette', authRequired, rouletteRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === '23505') return res.status(409).json({ error: 'Unique value already exists' });
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`RE Bank API listening on port ${config.port}`);
});
