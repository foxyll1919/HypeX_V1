const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Now uses Supabase client
const mlClient = require('../services/mlClient');
const erpMock = require('../services/erpMock');

const helpers = require('../utils/supabase-helpers');

// In-memory job store for upload progress tracking
const uploadJobs = new Map();

// Helper to log audit trail (now uses helpers)
async function logAudit(username, action, materialId, decision, comment) {
  await helpers.logAudit(username, action, materialId, decision, comment);
}

// Generate a simple job ID
function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Initialize upload job
function createUploadJob(materials, cpseName) {
  const jobId = generateJobId();
  const job = {
    jobId,
    status: 'pending',
    totalRows: materials.length,
    processed: 0,
    inserted: 0,
    duplicates: 0,
    failed: 0,
    errors: [],
    startTime: Date.now(),
    cpseName,
    materials,
    batchSize: 20
  };
  uploadJobs.set(jobId, job);
  return jobId;
}

// Get job status
function getJobStatus(jobId) {
  return uploadJobs.get(jobId);
}

// Update job progress
function updateJobProgress(jobId, updates) {
  const job = uploadJobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    if (job.status === 'completed' || job.status === 'failed') {
      job.endTime = Date.now();
    }
  }
}

// Clean up old jobs (older than 1 hour)
function cleanupOldJobs() {
  const now = Date.now();
  for (const [jobId, job] of uploadJobs.entries()) {
    if (job.endTime && now - job.endTime > 3600000) {
      uploadJobs.delete(jobId);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupOldJobs, 600000);

// 1. GET all materials (with search & filtering) - SUPABASE VERSION
router.get('/materials', async (req, res) => {
  try {
    const { search, cpse, status, nationalCode } = req.query;

    if (search) {
      // Use search helper
      const rows = await helpers.searchMaterials(search);
      // Apply additional filters
      let filtered = rows;
      if (cpse) filtered = filtered.filter(r => r.cpse_name === cpse);
      if (status) filtered = filtered.filter(r => r.match_status === status);
      if (nationalCode) filtered = filtered.filter(r => r.national_code === nationalCode);
      return res.json(filtered);
    }

    // Build where clause for direct query
    const where = {};
    if (cpse) where.cpse_name = cpse;
    if (status) where.match_status = status;
    if (nationalCode) where.national_code = nationalCode;

    const rows = await helpers.selectAll('materials', where);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET material by ID - SUPABASE VERSION
router.get('/materials/:id', async (req, res) => {
  try {
    const row = await helpers.selectOne('materials', { id: parseInt(req.params.id) });
    if (!row) return res.status(404).json({ error: 'Material not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST new material (manually entered) - SUPABASE VERSION
router.post('/materials', async (req, res) => {
  try {
    const mat = req.body;
    if (!mat.cpse_name || !mat.original_code || !mat.description) {
      return res.status(400).json({ error: 'CPSE Name, Original Code, and Description are required' });
    }

    // Call ML service to normalize and extract attributes
    let normalized = mat.description.toLowerCase();
    let extracted = {};
    try {
      const normRes = await mlClient.normalize(mat.description);
      normalized = normRes.normalized_description;
      extracted = await mlClient.extract(mat.description);
    } catch (e) {
      console.warn('ML Service unavailable during manual save, using fallbacks:', e.message);
    }

    // Embed representation
    let embedding = [];
    try {
      const embRes = await mlClient.embed(normalized);
      embedding = embRes.embedding;
    } catch (e) {
      console.warn('Embedding generation skipped.');
    }

    // Prepare material data for insertion
    const materialData = {
      cpse_name: mat.cpse_name,
      original_code: mat.original_code,
      sap_code: mat.sap_code || null,
      description: mat.description,
      material_known_as: mat.material_known_as || null,
      unit: mat.unit || null,
      specifications: mat.specifications || null,
      technical_parameters: mat.technical_parameters || null,
      material_type: mat.material_type || extracted.product_type || null,
      material_grade: mat.material_grade || extracted.material_grade || null,
      dimension: mat.dimension || extracted.dimension || null,
      dimension_unit: mat.dimension_unit || extracted.dimension_unit || null,
      length: mat.length || extracted.length || null,
      length_unit: mat.length_unit || extracted.length_unit || null,
      pressure: mat.pressure || extracted.pressure || null,
      pressure_unit: mat.pressure_unit || extracted.pressure_unit || null,
      standard_reference: mat.standard_reference || extracted.standard_reference || null,
      unit_of_measurement: mat.unit_of_measurement || null,
      classification: mat.classification || 'Unclassified',
      normalized_description: normalized,
      match_status: 'PENDING',
      thread_size: extracted.thread_size || null,
      thread_length: extracted.thread_length || null,
      thread_length_unit: extracted.thread_length_unit || null
    };

    // Insert material
    const result = await helpers.insert('materials', materialData);

    // Save embedding if available
    if (embedding && embedding.length > 0) {
      await helpers.upsertEmbedding(result.id, embedding);
    }

    await logAudit('system', 'Material Uploaded', result.id, 'PENDING', `Manually created material ${mat.original_code}`);
    res.json({ id: result.id, message: 'Material created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT update material - SUPABASE VERSION
router.put('/materials/:id', async (req, res) => {
  try {
    const mat = req.body;
    const updateData = {
      cpse_name: mat.cpse_name,
      original_code: mat.original_code,
      sap_code: mat.sap_code,
      description: mat.description,
      material_known_as: mat.material_known_as,
      unit: mat.unit,
      specifications: mat.specifications,
      technical_parameters: mat.technical_parameters,
      material_type: mat.material_type,
      material_grade: mat.material_grade,
      dimension: mat.dimension,
      dimension_unit: mat.dimension_unit,
      length: mat.length,
      length_unit: mat.length_unit,
      pressure: mat.pressure,
      pressure_unit: mat.pressure_unit,
      standard_reference: mat.standard_reference,
      unit_of_measurement: mat.unit_of_measurement,
      classification: mat.classification,
      match_status: mat.match_status,
      thread_size: mat.thread_size,
      thread_length: mat.thread_length,
      thread_length_unit: mat.thread_length_unit,
      updated_at: new Date().toISOString()
    };

    await helpers.update('materials', { id: parseInt(req.params.id) }, updateData);
    await logAudit('system', 'Mapping Modified', req.params.id, mat.match_status, 'Updated material attributes');
    res.json({ message: 'Material updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. POST upload batch (CSV / JSON) - SUPABASE VERSION
router.post('/upload', async (req, res) => {
  try {
    const { materials } = req.body;
    if (!materials || !Array.isArray(materials)) {
      return res.status(400).json({ error: 'Invalid materials upload payload' });
    }

    const insertedIds = [];
    for (const mat of materials) {
      // Basic validation - require cpse_name, original_code, description
      if (!mat.cpse_name || !mat.original_code || !mat.description) continue;

      const materialData = {
        cpse_name: mat.cpse_name,
        original_code: mat.original_code,
        sap_code: mat.sap_code || null,
        description: mat.description,
        material_known_as: mat.material_known_as || null,
        unit: mat.unit || null,
        specifications: mat.specifications || null,
        technical_parameters: mat.technical_parameters || null,
        material_type: mat.material_type || null,
        material_grade: mat.material_grade || null,
        dimension: mat.dimension || null,
        dimension_unit: mat.dimension_unit || null,
        length: mat.length || null,
        length_unit: mat.length_unit || null,
        standard_reference: mat.standard_reference || null,
        unit_of_measurement: mat.unit_of_measurement || null,
        classification: mat.classification || 'Unclassified',
        match_status: 'PENDING',
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      };

      const result = await helpers.insert('materials', materialData);
      insertedIds.push(result.id);
      await logAudit('system', 'Material Uploaded', result.id, 'PENDING', `Batch imported SIS code ${mat.original_code}`);
    }

    res.json({ success: true, count: insertedIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note: 5b and 5c endpoints use in-memory job store and don't need Supabase updates

// 6. RUN AI matching pipeline - SUPABASE VERSION
router.post('/match', async (req, res) => {
  try {
    // 1. Fetch all materials
    const materials = await helpers.selectAll('materials');
    if (materials.length === 0) {
      return res.json({ message: 'No materials loaded. Insert some or load the demo dataset first.' });
    }

    // 2. Build pipeline input with embeddings
    const pipelineInput = [];
    for (const m of materials) {
      const embedding = await helpers.getEmbedding(m.id);
      pipelineInput.push({
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
        thread_size: m.thread_size,
        thread_length: m.thread_length,
        thread_length_unit: m.thread_length_unit,
        embedding: embedding
      });
    }

    // 3. Call FastAPI pipeline run
    const pipelineRes = await mlClient.runPipeline(pipelineInput);

    // 4. Update local DB materials with normalized text & extracted features
    for (const pm of pipelineRes.processed_materials) {
      const updateData = {
        normalized_description: pm.normalized_description,
        material_type: pm.material_type,
        material_grade: pm.material_grade,
        dimension: pm.dimension,
        dimension_unit: pm.dimension_unit,
        length: pm.length,
        length_unit: pm.length_unit,
        pressure: pm.pressure,
        pressure_unit: pm.pressure_unit,
        standard_reference: pm.standard_reference,
        thread_size: pm.thread_size,
        thread_length: pm.thread_length,
        thread_length_unit: pm.thread_length_unit,
        updated_at: new Date().toISOString()
      };

      await helpers.update('materials', { id: pm.id }, updateData);

      // Save embeddings
      if (pm.embedding) {
        await helpers.upsertEmbedding(pm.id, pm.embedding);
      }
    }

    // 5. Store detected matches in table (delete old pending matches)
    await helpers.deleteRows('matches', { status: 'PENDING' });

    let matchesCount = 0;
    for (const match of pipelineRes.matches) {
      // Verify match doesn't exist under active review
      const exists = await helpers.matchExists(match.material_a_id, match.material_b_id, true);
      if (exists) continue;

      const matchData = {
        material_a_id: match.material_a_id,
        material_b_id: match.material_b_id,
        semantic_score: match.semantic_score,
        technical_score: match.technical_score,
        final_score: match.final_score,
        result: match.result,
        reason: match.reason,
        comparison: match.comparison,
        status: 'PENDING'
      };

      await helpers.insert('matches', matchData);
      matchesCount++;
    }

    // Audit trace
    await logAudit('system', 'Normalize', null, 'SUCCESS', 'Executed text cleanup and attribute extraction.');
    await logAudit('system', 'Match', null, 'SUCCESS', `Run matching comparison pipeline. Generated ${matchesCount} candidates.`);

    res.json({
      message: 'AI Matching completed successfully.',
      processedCount: pipelineRes.processed_materials.length,
      matchesFound: matchesCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. GET matching candidates - SUPABASE VERSION
router.get('/matches', async (req, res) => {
  try {
    const matches = await helpers.getMatchesWithDetails();
    res.json(matches);
  } catch (err) {
    console.error('Error fetching matches:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. POST approve match - SUPABASE VERSION
router.post('/matches/:id/approve', async (req, res) => {
  try {
    const { comment, reviewer } = req.body;
    const matchId = parseInt(req.params.id);

    // Update match status
    await helpers.update('matches', { id: matchId }, {
      status: 'APPROVED',
      reviewer_comment: comment || null,
      reviewed_by: reviewer || 'system',
      reviewed_at: new Date().toISOString()
    });

    await logAudit(reviewer || 'system', 'Approve', matchId, 'APPROVED', comment || 'Match approved');
    res.json({ message: 'Match approved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. POST reject match - SUPABASE VERSION
router.post('/matches/:id/reject', async (req, res) => {
  try {
    const { comment, reviewer } = req.body;
    const matchId = parseInt(req.params.id);

    // Update match status
    await helpers.update('matches', { id: matchId }, {
      status: 'REJECTED',
      reviewer_comment: comment || null,
      reviewed_by: reviewer || 'system',
      reviewed_at: new Date().toISOString()
    });

    await logAudit(reviewer || 'system', 'Reject', matchId, 'REJECTED', comment || 'Match rejected');
    res.json({ message: 'Match rejected successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
