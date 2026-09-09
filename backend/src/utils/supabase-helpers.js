// Supabase Helper Functions for HypeX
// Replaces MySQL-specific query patterns with Supabase equivalents

const db = require('../config/db');

/**
 * Helper functions to migrate from MySQL to Supabase query patterns
 */

// Helper: Convert MySQL prepared statement to Supabase query builder
async function queryHelper(action, table, where = {}, data = null) {
  try {
    let query = db.from(table);

    // Apply where conditions (if any)
    if (Object.keys(where).length > 0) {
      query = query.match(where);
    }

    // Execute action
    let result;
    switch (action) {
      case 'select':
        if (where.id) {
          query = query.select().eq('id', where.id).single();
        } else {
          query = query.select();
        }
        result = await query;
        break;
      case 'insert':
        result = await query.insert([data]).select('*');
        break;
      case 'update':
        result = await query.update(data).select('*');
        break;
      case 'delete':
        result = await query.delete();
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    if (result.error) throw result.error;
    return result;
  } catch (err) {
    throw new Error(`Supabase ${action} error: ${err.message}`);
  }
}

// MySQL db.all() replacement
async function selectAll(table, where = {}) {
  const result = await queryHelper('select', table, where);
  return result.data || [];
}

// MySQL db.get() replacement (single row)
async function selectOne(table, where = {}) {
  const result = await queryHelper('select', table, where);
  return result.data || null;
}

// MySQL db.run() replacement for INSERT
async function insert(table, data) {
  const result = await queryHelper('insert', table, {}, data);
  return { id: result.data[0]?.id, changes: result.data?.length || 0 };
}

// MySQL db.run() replacement for UPDATE
async function update(table, where, data) {
  const result = await queryHelper('update', table, where, data);
  return { id: result.data[0]?.id, changes: result.data?.length || 0 };
}

// MySQL db.run() replacement for DELETE
async function deleteRows(table, where) {
  const result = await queryHelper('delete', table, where);
  return { changes: result.data?.length || 0 };
}

// Custom query builder for complex conditions
function buildWhereClause(filters) {
  const where = {};
  if (filters.id) where.id = filters.id;
  if (filters.cpse_name) where.cpse_name = filters.cpse_name;
  if (filters.original_code) where.original_code = filters.original_code;
  if (filters.match_status) where.match_status = filters.match_status;
  if (filters.national_code) where.national_code = filters.national_code;
  return where;
}

// Search with LIKE functionality (Supabase uses `ilike` for case-insensitive)
async function searchMaterials(searchTerm) {
  try {
    const { data, error } = await db
      .from('materials')
      .select('*')
      .or(`original_code.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%,specifications.ilike.%${searchTerm}%,classification.ilike.%${searchTerm}%`)
      .order('id', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    throw new Error(`Search error: ${err.message}`);
  }
}

// Vector similarity search using pgvector functions
async function matchMaterials(vector, threshold = 0.70, limit = 10) {
  try {
    const { data, error } = await db
      .rpc('match_materials', {
        query_embedding: vector,
        match_threshold: threshold,
        match_count: limit
      });

    if (error) throw error;
    return data || [];
  } catch (err) {
    throw new Error(`Vector search error: ${err.message}`);
  }
}

// Audit logging helper (modified for Supabase)
async function logAudit(username, action, materialId, decision, comment) {
  try {
    const { error } = await db
      .from('audit_logs')
      .insert([{
        username,
        action,
        material_id: materialId || null,
        decision: decision || null,
        comment: comment || null
      }]);

    if (error) throw error;
  } catch (err) {
    console.error('Audit logging failed:', err.message);
  }
}

// Embedding operations
async function getEmbedding(materialId) {
  try {
    const { data, error } = await db
      .from('material_embeddings')
      .select('embedding')
      .eq('material_id', materialId)
      .single();

    if (error) throw error;
    return data?.embedding || null;
  } catch (err) {
    console.error(`Error fetching embedding for material ${materialId}:`, err.message);
    return null;
  }
}

async function upsertEmbedding(materialId, embedding) {
  try {
    const { error } = await db
      .from('material_embeddings')
      .upsert({
        material_id: materialId,
        embedding: embedding
      }, {
        onConflict: 'material_id'
      });

    if (error) throw error;
  } catch (err) {
    throw new Error(`Embedding upsert error: ${err.message}`);
  }
}

// Fetch matches with join data
async function getMatchesWithDetails() {
  try {
    // Since Supabase doesn't support complex joins in a single query like MySQL,
    // we'll fetch matches first, then fetch materials separately
    const { data: matches, error: matchesError } = await db
      .from('matches')
      .select('*')
      .order('final_score', { ascending: false });

    if (matchesError) throw matchesError;

    if (!matches || matches.length === 0) return [];

    // Get unique material IDs
    const materialIds = [];
    matches.forEach(match => {
      materialIds.push(match.material_a_id, match.material_b_id);
    });

    // Fetch materials
    const { data: materials, error: materialsError } = await db
      .from('materials')
      .select('*')
      .in('id', [...new Set(materialIds)]);

    if (materialsError) throw materialsError;

    // Create materials lookup
    const materialsMap = {};
    materials.forEach(m => {
      materialsMap[m.id] = m;
    });

    // Combine data
    const enrichedMatches = matches.map(match => {
      const matA = materialsMap[match.material_a_id] || {};
      const matB = materialsMap[match.material_b_id] || {};

      return {
        ...match,
        original_code_a: matA.original_code,
        description_a: matA.description,
        cpse_name_a: matA.cpse_name,
        grade_a: matA.material_grade,
        dimension_a: matA.dimension,
        unit_a: matA.dimension_unit,
        length_a: matA.length,
        len_unit_a: matA.length_unit,
        original_code_b: matB.original_code,
        description_b: matB.description,
        cpse_name_b: matB.cpse_name,
        grade_b: matB.material_grade,
        dimension_b: matB.dimension,
        unit_b: matB.dimension_unit,
        length_b: matB.length,
        len_unit_b: matB.length_unit,
        comparison: match.comparison || {}
      };
    });

    return enrichedMatches;
  } catch (err) {
    throw new Error(`Matches fetch error: ${err.message}`);
  }
}

// Check if match exists (alternative implementation)
async function matchExists(materialAId, materialBId, excludePending = false) {
  try {
    let query = db
      .from('matches')
      .select('id')
      .or(`and(material_a_id.eq.${materialAId},material_b_id.eq.${materialBId}),and(material_a_id.eq.${materialBId},material_b_id.eq.${materialAId})`)
      .limit(1);

    if (excludePending) {
      query = query.neq('status', 'PENDING');
    }

    const { data, error } = await query;

    if (error) throw error;
    return data && data.length > 0;
  } catch (err) {
    console.error('Match exists check error:', err.message);
    return false;
  }
}

module.exports = {
  selectAll,
  selectOne,
  insert,
  update,
  deleteRows,
  buildWhereClause,
  searchMaterials,
  matchMaterials,
  logAudit,
  getEmbedding,
  upsertEmbedding,
  getMatchesWithDetails,
  matchExists
};
