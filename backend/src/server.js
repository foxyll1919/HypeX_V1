const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables FIRST, before requiring any modules that use them
dotenv.config();

const db = require('./config/db');
const apiRouter = db.isSupabase
  ? require('./routes/api-supabase')
  : require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5000;
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  }
}));

// Parse JSON request payloads
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API Namespace routing
app.use('/api', apiRouter);

// Global express error handler
app.use((err, req, res, next) => {
  console.error('Unhandled API Error:', err.message);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }

  res.status(500).json({
    error: 'Internal Server Error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Node.js/Express Backend running on port ${PORT}`);
  console.log(`Database provider: ${db.isSupabase ? 'Supabase' : 'MySQL'}.`);
});

