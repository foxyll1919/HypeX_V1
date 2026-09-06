const express = require('express');
const router = express.Router();
const db = require('../config/db');
const mlClient = require('../services/mlClient');
const erpMock = require('../services/erpMock');

// In-memory job store for upload progress tracking
const uploadJobs = new Map();

// Helper to log audit trail
async function logAudit(username, action, materialId, decision, comment) {
  try {
    await db.run(
      `INSERT INTO audit_logs (username, action, material_id, decision, comment) 
       VALUES (?, ?, ?, ?, ?)`,
      [username, action, materialId, decision, comment]
    );
  } catch (err) {
    console.error('Audit logging failed:', err.message);
  }
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

// 1. GET all materials (with search & filtering)
router.get('/materials', async (req, res) => {
  try {
    const { search, cpse, status, nationalCode } = req.query;
    let sql = `SELECT * FROM materials WHERE 1=1`;
    const params = [];

    if (search) {
      sql += ` AND (original_code LIKE ? OR description LIKE ? OR specifications LIKE ? OR classification LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }
    if (cpse) {
      sql += ` AND cpse_name = ?`;
      params.push(cpse);
    }
    if (status) {
      sql += ` AND match_status = ?`;
      params.push(status);
    }
    if (nationalCode) {
      sql += ` AND national_code = ?`;
      params.push(nationalCode);
    }

    sql += ` ORDER BY id DESC`;
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET material by ID
router.get('/materials/:id', async (req, res) => {
  try {
    const row = await db.get(`SELECT * FROM materials WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Material not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST new material (manually entered)
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
    let embeddingStr = '[]';
    try {
      const embRes = await mlClient.embed(normalized);
      embeddingStr = JSON.stringify(embRes.embedding);
    } catch (e) {
      console.warn('Embedding generation skipped.');
    }

    const result = await db.run(
      `INSERT INTO materials (
        cpse_name, original_code, sap_code, description, material_known_as, unit,
        specifications, technical_parameters,
        material_type, material_grade, dimension, dimension_unit, length, length_unit,
        standard_reference, unit_of_measurement, classification,
        normalized_description, match_status,
        thread_size, thread_length, thread_length_unit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      [
        mat.cpse_name,
        mat.original_code,
        mat.sap_code || null,
        mat.description,
        mat.material_known_as || null,
        mat.unit || null,
        mat.specifications || null,
        mat.technical_parameters || null,
        mat.material_type || extracted.product_type,
        mat.material_grade || extracted.material_grade,
        mat.dimension || extracted.dimension,
        mat.dimension_unit || extracted.dimension_unit,
        mat.length || extracted.length,
        mat.length_unit || extracted.length_unit,
        mat.pressure || extracted.pressure,
        mat.pressure_unit || extracted.pressure_unit,
        mat.standard_reference || extracted.standard_reference,
        mat.unit_of_measurement,
        mat.classification || 'Unclassified',
        normalized,
        extracted.thread_size || null,
        extracted.thread_length || null,
        extracted.thread_length_unit || null
      ]
    );

    // Save embedding
    await db.run(
      `INSERT INTO material_embeddings (material_id, embedding) VALUES (?, ?) ON DUPLICATE KEY UPDATE embedding = VALUES(embedding)`,
      [result.id, embeddingStr]
    );

    await logAudit('system', 'Material Uploaded', result.id, 'PENDING', `Manually created material ${mat.original_code}`);
    res.json({ id: result.id, message: 'Material created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT update material
router.put('/materials/:id', async (req, res) => {
  try {
    const mat = req.body;
    await db.run(
      `UPDATE materials SET 
        cpse_name = ?, original_code = ?, sap_code = ?, description = ?, material_known_as = ?, unit = ?,
        specifications = ?, technical_parameters = ?, material_type = ?, material_grade = ?, 
        dimension = ?, dimension_unit = ?, length = ?, length_unit = ?, 
        pressure = ?, pressure_unit = ?, standard_reference = ?, 
        unit_of_measurement = ?, classification = ?, match_status = ?,
        thread_size = ?, thread_length = ?, thread_length_unit = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        mat.cpse_name, mat.original_code, mat.sap_code, mat.description, mat.material_known_as, mat.unit,
        mat.specifications, mat.technical_parameters, mat.material_type, mat.material_grade,
        mat.dimension, mat.dimension_unit, mat.length, mat.length_unit,
        mat.pressure, mat.pressure_unit, mat.standard_reference,
        mat.unit_of_measurement, mat.classification, mat.match_status,
        mat.thread_size, mat.thread_length, mat.thread_length_unit,
        req.params.id
      ]
    );
    await logAudit('system', 'Mapping Modified', req.params.id, mat.match_status, 'Updated material attributes');
    res.json({ message: 'Material updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. POST upload batch (CSV / JSON)
router.post('/upload', async (req, res) => {
  try {
    const { materials } = req.body;
    if (!materials || !Array.isArray(materials)) {
      return res.status(400).json({ error: 'Invalid materials upload payload' });
    }

    const insertedIds = [];
    for (const mat of materials) {
      // Basic validation - require cpse_name, original_code (SIS_Code), description
      if (!mat.cpse_name || !mat.original_code || !mat.description) continue;
      
      const result = await db.run(
        `INSERT INTO materials (
          cpse_name, original_code, sap_code, description, material_known_as, unit,
          specifications, technical_parameters,
          material_type, material_grade, dimension, dimension_unit, length, length_unit,
          standard_reference, unit_of_measurement, classification, match_status,
          thread_size, thread_length, thread_length_unit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          mat.cpse_name,
          mat.original_code, // SIS_Code
          mat.sap_code || null, // SAP_Code
          mat.description, // Material_Description
          mat.material_known_as || null, // Material_Known_As
          mat.unit || null, // Unit
          mat.specifications || null,
          mat.technical_parameters || null,
          mat.material_type || null,
          mat.material_grade || null,
          mat.dimension || null,
          mat.dimension_unit || null,
          mat.length || null,
          mat.length_unit || null,
          mat.standard_reference || null,
          mat.unit_of_measurement || null,
          mat.classification || 'Unclassified',
          null, // thread_size
          null, // thread_length
          null  // thread_length_unit
        ]
      );
      insertedIds.push(result.id);
      await logAudit('system', 'Material Uploaded', result.id, 'PENDING', `Batch imported SIS code ${mat.original_code}`);
    }

    res.json({ success: true, count: insertedIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. POST start upload job (initiates async import with progress tracking)
router.post('/upload/start', async (req, res) => {
  try {
    const { materials, cpseName } = req.body;
    if (!materials || !Array.isArray(materials)) {
      return res.status(400).json({ error: 'Invalid materials upload payload' });
    }
    if (!cpseName) {
      return res.status(400).json({ error: 'CPSE Name is required' });
    }

    // Validate all rows have required fields
    const validMaterials = [];
    const validationErrors = [];
    materials.forEach((mat, idx) => {
      if (!mat.cpse_name || !mat.original_code || !mat.description) {
        validationErrors.push(`Row ${idx + 1}: Missing required fields (cpse_name, original_code, description)`);
      } else {
        validMaterials.push(mat);
      }
    });

    if (validMaterials.length === 0) {
      return res.status(400).json({ error: 'No valid records to import', validationErrors });
    }

    // Create upload job
    const jobId = createUploadJob(validMaterials, cpseName);
    
    // Start async processing
    processUploadJob(jobId).catch(err => {
      console.error('Upload job processing error:', err);
      updateJobProgress(jobId, { status: 'failed', errors: [{ reason: err.message }] });
    });

    res.json({ 
      success: true, 
      jobId,
      totalRows: validMaterials.length,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. GET upload job status
router.get('/upload/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = getJobStatus(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Upload job not found' });
    }

    const percentage = job.totalRows > 0 ? Math.round((job.processed / job.totalRows) * 100) : 0;
    
    res.json({
      jobId: job.jobId,
      status: job.status,
      totalRows: job.totalRows,
      processed: job.processed,
      inserted: job.inserted,
      duplicates: job.duplicates,
      failed: job.failed,
      percentage,
      errors: job.errors,
      startTime: job.startTime,
      endTime: job.endTime,
      beforeCount: job.beforeCount,
      afterCount: job.afterCount,
      expected: job.expected,
      found: job.found,
      verified: job.verified
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. RUN AI matching pipeline
router.post('/match', async (req, res) => {
  try {
    // 1. Fetch all materials
    const materials = await db.all(`SELECT * FROM materials`);
    if (materials.length === 0) {
      return res.json({ message: 'No materials loaded. Insert some or load the demo dataset first.' });
    }

    // 2. Fetch embeddings if they exist
    const embeddingsRows = await db.all(`SELECT * FROM material_embeddings`);
    const embeddingMap = {};
    embeddingsRows.forEach(r => {
      try {
        embeddingMap[r.material_id] = JSON.parse(r.embedding);
      } catch(e) {}
    });

    const pipelineInput = materials.map(m => ({
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
      embedding: embeddingMap[m.id]
    }));

    // 3. Call FastAPI pipeline run
    const pipelineRes = await mlClient.runPipeline(pipelineInput);
    
    // 4. Update local DB materials with normalized text & extracted features
    for (const pm of pipelineRes.processed_materials) {
      await db.run(
        `UPDATE materials SET 
          normalized_description = ?,
          material_type = ?,
          material_grade = ?,
          dimension = ?,
          dimension_unit = ?,
          length = ?,
          length_unit = ?,
          pressure = ?,
          pressure_unit = ?,
          standard_reference = ?,
          thread_size = ?,
          thread_length = ?,
          thread_length_unit = ?
         WHERE id = ?`,
        [
          pm.normalized_description, pm.material_type, pm.material_grade, pm.dimension,
          pm.dimension_unit, pm.length, pm.length_unit, pm.pressure, pm.pressure_unit,
          pm.standard_reference, pm.thread_size, pm.thread_length, pm.thread_length_unit, pm.id
        ]
      );

      // Save embeddings
      if (pm.embedding) {
        await db.run(
          `INSERT INTO material_embeddings (material_id, embedding) VALUES (?, ?) ON DUPLICATE KEY UPDATE embedding = VALUES(embedding)`,
          [pm.id, JSON.stringify(pm.embedding)]
        );
      }
    }

    // 5. Store detected matches in table (delete old pending matches to prevent duplicates)
    await db.run(`DELETE FROM matches WHERE status = 'PENDING'`);
    
    let matchesCount = 0;
    for (const match of pipelineRes.matches) {
      // Verify match doesn't exist under active review
      const existing = await db.get(
        `SELECT id FROM matches 
         WHERE ((material_a_id = ? AND material_b_id = ?) OR (material_a_id = ? AND material_b_id = ?))
         AND status != 'PENDING'`,
        [match.material_a_id, match.material_b_id, match.material_b_id, match.material_a_id]
      );
      if (existing) continue;

      await db.run(
        `INSERT INTO matches (
          material_a_id, material_b_id, semantic_score, technical_score, 
          final_score, result, reason, comparison, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          match.material_a_id, match.material_b_id, match.semantic_score,
          match.technical_score, match.final_score, match.result, match.reason,
          JSON.stringify(match.comparison)
        ]
      );
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

// 7. GET matching candidates
router.get('/matches', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT m.*,
              ma.original_code as original_code_a, ma.description as description_a, ma.cpse_name as cpse_name_a, ma.material_grade as grade_a, ma.dimension as dimension_a, ma.dimension_unit as unit_a, ma.length as length_a, ma.length_unit as len_unit_a,
              mb.original_code as original_code_b, mb.description as description_b, mb.cpse_name as cpse_name_b, mb.material_grade as grade_b, mb.dimension as dimension_b, mb.dimension_unit as unit_b, mb.length as length_b, mb.length_unit as len_unit_b
       FROM matches m
       JOIN materials ma ON m.material_a_id = ma.id
       JOIN materials mb ON m.material_b_id = mb.id
       ORDER BY m.final_score DESC`
    );
    // Parse JSON arrays for display
    const parsed = rows.map(r => {
      let comparison = {};
      if (r.comparison) {
        try {
          comparison = JSON.parse(r.comparison);
        } catch (parseErr) {
          console.error(`Failed to parse comparison for match ${r.id}:`, r.comparison);
          comparison = { error: 'Invalid JSON in database', raw: r.comparison };
        }
      }
      return {
        ...r,
        comparison
      };
    });
    res.json(parsed);
  } catch (err) {
    console.error('Error fetching matches:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to re-evaluate clusters using Disjoint-Set union-find
async function updateClustersAndNationalCodes() {
  // 1. Gathers all active material IDs
  const mats = await db.all(`SELECT * FROM materials`);
  const materialIds = mats.map(m => m.id);
  
  // 2. Gathers approved match edges
  const approvedMatches = await db.all(`SELECT material_a_id, material_b_id FROM matches WHERE status = 'APPROVED'`);
  const edges = approvedMatches.map(e => [e.material_a_id, e.material_b_id]);
  
  // 3. Cluster using Python Union-Find Service
  let clusterGroups = [];
  try {
    const clusterRes = await mlClient.cluster(materialIds, edges);
    clusterGroups = clusterRes.clusters;
  } catch (err) {
    console.error('FastAPI clustering failed, running JS fallback:', err.message);
    // JS Disjoint-set fallback
    const parent = {};
    const find = (i) => {
      if (parent[i] === undefined) parent[i] = i;
      let curr = i;
      while (parent[curr] !== curr) curr = parent[curr];
      return curr;
    };
    const union = (i, j) => {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootI] = rootJ;
    };
    materialIds.forEach(id => find(id));
    edges.forEach(e => union(e[0], e[1]));
    
    const groups = {};
    materialIds.forEach(id => {
      const r = find(id);
      if (!groups[r]) groups[r] = [];
      groups[r].push(id);
    });
    clusterGroups = Object.values(groups);
  }

  // Build materials map for NMC generation
  const materialsMap = {};
  for (const m of mats) {
    materialsMap[m.id] = m;
  }

  // 4. Generate NMCs using ML service
  let nmcAssignments = [];
  try {
    const nmcRes = await mlClient.generateNMC(clusterGroups, materialsMap, 'NMC');
    nmcAssignments = nmcRes.nmc_assignments;
  } catch (err) {
    console.error('FastAPI NMC generation failed, using JS fallback:', err.message);
    // Fallback to existing logic
    nmcAssignments = generateNMCFallback(clusterGroups, materialsMap);
  }

  // 5. Update SQL clusters, national_codes, mappings, and material codes
  await db.run(`DELETE FROM cluster_members`);
  await db.run(`DELETE FROM mappings`);
  await db.run(`DELETE FROM clusters`);
  await db.run(`DELETE FROM national_codes`);
  
  await db.run(`UPDATE materials SET national_code = NULL, match_status = 'PENDING' WHERE match_status = 'APPROVED'`);

  for (const assignment of nmcAssignments) {
    if (!assignment.national_code || assignment.status === 'CONFLICT') {
      // Log conflicts but don't assign NMC
      console.warn(`Cluster conflict detected for materials ${assignment.cluster_ids}:`, assignment.conflicts);
      // Still create materials as unclustered or with special status
      for (const mid of assignment.cluster_ids) {
        await db.run(
          `UPDATE materials SET match_status = 'REVIEW' WHERE id = ?`,
          [mid]
        );
      }
      continue;
    }

    const clusterId = `CL-${assignment.national_code.replace('NMC-', '').padStart(5, '0')}`;
    const nationalCode = assignment.national_code;
    const stdDesc = assignment.canonical_description;

    // Determine category from first material
    const firstMat = materialsMap[assignment.cluster_ids[0]];
    const category = firstMat?.material_type ? 
      (firstMat.material_type.endsWith('e') ? firstMat.material_type + 's' : firstMat.material_type + 'es') : 'General';
    const cleanCategory = category.charAt(0).toUpperCase() + category.slice(1);

    // Save National Code
    await db.run(
      `INSERT INTO national_codes (code, standard_description, category, specifications) 
       VALUES (?, ?, ?, ?)`,
      [nationalCode, stdDesc, cleanCategory, firstMat?.specifications || '']
    );

    // Save Cluster
    await db.run(
      `INSERT INTO clusters (id, national_code, standardized_description, category, confidence) 
       VALUES (?, ?, ?, ?, ?)`,
      [clusterId, nationalCode, stdDesc, cleanCategory, 0.95]
    );

    // Link members
    for (const mid of assignment.cluster_ids) {
      const m = materialsMap[mid];
      if (!m) continue;
      
      await db.run(
        `INSERT INTO cluster_members (cluster_id, material_id) VALUES (?, ?)`,
        [clusterId, mid]
      );
      
      const matchStatus = assignment.cluster_ids.length > 1 ? 'APPROVED' : 'PENDING';
      
      await db.run(
        `UPDATE materials SET national_code = ?, match_status = ? WHERE id = ?`,
        [nationalCode, matchStatus, mid]
      );

      await db.run(
        `INSERT INTO mappings (national_code, cpse_name, original_code, material_id) 
         VALUES (?, ?, ?, ?)`,
        [nationalCode, m.cpse_name, m.original_code, mid]
      );
    }
  }
  console.log(`Re-clustered into ${nmcAssignments.filter(a => a.national_code).length} Master Codes.`);
}

function generateNMCFallback(clusterGroups, materialsMap) {
  // Fallback NMC generation (original logic)
  const assignments = [];
  let index = 1;
  for (const group of clusterGroups) {
    if (group.length === 0) continue;
    
    group.sort((a,b) => a - b);
    const membersData = group.map(mid => materialsMap[mid]).filter(Boolean);
    if (membersData.length === 0) continue;

    let representative = membersData[0];
    for (const m of membersData) {
      if (m.material_grade && m.dimension) {
        representative = m;
        break;
      }
    }

    let stdDesc = representative.description;
    if (representative.material_type) {
      const matName = representative.material_type.charAt(0).toUpperCase() + representative.material_type.slice(1);
      const gradePart = representative.material_grade ? `, Grade ${representative.material_grade}` : '';
      const dimPart = representative.dimension ? `, ${representative.dimension} ${representative.dimension_unit || ''}` : '';
      stdDesc = `${matName}${dimPart}${gradePart}`;
    }

    const nationalCode = `NMC-${String(index).padStart(6, '0')}`;
    
    assignments.push({
      cluster_ids: group,
      national_code: nationalCode,
      canonical_description: stdDesc,
      status: 'ASSIGNED',
      conflicts: [],
      materials: membersData
    });

    index++;
  }
  return assignments;
}

// Process upload job asynchronously with batch processing and progress updates
async function processUploadJob(jobId) {
  const job = getJobStatus(jobId);
  if (!job) return;

  try {
    updateJobProgress(jobId, { status: 'importing' });
    
    // Get current database count before import
    const countResult = await db.get(`SELECT COUNT(*) as count FROM materials`);
    const beforeCount = countResult.count;

    const materials = job.materials;
    const batchSize = job.batchSize;
    const totalRows = materials.length;

    // Process in batches
    for (let i = 0; i < totalRows; i += batchSize) {
      const batch = materials.slice(i, i + batchSize);
      let batchInserted = 0;
      let batchDuplicates = 0;
      let batchFailed = 0;

      // Use transaction for batch
      const conn = await db.pool.getConnection();
      try {
        await conn.beginTransaction();

        for (const mat of batch) {
          try {
            // Check for duplicate based on CPSE + original_code
            const existing = await conn.execute(
              `SELECT id FROM materials WHERE cpse_name = ? AND original_code = ?`,
              [mat.cpse_name, mat.original_code]
            );
            
            if (existing[0].length > 0) {
              batchDuplicates++;
              job.errors.push({
                row: i + batch.indexOf(mat) + 1,
                originalCode: mat.original_code,
                status: 'DUPLICATE',
                reason: `Record with CPSE '${mat.cpse_name}' and SIS_Code '${mat.original_code}' already exists`
              });
              continue;
            }

            // Insert new record
            const result = await conn.execute(
              `INSERT INTO materials (
                cpse_name, original_code, sap_code, description, material_known_as, unit,
                specifications, technical_parameters,
                material_type, material_grade, dimension, dimension_unit, length, length_unit,
                standard_reference, unit_of_measurement, classification, match_status,
                thread_size, thread_length, thread_length_unit
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
              [
                mat.cpse_name,
                mat.original_code,
                mat.sap_code || null,
                mat.description,
                mat.material_known_as || null,
                mat.unit || null,
                mat.specifications || null,
                mat.technical_parameters || null,
                mat.material_type || null,
                mat.material_grade || null,
                mat.dimension || null,
                mat.dimension_unit || null,
                mat.length || null,
                mat.length_unit || null,
                mat.standard_reference || null,
                mat.unit_of_measurement || null,
                mat.classification || 'Unclassified',
                null, // thread_size
                null, // thread_length
                null  // thread_length_unit
              ]
            );

            const materialId = result[0].insertId;
            batchInserted++;
            
            // Log audit
            await conn.execute(
              `INSERT INTO audit_logs (username, action, material_id, decision, comment) 
               VALUES (?, ?, ?, ?, ?)`,
              ['system', 'Material Uploaded', materialId, 'PENDING', `Batch imported SIS code ${mat.original_code}`]
            );

          } catch (err) {
            batchFailed++;
            job.errors.push({
              row: i + batch.indexOf(mat) + 1,
              originalCode: mat.original_code,
              status: 'FAILED',
              reason: err.message
            });
            console.error('Failed to insert material:', err.message);
          }
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        batchFailed = batch.length;
        batchInserted = 0;
        batchDuplicates = 0;
        batch.forEach((mat, idx) => {
          job.errors.push({
            row: i + idx + 1,
            originalCode: mat.original_code,
            status: 'FAILED',
            reason: `Transaction failed: ${err.message}`
          });
        });
        console.error('Batch transaction failed:', err.message);
      } finally {
        conn.release();
      }

      job.inserted += batchInserted;
      job.duplicates += batchDuplicates;
      job.failed += batchFailed;
      job.processed = Math.min(i + batchSize, totalRows);

      updateJobProgress(jobId, { 
        processed: job.processed,
        inserted: job.inserted,
        duplicates: job.duplicates,
        failed: job.failed,
        errors: job.errors
      });

      // Small delay to allow progress updates to be visible
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Database verification - confirm records exist
    updateJobProgress(jobId, { status: 'verifying' });
    
    const verifyResult = await db.get(`SELECT COUNT(*) as count FROM materials`);
    const afterCount = verifyResult.count;
    const expectedAfter = beforeCount + job.inserted;
    const verified = afterCount >= expectedAfter;
    
    // Determine final status based on results
    let finalStatus = 'completed';
    if (job.failed > 0 && job.inserted === 0) {
      finalStatus = 'failed';
    } else if (job.failed > 0 && job.inserted > 0) {
      finalStatus = 'partial';
    }
    
    updateJobProgress(jobId, { 
      status: finalStatus,
      processed: totalRows,
      percentage: 100,
      beforeCount,
      afterCount,
      expected: expectedAfter,
      found: afterCount,
      verified
    });
    
    const auditDecision = job.failed === 0 ? 'SUCCESS' : (job.inserted > 0 ? 'PARTIAL' : 'FAILED');
    await logAudit('system', 'CSV_IMPORT', null, auditDecision, 
      `CSV import completed: ${job.inserted} inserted, ${job.duplicates} duplicates, ${job.failed} failed`);

  } catch (err) {
    console.error('Upload job failed:', err);
    updateJobProgress(jobId, { 
      status: 'failed', 
      errors: [...job.errors, { reason: err.message }],
      endTime: Date.now()
    });
  }
}

// 8. APPROVE a candidate match
router.post('/matches/:id/approve', async (req, res) => {
  try {
    const { comment, reviewer } = req.body;
    const matchId = req.params.id;

    // Fetch match
    const match = await db.get(`SELECT * FROM matches WHERE id = ?`, [matchId]);
    if (!match) return res.status(404).json({ error: 'Match candidate not found' });

    // Update match table
    await db.run(
      `UPDATE matches SET status = 'APPROVED', reviewer_comment = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [comment || 'Approved by reviewer', reviewer || 'Reviewer', matchId]
    );

    // Save to reviews table
    await db.run(
      `INSERT INTO reviews (match_id, reviewer, decision, comment) VALUES (?, ?, 'APPROVE', ?)`,
      [matchId, reviewer || 'Reviewer', comment || 'Approved by reviewer']
    );

    // Recompute Union-Find Clusters
    await updateClustersAndNationalCodes();

    // Audit log
    await logAudit(reviewer || 'Reviewer', 'Approve', match.material_a_id, 'APPROVED', `Approved match with Material ID ${match.material_b_id}. Comment: ${comment || 'N/A'}`);

    res.json({ success: true, message: 'Match approved and database clusters synchronized.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. REJECT a candidate match
router.post('/matches/:id/reject', async (req, res) => {
  try {
    const { comment, reviewer } = req.body;
    const matchId = req.params.id;

    const match = await db.get(`SELECT * FROM matches WHERE id = ?`, [matchId]);
    if (!match) return res.status(404).json({ error: 'Match candidate not found' });

    // Update match table
    await db.run(
      `UPDATE matches SET status = 'REJECTED', reviewer_comment = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [comment || 'Rejected by reviewer', reviewer || 'Reviewer', matchId]
    );

    // Save to reviews
    await db.run(
      `INSERT INTO reviews (match_id, reviewer, decision, comment) VALUES (?, ?, 'REJECT', ?)`,
      [matchId, reviewer || 'Reviewer', comment || 'Rejected by reviewer']
    );

    // Recompute clusters (since the rejected link is removed)
    await updateClustersAndNationalCodes();

    // Audit log
    await logAudit(reviewer || 'Reviewer', 'Reject', match.material_a_id, 'REJECTED', `Rejected match with Material ID ${match.material_b_id}. Reason: ${comment || 'N/A'}`);

    res.json({ success: true, message: 'Match rejected. Cluster split rules executed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. GET Clusters
router.get('/clusters', async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM clusters`);
    
    // For each cluster, fetch count of distinct CPSEs and original codes
    const enriched = [];
    for (const row of rows) {
      const members = await db.all(
        `SELECT m.* FROM cluster_members cm
         JOIN materials m ON cm.material_id = m.id
         WHERE cm.cluster_id = ?`,
        [row.id]
      );
      
      const cpseSet = new Set(members.map(m => m.cpse_name));
      enriched.push({
        ...row,
        cpse_count: cpseSet.size,
        original_codes_count: members.length,
        members
      });
    }
    
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. GET Cluster Details by ID
router.get('/clusters/:id', async (req, res) => {
  try {
    const cluster = await db.get(`SELECT * FROM clusters WHERE id = ?`, [req.params.id]);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

    const members = await db.all(
      `SELECT m.* FROM cluster_members cm
       JOIN materials m ON cm.material_id = m.id
       WHERE cm.cluster_id = ?`,
      [cluster.id]
    );

    // Fetch review history for these materials
    const materialIds = members.map(m => m.id);
    let history = [];
    if (materialIds.length > 0) {
      const placeholders = materialIds.map(() => '?').join(',');
      history = await db.all(
        `SELECT m.*, ma.original_code as code_a, mb.original_code as code_b 
         FROM matches m
         JOIN materials ma ON m.material_a_id = ma.id
         JOIN materials mb ON m.material_b_id = mb.id
         WHERE (material_a_id IN (${placeholders}) OR material_b_id IN (${placeholders}))
         AND m.status != 'PENDING'`,
        [...materialIds, ...materialIds]
      );
    }

    res.json({
      cluster,
      members,
      history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. GET National Codes
router.get('/national-codes', async (req, res) => {
  try {
    const codes = await db.all(`SELECT * FROM national_codes`);
    
    // Add enriched stats
    const enriched = [];
    for (const c of codes) {
      const maps = await db.all(`SELECT * FROM mappings WHERE national_code = ?`, [c.code]);
      const cpses = [...new Set(maps.map(m => m.cpse_name))];
      enriched.push({
        ...c,
        source_cpse_count: cpses.length,
        original_codes_count: maps.length,
        cpses: cpses.join(', '),
        original_codes: maps.map(m => m.original_code).join(', ')
      });
    }
    
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. GET Traceability Mappings
router.get('/mappings', async (req, res) => {
  try {
    const { national_code } = req.query;
    let sql = `SELECT m.*, mat.description as original_description, mat.match_status,
               mat.normalized_description, mat.material_type, mat.material_grade,
               mat.dimension, mat.dimension_unit, mat.length, mat.length_unit,
               mat.pressure, mat.pressure_unit, mat.standard_reference,
               mat.unit_of_measurement, mat.classification, mat.national_code,
               mat.thread_size, mat.thread_length, mat.thread_length_unit,
               c.standard_description as canonical_description, c.category,
               cl.id as cluster_id
        FROM mappings m
        JOIN materials mat ON m.material_id = mat.id
        JOIN national_codes c ON m.national_code = c.code
        LEFT JOIN cluster_members cl ON cl.material_id = mat.id`;
    const params = [];
    
    if (national_code) {
      sql += ` WHERE m.national_code = ?`;
      params.push(national_code);
    }
    
    sql += ` ORDER BY m.national_code, m.cpse_name`;
    
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. GET Dashboard / Analytics
router.get('/analytics', async (req, res) => {
  try {
    // Total materials
    const tMats = await db.get(`SELECT COUNT(*) as count FROM materials`);
    
    // Pending review matches
    const pMatches = await db.get(`SELECT COUNT(*) as count FROM matches WHERE status = 'PENDING'`);
    
    // Standardized approved materials
    const sMats = await db.get(`SELECT COUNT(*) as count FROM materials WHERE match_status = 'APPROVED'`);
    
    // National codes count
    const nCodes = await db.get(`SELECT COUNT(*) as count FROM national_codes`);

    // Equivalent groups count (clusters)
    const eqGroups = await db.get(`SELECT COUNT(*) as count FROM clusters`);

    // Duplicate count (materials that share their national code with another material)
    const dupCount = await db.get(
      `SELECT COUNT(*) as count FROM materials 
       WHERE national_code IN (
         SELECT national_code FROM materials 
         WHERE national_code IS NOT NULL 
         GROUP BY national_code 
         HAVING COUNT(*) > 1
       )`
    );

    // Charts:
    // 1. Materials by CPSE
    const byCpse = await db.all(
      `SELECT cpse_name as name, COUNT(*) as value FROM materials GROUP BY cpse_name`
    );

    // 2. Duplicate materials count by CPSE
    const dupByCpse = await db.all(
      `SELECT cpse_name as name, COUNT(*) as value FROM materials 
       WHERE national_code IN (
         SELECT national_code FROM materials 
         WHERE national_code IS NOT NULL 
         GROUP BY national_code 
         HAVING COUNT(*) > 1
       )
       GROUP BY cpse_name`
    );

    // 3. Materials by category
    const byCategory = await db.all(
      `SELECT classification as name, COUNT(*) as value FROM materials GROUP BY classification`
    );

    // 4. Matching status
    const byStatus = await db.all(
      `SELECT match_status as name, COUNT(*) as value FROM materials GROUP BY match_status`
    );

    // 5. Audit approval rate
    const approvedCount = await db.get(`SELECT COUNT(*) as count FROM matches WHERE status = 'APPROVED'`);
    const rejectedCount = await db.get(`SELECT COUNT(*) as count FROM matches WHERE status = 'REJECTED'`);
    
    res.json({
      summary: {
        totalMaterials: tMats.count,
        duplicateMaterials: dupCount.count || 0,
        equivalentGroups: eqGroups.count,
        pendingReviews: pMatches.count,
        standardizedMaterials: sMats.count,
        nationalMaterialCodes: nCodes.count
      },
      charts: {
        materialsByCpse: byCpse,
        duplicatesByCpse: dupByCpse,
        materialsByCategory: byCategory.map(c => ({ name: c.name || 'Unclassified', value: c.value })),
        matchingStatus: byStatus.map(s => ({ name: s.name === 'APPROVED' ? 'Approved' : s.name === 'REVIEW' ? 'Needs Review' : s.name === 'REJECTED' ? 'Rejected' : 'Pending', value: s.value })),
        approvalRate: [
          { name: 'Approved', value: approvedCount.count || 0 },
          { name: 'Rejected', value: rejectedCount.count || 0 }
        ]
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. GET Audit Logs
router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await db.all(
      `SELECT l.*, m.original_code as material_code 
       FROM audit_logs l
       LEFT JOIN materials m ON l.material_id = m.id
       ORDER BY l.id DESC`
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. POST Generate National Material Codes
router.post('/national-codes/generate', async (req, res) => {
  try {
    // Trigger cluster recomputation and NMC generation
    await updateClustersAndNationalCodes();
    
    // Return updated national codes
    const codes = await db.all(`SELECT * FROM national_codes`);
    const enriched = [];
    for (const c of codes) {
      const maps = await db.all(`SELECT * FROM mappings WHERE national_code = ?`, [c.code]);
      const cpses = [...new Set(maps.map(m => m.cpse_name))];
      enriched.push({
        ...c,
        source_cpse_count: cpses.length,
        original_codes_count: maps.length,
        cpses: cpses.join(', '),
        original_codes: maps.map(m => m.original_code).join(', ')
      });
    }
    
    await logAudit('system', 'NMC Created', null, 'SUCCESS', `Generated ${enriched.length} National Material Codes`);
    res.json({ success: true, nationalCodes: enriched, count: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. GET Export National Material Master CSV
router.get('/national-codes/export', async (req, res) => {
  try {
    const mappings = await db.all(
      `SELECT m.*, mat.description as original_description, mat.normalized_description,
              mat.material_type, mat.material_grade, mat.dimension, mat.dimension_unit,
              mat.length, mat.length_unit, mat.pressure, mat.pressure_unit,
              mat.standard_reference, mat.unit_of_measurement, mat.classification,
              mat.match_status, mat.national_code,
              c.standard_description as canonical_description,
              c.category
       FROM mappings m
       JOIN materials mat ON m.material_id = mat.id
       JOIN national_codes c ON m.national_code = c.code
       ORDER BY m.national_code, m.cpse_name`
    );
    
    // Build CSV
    const headers = [
      'National_Material_Code',
      'SIS_Code',
      'SAP_Code',
      'Material_Description',
      'Material_Known_As',
      'Unit',
      'CPSE_Name',
      'Normalized_Description',
      'Canonical_Description',
      'Match_Result',
      'Confidence',
      'Cluster_ID',
      'Review_Status',
      'Product_Type',
      'Material',
      'Grade',
      'Dimension',
      'Dimension_Unit',
      'Length',
      'Length_Unit',
      'Pressure',
      'Pressure_Unit',
      'Standard_Reference'
    ];
    
    const rows = mappings.map(m => [
      m.national_code,
      m.original_code,
      m.sap_code || '',
      m.original_description,
      m.material_known_as || '',
      m.unit || '',
      m.cpse_name,
      m.normalized_description || '',
      m.canonical_description || '',
      m.match_status,
      '', // Confidence - would need to be computed from matches
      '', // Cluster_ID - would need to be joined
      m.match_status === 'APPROVED' ? 'AI Approved' : 'Pending Review',
      m.material_type || '',
      m.material || '',
      m.material_grade || '',
      m.dimension || '',
      m.dimension_unit || '',
      m.length || '',
      m.length_unit || '',
      m.pressure || '',
      m.pressure_unit || '',
      m.standard_reference || ''
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="National_Material_Master.csv"');
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 18. ERP / SAP Mock endpoints
router.get('/erp/status', (req, res) => {
  res.json(erpMock.getConnectionStatus());
});

router.post('/erp/sync', async (req, res) => {
  try {
    // Pull new materials from ERP
    const newItems = await erpMock.pullMaterials();
    let imported = 0;
    
    for (const item of newItems) {
      // Check if duplicate original code exists to prevent double pulls
      const exists = await db.get(`SELECT id FROM materials WHERE original_code = ? AND cpse_name = ?`, [item.original_code, item.cpse_name]);
      if (exists) continue;
      
      const result = await db.run(
        `INSERT INTO materials (
          cpse_name, original_code, sap_code, description, material_known_as, unit,
          specifications, technical_parameters,
          material_type, material_grade, dimension, dimension_unit, length, length_unit,
          standard_reference, unit_of_measurement, classification, match_status,
          thread_size, thread_length, thread_length_unit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          item.cpse_name, item.original_code, item.sap_code || null, item.description, 
          item.material_known_as || null, item.unit || null,
          item.specifications, item.technical_parameters,
          item.material_type, item.material_grade, item.dimension, item.dimension_unit, 
          item.length, item.length_unit,
          item.standard_reference, item.unit_of_measurement, item.classification,
          null, // thread_size
          null, // thread_length
          null  // thread_length_unit
        ]
      );
      imported++;
      await logAudit('sap-connector', 'Material Uploaded', result.id, 'PENDING', `SAP Auto-Sync pulled code ${item.original_code}`);
    }
    
    res.json({ message: `Successfully synchronized with SAP. Pulled ${imported} new material records.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/erp/push', async (req, res) => {
  try {
    const activeMappings = await db.all(`SELECT * FROM mappings WHERE status = 'ACTIVE'`);
    const erpResponse = await erpMock.pushMappings(activeMappings);
    res.json(erpResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. DEMO SEED DATASET (Includes test traps and detailed specs)
router.post('/demo/seed', async (req, res) => {
  try {
    // Check if seeded already to prevent double-seeding (clean seed)
    await db.run(`DELETE FROM cluster_members`);
    await db.run(`DELETE FROM mappings`);
    await db.run(`DELETE FROM clusters`);
    await db.run(`DELETE FROM national_codes`);
    await db.run(`DELETE FROM matches`);
    await db.run(`DELETE FROM reviews`);
    await db.run(`DELETE FROM material_embeddings`);
    await db.run(`DELETE FROM audit_logs`);
    await db.run(`DELETE FROM materials`);

    // 40+ Demo materials to load
    const demoMaterials = [
      // GROUP 1: Equivalent Stainless Steel Pipe (SS304 25mm 6m)
      {
        cpse_name: "CPSE A — Oil & Gas",
        original_code: "A101",
        sap_code: "SAP001",
        description: "SS Pipe 25mm",
        material_known_as: "STAINLESS STEEL PIPE",
        unit: "EA",
        specifications: "Seamless, Schedule 40",
        technical_parameters: "Material: Stainless Steel, Grade: SS304, Size: 25 mm, Length: 6 m",
        material_type: "pipe",
        material_grade: "SS304",
        dimension: "25",
        dimension_unit: "mm",
        length: "6",
        length_unit: "m",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASME B16.9",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE B — Power",
        original_code: "B205",
        sap_code: "SAP002",
        description: "Stainless Steel Tube 25 MM",
        material_known_as: "STAINLESS STEEL PIPE",
        unit: "EA",
        specifications: "SS Grade 304, seamless tube",
        technical_parameters: "Material: SS, Grade: 304, Diameter: 25mm, Length: 6000 mm",
        material_type: "pipe",
        material_grade: "304 SS",
        dimension: "25",
        dimension_unit: "mm",
        length: "6000",
        length_unit: "mm",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASME B16.9",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE C — Steel",
        original_code: "C330",
        sap_code: "SAP003",
        description: "S.S. PIPE DIA 25",
        material_known_as: "STAINLESS STEEL PIPE",
        unit: "EA",
        specifications: "Seamless, Grade 304, Schedule 40",
        technical_parameters: "Dia: 25 mm, Length: 6 meter, Material: SS304",
        material_type: "pipe",
        material_grade: "SS304",
        dimension: "25",
        dimension_unit: "mm",
        length: "6",
        length_unit: "meter",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASME B16.9",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },

      // GROUP 2: Equivalent Carbon Steel Valves (CS Valve DN50)
      {
        cpse_name: "CPSE A — Oil & Gas",
        original_code: "A102",
        sap_code: "SAP004",
        description: "Carbon Steel Valve 50mm",
        material_known_as: "CS VALVE",
        unit: "EA",
        specifications: "Cast steel globe valve, Class 150",
        technical_parameters: "Material: CS, Grade: WCB, Dimension: 50 mm, Class: 150, Cert: API 6D",
        material_type: "valve",
        material_grade: "CS",
        dimension: "50",
        dimension_unit: "mm",
        length: null,
        length_unit: null,
        pressure: "150",
        pressure_unit: "CLASS",
        standard_reference: "API 6D",
        unit_of_measurement: "PIECE",
        classification: "Valves",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE B — Power",
        original_code: "B206",
        sap_code: "SAP005",
        description: "CS Valve DN50",
        material_known_as: "CS VALVE",
        unit: "EA",
        specifications: "Globe valve, Flanged class 150",
        technical_parameters: "DN: 50 mm, rating 150#, standard API 6D",
        material_type: "valve",
        material_grade: "Carbon Steel",
        dimension: "50",
        dimension_unit: "mm",
        length: null,
        length_unit: null,
        pressure: "150",
        pressure_unit: "CLASS",
        standard_reference: "API 6D",
        unit_of_measurement: "PIECE",
        classification: "Valves"
      },

      // GROUP 3: Same Names but Different Materials (TRAPS - MUST NOT MATCH)
      {
        cpse_name: "CPSE A — Oil & Gas",
        original_code: "A103",
        sap_code: "SAP006",
        description: "Steel Pipe",
        material_known_as: "STAINLESS STEEL PIPE",
        unit: "EA",
        specifications: "Grade SS304, Size 25mm",
        technical_parameters: "Stainless Steel, Grade 304, Dia 25mm",
        material_type: "pipe",
        material_grade: "SS304",
        dimension: "25",
        dimension_unit: "mm",
        length: "6",
        length_unit: "m",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASME B16.9",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE B — Power",
        original_code: "B207",
        sap_code: "SAP007",
        description: "Steel Pipe",
        material_known_as: "CARBON STEEL PIPE",
        unit: "EA",
        specifications: "Carbon steel, ASTM A106 Grade B, Size 100mm",
        technical_parameters: "Carbon steel, A106 Gr B, Size 100 mm",
        material_type: "pipe",
        material_grade: "A106",
        dimension: "100",
        dimension_unit: "mm",
        length: "6",
        length_unit: "m",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASTM A106",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },

      // GROUP 4: Different Names (Reviewable Candidate: Steel Gauge vs SS Pipe)
      {
        cpse_name: "CPSE A — Oil & Gas",
        original_code: "A104",
        sap_code: "SAP008",
        description: "Steel Gauge",
        material_known_as: "PRESSURE GAUGE",
        unit: "EA",
        specifications: "Pressure Gauge 0-10 bar, 1/4\" connection",
        technical_parameters: "Range 10 bar, SS casing, 1/4 inch NPT entry",
        material_type: "gauge",
        material_grade: "SS304",
        dimension: "0.25",
        dimension_unit: "inch",
        length: null,
        length_unit: null,
        pressure: "10",
        pressure_unit: "BAR",
        standard_reference: null,
        unit_of_measurement: "PIECE",
        classification: "Instrumentation",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE B — Power",
        original_code: "B208",
        sap_code: "SAP009",
        description: "Stainless Steel Pipe",
        material_known_as: "SS PIPE",
        unit: "EA",
        specifications: "Grade 304, Size 25mm",
        technical_parameters: "SS304, 25mm diameter",
        material_type: "pipe",
        material_grade: "SS304",
        dimension: "25",
        dimension_unit: "mm",
        length: "6",
        length_unit: "m",
        pressure: null,
        pressure_unit: null,
        standard_reference: "ASME B16.9",
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },

      // GROUP 5: Missing / Insufficient Data Case (Industrial Pipe)
      {
        cpse_name: "CPSE C — Steel",
        original_code: "C331",
        sap_code: "SAP006",
        description: "Industrial Pipe",
        material_known_as: "INDUSTRIAL PIPE",
        unit: "M",
        specifications: null,
        technical_parameters: null,
        material_type: null,
        material_grade: null,
        dimension: null,
        dimension_unit: null,
        length: null,
        length_unit: null,
        pressure: null,
        pressure_unit: null,
        standard_reference: null,
        unit_of_measurement: "METER",
        classification: "Pipes & Tubes",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },

      // ADDITIONAL DATA: Gaskets Group
      {
        cpse_name: "CPSE A — Oil & Gas",
        original_code: "A201",
        sap_code: "SAP007",
        description: "Gskt Spwnd 150NB CS ASME B16.20",
        material_known_as: "SPIRAL WOUND GASKET",
        unit: "EA",
        specifications: "Spiral wound gasket, outer ring carbon steel",
        technical_parameters: "Dimension: 150 NB, Rating: 150 LBS, Spec: ASME B16.20",
        material_type: "gasket",
        material_grade: "CS",
        dimension: "150",
        dimension_unit: "NB",
        pressure: "150",
        pressure_unit: "LBS",
        standard_reference: "ASME B16.20",
        unit_of_measurement: "PIECE",
        classification: "Gaskets",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE B — Power",
        original_code: "B304",
        sap_code: "SAP008",
        description: "Spiral Wound Gasket 150 NB Carbon Steel B16.20",
        material_known_as: "SPIRAL WOUND GASKET",
        unit: "EA",
        specifications: "Standard 150 NB spiral gasket CS",
        technical_parameters: "150 NB CS ASME B16.20 Gasket",
        material_type: "gasket",
        material_grade: "CS",
        dimension: "150",
        dimension_unit: "NB",
        pressure: "150",
        pressure_unit: "LBS",
        standard_reference: "ASME B16.20",
        unit_of_measurement: "PIECE",
        classification: "Gaskets",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },

      // Flanges Group
      {
        cpse_name: "CPSE C — Steel",
        original_code: "C401",
        sap_code: "SAP009",
        description: "Flange Slip On 80NB Class 150 ASME B16.5",
        material_known_as: "SLIP-ON FLANGE",
        unit: "EA",
        specifications: "Slip-on carbon steel flange A105",
        technical_parameters: "Size: 80 NB, Class 150, ASTM A105",
        material_type: "flange",
        material_grade: "A105",
        dimension: "80",
        dimension_unit: "NB",
        pressure: "150",
        pressure_unit: "CLASS",
        standard_reference: "ASME B16.5",
        unit_of_measurement: "PIECE",
        classification: "Flanges",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      },
      {
        cpse_name: "CPSE D — Mining",
        original_code: "D112",
        sap_code: "SAP010",
        description: "SORF Flange 80 NB A105 Class 150",
        material_known_as: "SLIP-ON FLANGE",
        unit: "EA",
        specifications: "Slip-on raised face flange, A105 carbon steel",
        technical_parameters: "Flange 80NB class 150 standard B16.5",
        material_type: "flange",
        material_grade: "A105",
        dimension: "80",
        dimension_unit: "NB",
        pressure: "150",
        pressure_unit: "CLASS",
        standard_reference: "ASME B16.5",
        unit_of_measurement: "PIECE",
        classification: "Flanges",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      }
    ];

    // Generate 30 more randomized records to hit 40-50+ count requirements
    const cpseOptions = ["CPSE A — Oil & Gas", "CPSE B — Power", "CPSE C — Steel", "CPSE D — Mining"];
    const types = ["pipe", "valve", "gasket", "flange", "bolt", "nut", "elbow"];
    const gradesMap = {
      pipe: ["SS304", "SS316", "A106", "A53"],
      valve: ["CS", "SS316", "BRASS"],
      gasket: ["CS", "SS316", "TEFLON"],
      flange: ["A105", "F304", "F316"],
      bolt: ["GRADE 8.8", "SS304", "GR5"],
      nut: ["GRADE 8", "SS304"],
      elbow: ["A234 WPB", "WP304"]
    };
    
    for (let i = 1; i <= 30; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      const cpse = cpseOptions[Math.floor(Math.random() * cpseOptions.length)];
      const code = `${cpse.substring(5, 6)}${100 + i}`;
      const size = [15, 25, 40, 50, 80, 100, 150][Math.floor(Math.random() * 7)];
      const grade = gradesMap[type][Math.floor(Math.random() * gradesMap[type].length)];
      
      const details = {
        cpse_name: cpse,
        original_code: code,
        sap_code: `SAP${1000 + i}`,
        description: `${grade} ${type.charAt(0).toUpperCase() + type.slice(1)} ${size}mm`,
        material_known_as: `${grade} ${type.toUpperCase()}`,
        unit: type === "pipe" ? "M" : "EA",
        specifications: `Standard industrial grade ${type}`,
        technical_parameters: `Size: ${size} mm, Grade: ${grade}`,
        material_type: type,
        material_grade: grade,
        dimension: String(size),
        dimension_unit: "mm",
        length: type === "pipe" ? "6" : null,
        length_unit: type === "pipe" ? "m" : null,
        pressure: ["valve", "gasket", "flange"].includes(type) ? "150" : null,
        pressure_unit: ["valve", "gasket", "flange"].includes(type) ? "CLASS" : null,
        standard_reference: type === "pipe" ? "ASME B16.9" : "ASME B16.5",
        unit_of_measurement: type === "pipe" ? "METER" : "PIECE",
        classification: type.charAt(0).toUpperCase() + type.slice(1) + "s",
        thread_size: null,
        thread_length: null,
        thread_length_unit: null
      };
      demoMaterials.push(details);
    }

    // Load into database
    for (const mat of demoMaterials) {
      await db.run(
        `INSERT INTO materials (
          cpse_name, original_code, sap_code, description, material_known_as, unit,
          specifications, technical_parameters,
          material_type, material_grade, dimension, dimension_unit, length, length_unit,
          standard_reference, unit_of_measurement, classification, match_status,
          thread_size, thread_length, thread_length_unit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          mat.cpse_name,
          mat.original_code,
          mat.sap_code || null,
          mat.description,
          mat.material_known_as || null,
          mat.unit || null,
          mat.specifications || null,
          mat.technical_parameters || null,
          mat.material_type || null,
          mat.material_grade || null,
          mat.dimension || null,
          mat.dimension_unit || null,
          mat.length || null,
          mat.length_unit || null,
          mat.standard_reference || null,
          mat.unit_of_measurement || null,
          mat.classification || 'Unclassified',
          mat.thread_size || null,
          mat.thread_length || null,
          mat.thread_length_unit || null
        ]
      );
    }

    await logAudit('admin', 'Upload', null, 'SUCCESS', 'Seeded entire demo dataset containing 40+ structured material records.');
    res.json({ success: true, seededCount: demoMaterials.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
