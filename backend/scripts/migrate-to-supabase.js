#!/usr/bin/env node

/**
 * Data Migration Script: MySQL → Supabase
 *
 * This script migrates all data from your local MySQL database to Supabase Cloud.
 * Run this AFTER the schema has been created in Supabase.
 *
 * Usage:
 *   node scripts/migrate-to-supabase.js
 */

const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// MySQL connection (legacy)
const mysqlPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nmm_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function migrateMaterials() {
  console.log('📦 Migrating materials...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM materials');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No materials to migrate');
      return [];
    }

    // Insert in batches of 100
    const batchSize = 100;
    const materialIds = [];
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      // Convert MySQL datetime to ISO string
      const convertedBatch = batch.map(m => ({
        id: m.id,
        cpse_name: m.cpse_name,
        original_code: m.original_code,
        sap_code: m.sap_code,
        description: m.description,
        material_known_as: m.material_known_as,
        unit: m.unit,
        specifications: m.specifications,
        technical_parameters: m.technical_parameters,
        material_type: m.material_type,
        material_grade: m.material_grade,
        dimension: m.dimension,
        dimension_unit: m.dimension_unit,
        length: m.length,
        length_unit: m.length_unit,
        pressure: m.pressure,
        pressure_unit: m.pressure_unit,
        standard_reference: m.standard_reference,
        unit_of_measurement: m.unit_of_measurement,
        classification: m.classification,
        normalized_description: m.normalized_description,
        match_status: m.match_status || 'PENDING',
        national_code: m.national_code,
        thread_size: m.thread_size,
        thread_length: m.thread_length,
        thread_length_unit: m.thread_length_unit,
        created_at: m.created_at,
        updated_at: m.updated_at
      }));

      const { error } = await supabase
        .from('materials')
        .insert(convertedBatch);

      if (error) throw error;

      materialIds.push(...convertedBatch.map(m => m.id));
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(rows.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${rows.length} materials`);
    return materialIds;
  } catch (err) {
    console.error('❌ Material migration failed:', err.message);
    throw err;
  }
}

async function migrateEmbeddings(materialIds) {
  console.log('🔢 Migrating embeddings...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM material_embeddings');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No embeddings to migrate');
      return;
    }

    // Convert JSON embeddings to pgvector format (array of floats)
    const embeddings = rows
      .filter(e => materialIds.includes(e.material_id))
      .map(e => ({
        material_id: e.material_id,
        embedding: typeof e.embedding === 'string'
          ? JSON.parse(e.embedding)
          : e.embedding
      }));

    const batchSize = 100;
    for (let i = 0; i < embeddings.length; i += batchSize) {
      const batch = embeddings.slice(i, i + batchSize);

      const { error } = await supabase
        .from('material_embeddings')
        .insert(batch, { returning: 'minimal' });

      if (error) throw error;
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(embeddings.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${embeddings.length} embeddings`);
  } catch (err) {
    console.error('❌ Embedding migration failed:', err.message);
    throw err;
  }
}

async function migrateMatches() {
  console.log('🔗 Migrating matches...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM matches');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No matches to migrate');
      return;
    }

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize).map(m => ({
        id: m.id,
        material_a_id: m.material_a_id,
        material_b_id: m.material_b_id,
        semantic_score: m.semantic_score,
        technical_score: m.technical_score,
        final_score: m.final_score,
        result: m.result,
        reason: m.reason,
        comparison: typeof m.comparison === 'string' ? JSON.parse(m.comparison) : m.comparison,
        status: m.status || 'PENDING',
        reviewer_comment: m.reviewer_comment,
        reviewed_by: m.reviewed_by,
        reviewed_at: m.reviewed_at,
        created_at: m.created_at
      }));

      const { error } = await supabase
        .from('matches')
        .insert(batch, { returning: 'minimal' });

      if (error) throw error;
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(rows.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${rows.length} matches`);
  } catch (err) {
    console.error('❌ Match migration failed:', err.message);
    throw err;
  }
}

async function migrateClusters() {
  console.log('🗂️ Migrating clusters...');
  try {
    const conn = await mysqlPool.getConnection();

    const [clusters] = await conn.query('SELECT * FROM clusters');
    if (clusters.length > 0) {
      const { error } = await supabase
        .from('clusters')
        .insert(clusters, { returning: 'minimal' });
      if (error) throw error;
      console.log(`  ✓ ${clusters.length} clusters`);
    }

    const [members] = await conn.query('SELECT * FROM cluster_members');
    if (members.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < members.length; i += batchSize) {
        const batch = members.slice(i, i + batchSize);
        const { error } = await supabase
          .from('cluster_members')
          .insert(batch, { returning: 'minimal' });
        if (error) throw error;
      }
      console.log(`  ✓ ${members.length} cluster members`);
    }

    conn.release();
    console.log('✅ Clusters migrated');
  } catch (err) {
    console.error('❌ Cluster migration failed:', err.message);
    throw err;
  }
}

async function migrateNationalCodes() {
  console.log('📋 Migrating national codes...');
  try {
    const conn = await mysqlPool.getConnection();

    const [codes] = await conn.query('SELECT * FROM national_codes');
    if (codes.length > 0) {
      const { error } = await supabase
        .from('national_codes')
        .insert(codes, { returning: 'minimal' });
      if (error) throw error;
      console.log(`  ✓ ${codes.length} national codes`);
    }

    conn.release();
    console.log('✅ National codes migrated');
  } catch (err) {
    console.error('❌ National code migration failed:', err.message);
    throw err;
  }
}

async function migrateMappings() {
  console.log('🗺️ Migrating mappings...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM mappings');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No mappings to migrate');
      return;
    }

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const { error } = await supabase
        .from('mappings')
        .insert(batch, { returning: 'minimal' });

      if (error) throw error;
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(rows.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${rows.length} mappings`);
  } catch (err) {
    console.error('❌ Mapping migration failed:', err.message);
    throw err;
  }
}

async function migrateAuditLogs() {
  console.log('📊 Migrating audit logs...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM audit_logs ORDER BY id');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No audit logs to migrate');
      return;
    }

    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const { error } = await supabase
        .from('audit_logs')
        .insert(batch, { returning: 'minimal' });

      if (error) throw error;
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(rows.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${rows.length} audit logs`);
  } catch (err) {
    console.error('❌ Audit log migration failed:', err.message);
    throw err;
  }
}

async function migrateReviews() {
  console.log('👁️ Migrating reviews...');
  try {
    const conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SELECT * FROM reviews');
    conn.release();

    if (rows.length === 0) {
      console.log('  ⊘ No reviews to migrate');
      return;
    }

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const { error } = await supabase
        .from('reviews')
        .insert(batch, { returning: 'minimal' });

      if (error) throw error;
      console.log(`  ✓ Batch ${Math.ceil((i + batchSize) / batchSize)}/${Math.ceil(rows.length / batchSize)}`);
    }

    console.log(`✅ Migrated ${rows.length} reviews`);
  } catch (err) {
    console.error('❌ Review migration failed:', err.message);
    throw err;
  }
}

async function runMigration() {
  console.log('\n🚀 Starting data migration from MySQL to Supabase...\n');

  try {
    const materialIds = await migrateMaterials();
    await migrateEmbeddings(materialIds);
    await migrateMatches();
    await migrateClusters();
    await migrateNationalCodes();
    await migrateMappings();
    await migrateAuditLogs();
    await migrateReviews();

    console.log('\n✅ Migration complete!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await mysqlPool.end();
  }
}

runMigration();
