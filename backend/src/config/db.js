// Supabase client configuration for HypeX
// Replaces MySQL mysql2/promise pool with Supabase JS client
// Schema: supabase/migrations/001_initial_schema.sql

const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Verify connection on startup
async function verifyConnection() {
  try {
    const { data, error } = await supabase.from('users').select('count', { count: 'exact', head: true });
    if (error) throw error;
    console.log('Connected to Supabase successfully.');
    return true;
  } catch (err) {
    console.error('Error connecting to Supabase:', err.message);
    return false;
  }
}

verifyConnection();

module.exports = supabase;
