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
const port = process.env.PORT || 5000;

// Enable CORS requests from React dev client (port 5173)
app.use(cors());

// Parse JSON request payloads
app.use(express.json());

// API Namespace routing
app.use('/api', apiRouter);

// Global express error handler
app.use((err, req, res, next) => {
  console.error('Unhandled API Error:', err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    details: err.message
  });
});

app.listen(port, () => {
  console.log(`Node.js/Express Backend running on http://localhost:${port}`);
  console.log(`Database provider: ${db.isSupabase ? 'Supabase' : 'MySQL'}.`);
});

