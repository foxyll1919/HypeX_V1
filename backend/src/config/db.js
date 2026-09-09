// Database configuration for HypeX. Supabase is preferred when configured;
// MySQL remains available as the local fallback.

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const hasSupabaseConfig = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
);

if (hasSupabaseConfig && process.env.DB_PROVIDER !== 'mysql') {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  client.isSupabase = true;
  console.log('Using Supabase database provider.');
  module.exports = client;
  return;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nmm_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true // Required to run schema.sql
});

// Verify connection on startup
async function verifyConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.query('SELECT 1');
    console.log('Connected to MySQL database successfully.');
    conn.release();
    return true;
  } catch (err) {
    console.error('Error connecting to MySQL database:', err.message);
    return false;
  }
}

verifyConnection();

// Initialize database schema on startup
async function initializeDatabase() {
  const schemaPath = path.join(__dirname, '../../../database/schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    try {
      const conn = await pool.getConnection();
      await conn.query(schemaSql);
      console.log('Database tables initialized successfully.');
      conn.release();
    } catch (err) {
      console.error('Error executing schema.sql:', err.message);
    }
  }
}

initializeDatabase();

// Database abstraction that matches the original mysql2/promise interface
const query = {
  /**
   * Execute a query and return all rows
   * @param {string} sql - SQL query string with ? placeholders
   * @param {array} params - Array of parameters to substitute
   * @returns {array} Array of row objects
   */
  all: async (sql, params = []) => {
    try {
      const [rows] = await pool.query(sql, params);
      return rows;
    } catch (err) {
      console.error(`DB all() error on query: ${sql.substring(0, 50)}...`, err.message);
      throw err;
    }
  },

  /**
   * Execute a query and return the first row
   * @param {string} sql - SQL query string with ? placeholders
   * @param {array} params - Array of parameters to substitute
   * @returns {object|null} First row object or null
   */
  get: async (sql, params = []) => {
    try {
      const [rows] = await pool.query(sql, params);
      return rows[0] || null;
    } catch (err) {
      console.error(`DB get() error on query: ${sql.substring(0, 50)}...`, err.message);
      throw err;
    }
  },

  /**
   * Execute a query that modifies data (INSERT/UPDATE/DELETE)
   * @param {string} sql - SQL query string with ? placeholders
   * @param {array} params - Array of parameters to substitute
   * @returns {object} Result with id and changes count
   */
  run: async (sql, params = []) => {
    try {
      const [result] = await pool.execute(sql, params);
      return {
        id: result.insertId,
        changes: result.affectedRows
      };
    } catch (err) {
      console.error(`DB run() error on query: ${sql.substring(0, 50)}...`, err.message);
      throw err;
    }
  },

  /**
   * Execute a query without expecting results (for DDL statements)
   * @param {string} sql - SQL query string
   */
  exec: async (sql) => {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error(`DB exec() error: ${sql.substring(0, 50)}...`, err.message);
      throw err;
    }
  },

  /**
   * Get the connection pool for advanced operations (transactions)
   */
  pool: pool
};

module.exports = query;
module.exports.pool = pool;
module.exports.isSupabase = false;
