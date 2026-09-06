import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, CheckCircle, AlertTriangle, FileSpreadsheet, PlusCircle, Database, HelpCircle, Loader2, X, ArrowRight, Download } from 'lucide-react';
import { uploadMaterials, addMaterial, seedDemoDataset, startUploadJob, getUploadJobStatus } from '../services/api';

const Upload = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('import');
  const [fileContent, setFileContent] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [validationErrors, setValidationErrors] = useState([]);
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [validationSummary, setValidationSummary] = useState({ total: 0, valid: 0, warnings: 0, errors: 0 });
  const [loading, setLoading] = useState(false);
  const [cpseName, setCpseName] = useState('CPSE A — Oil & Gas');
  
  // Import job state
  const [importJobId, setImportJobId] = useState(null);
  const [importStatus, setImportStatus] = useState(null);
  const [importPolling, setImportPolling] = useState(false);
  const pollingIntervalRef = useRef(null);

  // Manual Form State
  const [manualForm, setManualForm] = useState({
    cpse_name: 'CPSE A — Oil & Gas',
    original_code: '',
    sap_code: '',
    description: '',
    material_known_as: '',
    unit: '',
    specifications: '',
    technical_parameters: '',
    material_type: '',
    material_grade: '',
    dimension: '',
    dimension_unit: 'mm',
    length: '',
    length_unit: 'm',
    standard_reference: '',
    unit_of_measurement: 'PIECE',
    classification: ''
  });

  // Custom CSV parser to handle quotes and commas properly
  const parseCSV = (text) => {
    const lines = [];
    let row = [""];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          row[row.length - 1] += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push("");
      } else if ((char === '\r' || char === '\n') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') i++; // Skip \n
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += char;
      }
    }
    if (row.length > 1 || row[0] !== "") {
      lines.push(row);
    }
    return lines;
  };

  const mapSourceColumns = (item, cpseName) => {
    return {
      cpse_name: cpseName,
      original_code: item.sis_code || item.sis_code || item.SIS_Code || '',
      description: item.material_description || item.Material_Description || '',
      material_known_as: item.material_known_as || item.Material_Known_As || '',
      unit: item.unit || item.Unit || '',
      sap_code: item.sap_code || item.SAP_Code || '',
    };
  };

  const validateCSV = (rows) => {
    const errors = [];
    const warnings = [];
    const validRows = [];
    const seenSisCodes = new Set();
    const seenSapCodes = new Set();

    rows.forEach((row, idx) => {
      const rowErrors = [];
      const rowWarnings = [];

      const sisCode = row.sis_code || row.SIS_Code || '';
      const sapCode = row.sap_code || row.SAP_Code || '';
      const description = row.material_description || row.Material_Description || '';
      const unit = row.unit || row.Unit || '';

      if (!sisCode) rowErrors.push('Missing SIS_Code');
      if (!sapCode) rowWarnings.push('Missing SAP_Code');
      if (!description) rowErrors.push('Missing Material_Description');
      if (!unit) rowWarnings.push('Missing Unit');

      if (sisCode && seenSisCodes.has(sisCode)) {
        rowErrors.push(`Duplicate SIS_Code: ${sisCode}`);
      }
      if (sisCode) seenSisCodes.add(sisCode);

      if (sapCode && seenSapCodes.has(sapCode)) {
        rowWarnings.push(`Duplicate SAP_Code: ${sapCode}`);
      }
      if (sapCode) seenSapCodes.add(sapCode);

      if (rowErrors.length > 0) {
        errors.push(`Row ${idx + 1}: ${rowErrors.join(', ')}`);
      }
      if (rowWarnings.length > 0) {
        warnings.push(`Row ${idx + 1}: ${rowWarnings.join(', ')}`);
      }

      validRows.push({
        ...row,
        _validation: { errors: rowErrors, warnings: rowWarnings },
        _original: { ...row }
      });
    });

    return { validRows, errors, warnings, totalRows: rows.length, validCount: rows.length - errors.length };
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      let rawRows = [];

      try {
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(text);
          rawRows = Array.isArray(parsed) ? parsed : [parsed];
        } else if (file.name.endsWith('.csv')) {
          const parsedLines = parseCSV(text);
          if (parsedLines.length > 0) {
            const headers = parsedLines[0].map(h => h.trim().toLowerCase());
            
            for (let i = 1; i < parsedLines.length; i++) {
              const line = parsedLines[i];
              if (line.length === 1 && line[0] === '') continue;
              
              const item = {};
              headers.forEach((header, index) => {
                item[header] = line[index] ? line[index].trim() : '';
              });
              rawRows.push(item);
            }
          }
        }

        // Validate and map columns
        const { validRows, errors, warnings, totalRows, validCount } = validateCSV(rawRows);
        
        // Apply column mapping with CPSE name
        const mappedRows = validRows.map(r => ({
          ...mapSourceColumns(r, cpseName || 'CPSE A — Oil & Gas'),
          _validation: r._validation,
          _original: r._original
        }));

        setPreviewRows(mappedRows);
        setValidationErrors(errors);
        setValidationWarnings(warnings);
        setFileContent(mappedRows);
        setValidationSummary({ total: totalRows, valid: validCount, warnings: warnings.length, errors: errors.length });
        
        // Reset import state when new file is uploaded
        setImportJobId(null);
        setImportStatus(null);
        stopPolling();
      } catch (err) {
        alert('Failed to parse file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const startImportPolling = (jobId) => {
    setImportJobId(jobId);
    setImportPolling(true);
    setImportStatus(null);
    
    const poll = async () => {
      try {
        const status = await getUploadJobStatus(jobId);
        setImportStatus(status);
        
        if (status.status === 'completed' || status.status === 'failed' || status.status === 'partial') {
          stopPolling();
        }
      } catch (err) {
        console.error('Polling error:', err);
        stopPolling();
        setImportStatus({ status: 'failed', errors: [{ reason: 'Failed to fetch import status' }] });
      }
    };
    
    // Poll immediately, then every 500ms
    poll();
    pollingIntervalRef.current = setInterval(poll, 500);
  };

  const stopPolling = () => {
    setImportPolling(false);
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

const handleStartImport = async () => {
    if (!fileContent || fileContent.length === 0) return;
    
    try {
      setLoading(true);
      
      // Send mapped data with all original fields preserved
      const uploadData = fileContent.map(row => ({
        cpse_name: row.cpse_name,
        original_code: row.original_code, // SIS_Code
        description: row.description,
        material_known_as: row.material_known_as,
        unit: row.unit,
        sap_code: row.sap_code, // SAP_Code
      }));
      
      const res = await startUploadJob(uploadData, cpseName);
      
      // Start polling for progress
      startImportPolling(res.jobId);
      
    } catch (err) {
      setLoading(false);
    }
  };

  const handleViewMaterials = () => {
    stopPolling();
    navigate('/materials');
  };

  const handleContinueToMatching = () => {
    stopPolling();
    navigate('/ai-matching');
  };

  const handleResetImport = () => {
    stopPolling();
    setImportJobId(null);
    setImportStatus(null);
    setPreviewRows([]);
    setFileContent(null);
    setValidationErrors([]);
    setValidationWarnings([]);
    setValidationSummary({ total: 0, valid: 0, warnings: 0, errors: 0 });
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling();
  }, []);

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      await addMaterial(manualForm);
      alert('Material record uploaded successfully!');
      setManualForm({
        cpse_name: 'CPSE A — Oil & Gas',
        original_code: '',
        description: '',
        specifications: '',
        technical_parameters: '',
        material_type: '',
        material_grade: '',
        dimension: '',
        dimension_unit: 'mm',
        length: '',
        length_unit: 'm',
        standard_reference: '',
        unit_of_measurement: 'PIECE',
        classification: ''
      });
      navigate('/materials');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadDemo = async () => {
    try {
      setLoading(true);
      const res = await seedDemoDataset();
      alert(`Demo catalog successfully initialized with ${res.seededCount} records!`);
      navigate('/materials');
    } catch (err) {
      alert('Demo Seeder Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Render import progress UI
  const renderImportProgress = () => {
    if (!importStatus) return null;
    
    const { 
      status, totalRows, processed, inserted, duplicates, failed, 
      percentage, beforeCount, afterCount, expected, found, verified, 
      errors, endTime 
    } = importStatus;
    
    const isCompleted = status === 'completed';
    const isPartial = status === 'partial';
    const isFailed = status === 'failed';
    const isVerifying = status === 'verifying';
    const isImporting = status === 'importing';
    const isFinal = isCompleted || isPartial || isFailed;
    
    // Progress bar color - red if any failures, green only if fully successful
    const hasFailures = failed > 0;
    const isFullySuccessful = isCompleted && !hasFailures && inserted > 0;
    const isNoNewRecords = isCompleted && !hasFailures && inserted === 0 && duplicates > 0;
    const progressColor = hasFailures ? '#ef4444' : (isFullySuccessful || isNoNewRecords) ? '#10b981' : '#2563eb';
    const bgColor = hasFailures ? '#fef2f2' : (isFullySuccessful || isNoNewRecords) ? '#ecfdf5' : '#eff6ff';
    const borderColor = hasFailures ? '#fecaca' : (isFullySuccessful || isNoNewRecords) ? '#a7f3d0' : '#bfdbfe';

    // Duplicates are informational, not failures - split them from real errors
    const failureList = (errors || []).filter(e => e.status === 'FAILED' || !e.status);
    const duplicateList = (errors || []).filter(e => e.status === 'DUPLICATE');

    // Status text based on actual outcome
    const getStatusText = () => {
      if (isImporting) return 'IMPORTING MATERIALS';
      if (isVerifying) return 'VERIFYING DATABASE';
      if (isFullySuccessful) return '✓ IMPORT COMPLETE';
      if (isNoNewRecords) return '✓ IMPORT COMPLETE — NO NEW RECORDS';
      if (isPartial) return '⚠ IMPORT PARTIALLY COMPLETE';
      if (isFailed) return '❌ IMPORT FAILED';
      return 'PROCESSING';
    };
    
    const getSubText = () => {
      if (isImporting || isVerifying) {
        return `${processed} / ${totalRows} records processed`;
      }
      return `${inserted} inserted, ${duplicates} duplicates, ${failed} failed`;
    };

    return (
      <div className="card" style={{ 
        marginTop: '20px', 
        background: bgColor, 
        border: `2px solid ${borderColor}`,
        animation: 'fadeIn 0.3s ease-out'
      }}>
        <div style={{ padding: '24px' }}>
          {/* Status Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            {(isFullySuccessful || isNoNewRecords) && <CheckCircle style={{ width: '28px', height: '28px', color: '#10b981' }} />}
            {isPartial && <AlertTriangle style={{ width: '28px', height: '28px', color: '#f59e0b' }} />}
            {isFailed && <AlertTriangle style={{ width: '28px', height: '28px', color: '#ef4444' }} />}
            {(isImporting || isVerifying) && <Loader2 style={{ width: '28px', height: '28px', color: '#2563eb' }} className="animate-spin" />}
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: progressColor }}>
                {getStatusText()}
              </h3>
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '2px' }}>
                {getSubText()}
              </p>
            </div>
          </div>

          {/* Progress Bar */}
          <div style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.85rem' }}>
              <span style={{ fontWeight: 600, color: '#0f172a' }}>{processed} / {totalRows}</span>
              <span style={{ fontWeight: 700, color: progressColor }}>{percentage}% processed</span>
            </div>
            <div style={{ 
              height: '12px', 
              background: '#e2e8f0', 
              borderRadius: '6px', 
              overflow: 'hidden' 
            }}>
              <div style={{ 
                width: `${percentage}%`, 
                height: '100%', 
                background: progressColor, 
                borderRadius: '6px',
                transition: 'width 0.3s ease-out'
              }} />
            </div>
          </div>

          {/* Stages */}
          <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(0,0,0,0.02)', borderRadius: '8px' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.05em' }}>
              Pipeline Stages
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem' }}>
                <CheckCircle style={{ width: '18px', height: '18px', color: '#10b981', flexShrink: 0 }} />
                <span>✓ CSV validated</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem' }}>
                <CheckCircle style={{ width: '18px', height: '18px', color: '#10b981', flexShrink: 0 }} />
                <span>✓ Database connection established</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem' }}>
                {isImporting ? (
                  <Loader2 style={{ width: '18px', height: '18px', color: '#2563eb', flexShrink: 0 }} className="animate-spin" />
                ) : (isFinal || isVerifying) ? (
                  <CheckCircle style={{ width: '18px', height: '18px', color: hasFailures ? '#f59e0b' : '#10b981', flexShrink: 0 }} />
                ) : (
                  <div style={{ width: '18px', height: '18px', border: '2px solid #cbd5e1', borderRadius: '50%', flexShrink: 0 }} />
                )}
                <span style={{ color: isImporting ? '#2563eb' : (isFinal || isVerifying) ? (hasFailures ? '#f59e0b' : '#10b981') : '#64748b', fontWeight: isImporting || isFinal || isVerifying ? 600 : 400 }}>
                  {isImporting ? '● Importing records' : hasFailures ? '⚠ Import completed with failures' : '✓ Records imported'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem' }}>
                {isVerifying ? (
                  <Loader2 style={{ width: '18px', height: '18px', color: '#2563eb', flexShrink: 0 }} className="animate-spin" />
                ) : isFinal ? (
                  <CheckCircle style={{ width: '18px', height: '18px', color: verified ? '#10b981' : '#ef4444', flexShrink: 0 }} />
                ) : (
                  <div style={{ width: '18px', height: '18px', border: '2px solid #cbd5e1', borderRadius: '50%', flexShrink: 0 }} />
                )}
                <span style={{ color: isVerifying ? '#2563eb' : isFinal ? (verified ? '#10b981' : '#ef4444') : '#64748b', fontWeight: isVerifying || isFinal ? 600 : 400 }}>
                  {isVerifying ? '● Verifying database' : isFinal ? (verified ? '✓ Database verified' : '✗ Verification failed') : 'Database verification'}
                </span>
              </div>
            </div>
          </div>

          {/* Database Count Summary */}
          {isFinal && beforeCount !== undefined && afterCount !== undefined && (
            <div style={{ 
              marginBottom: '20px', 
              padding: '16px', 
              background: '#f8fafc', 
              border: '1px solid #e2e8f0', 
              borderRadius: '8px' 
            }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.05em' }}>
                Database Records
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#64748b' }}>{beforeCount}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Before Import</div>
                </div>
                <div style={{ position: 'relative' }}>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#2563eb' }}>{inserted}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Newly Inserted</div>
                </div>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}>{afterCount}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>After Import</div>
                </div>
              </div>
            </div>
          )}

          {/* Verification Result */}
          {isFinal && (
            <div style={{ 
              marginBottom: '20px', 
              padding: '16px', 
              background: verified ? '#ecfdf5' : '#fef2f2', 
              border: verified ? '1px solid #a7f3d0' : '1px solid #fecaca', 
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px'
            }}>
              {verified ? (
                <CheckCircle style={{ width: '24px', height: '24px', color: '#10b981', flexShrink: 0 }} />
              ) : (
                <AlertTriangle style={{ width: '24px', height: '24px', color: '#ef4444', flexShrink: 0 }} />
              )}
              <div>
                <div style={{ fontWeight: 700, color: verified ? '#065f46' : '#b91c1c' }}>
                  {verified
                    ? (inserted > 0 ? 'Database verification successful' : 'Database verification complete')
                    : 'Database verification failed'}
                </div>
                <div style={{ fontSize: '0.85rem', color: verified ? '#065f46' : '#b91c1c', marginTop: '4px' }}>
                  {verified
                    ? (inserted > 0
                        ? `${inserted} / ${inserted} newly inserted records confirmed in database`
                        : `No new records were inserted — all ${totalRows} records already exist in the database.`)
                    : `Expected ${expected ?? 'N/A'} records, found ${found ?? 'N/A'}`}
                </div>
              </div>
            </div>
          )}

          {/* Errors */}
          {errors && errors.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#b91c1c', textTransform: 'uppercase', marginBottom: '8px' }}>
                Errors ({errors.length})
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '0.8rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '12px' }}>
                {errors.slice(0, 10).map((err, idx) => (
                  <div key={idx} style={{ marginBottom: '8px', padding: '8px', background: '#fff', borderRadius: '4px' }}>
                    <div style={{ fontWeight: 600, color: '#b91c1c' }}>
                      Row {err.row}: {err.originalCode || 'N/A'}
                    </div>
                    <div style={{ color: '#64748b', marginTop: '2px' }}>{err.reason}</div>
                  </div>
                ))}
                {errors.length > 10 && (
                  <div style={{ color: '#64748b', fontStyle: 'italic', marginTop: '8px' }}>
                    ...and {errors.length - 10} more errors
                  </div>
                )}
              </div>
            </div>
          )}

           {/* Action Buttons - only show for final states */}
           {(isFullySuccessful || isNoNewRecords) && (
             <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
               <button
                 onClick={handleViewMaterials}
                 className="btn btn-primary"
                 style={{ flex: 1, minWidth: '180px' }}
               >
                 <Database style={{ width: '18px', marginRight: '8px' }} />
                 <span>View Materials</span>
               </button>
               {isFullySuccessful && (
                 <button
                   onClick={handleContinueToMatching}
                   className="btn btn-success"
                   style={{ flex: 1, minWidth: '180px' }}
                 >
                   <ArrowRight style={{ width: '18px', marginRight: '8px' }} />
                   <span>Continue to AI Matching →</span>
                 </button>
               )}
               <button
                 onClick={handleResetImport}
                 className="btn btn-secondary"
                 style={{ flex: 1, minWidth: '140px' }}
               >
                 <X style={{ width: '18px', marginRight: '8px' }} />
                 <span>Import Another</span>
               </button>
             </div>
           )}

          {isPartial && (
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={handleViewMaterials}
                className="btn btn-primary"
                style={{ flex: 1, minWidth: '180px' }}
              >
                <Database style={{ width: '18px', marginRight: '8px' }} />
                <span>View Materials</span>
              </button>
              <button
                onClick={handleContinueToMatching}
                className="btn btn-success"
                style={{ flex: 1, minWidth: '180px' }}
              >
                <ArrowRight style={{ width: '18px', marginRight: '8px' }} />
                <span>Continue to AI Matching →</span>
              </button>
              <button
                onClick={handleStartImport}
                disabled={loading}
                className="btn btn-warning"
                style={{ flex: 1, minWidth: '180px' }}
              >
                <Loader2 style={{ width: '18px', marginRight: '8px' }} className="animate-spin" />
                <span>Retry Failed Rows</span>
              </button>
              <button
                onClick={handleResetImport}
                className="btn btn-secondary"
                style={{ flex: 1, minWidth: '140px' }}
              >
                <X style={{ width: '18px', marginRight: '8px' }} />
                <span>Import Another</span>
              </button>
            </div>
          )}

          {isFailed && (
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={handleStartImport}
                disabled={loading}
                className="btn btn-primary"
              >
                <Loader2 style={{ width: '18px', marginRight: '8px' }} className="animate-spin" />
                <span>Retry Import</span>
              </button>
              <button
                onClick={handleResetImport}
                className="btn btn-secondary"
              >
                <X style={{ width: '18px', marginRight: '8px' }} />
                <span>Import Another</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="card-title" style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Data Ingestion Portal</h2>
      </div>

      {/* Tabs Menu */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: '24px', gap: '8px' }}>
        <button
          onClick={() => setActiveTab('import')}
          style={{
            padding: '12px 24px',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'import' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'import' ? '#2563eb' : '#64748b',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.95rem'
          }}
        >
          File Import (CSV/JSON)
        </button>
        <button
          onClick={() => setActiveTab('manual')}
          style={{
            padding: '12px 24px',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'manual' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'manual' ? '#2563eb' : '#64748b',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.95rem'
          }}
        >
          Manual Entry Form
        </button>
        <button
          onClick={() => setActiveTab('demo')}
          style={{
            padding: '12px 24px',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'demo' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'demo' ? '#2563eb' : '#64748b',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.95rem'
          }}
        >
          Demo Datasets Seeder
        </button>
      </div>

      {/* Tab Content: File Import */}
      {activeTab === 'import' && (
        <div>
          <div className="card" style={{ marginBottom: '20px' }}>
            <div className="form-group" style={{ maxWidth: '400px' }}>
              <label className="form-label">CPSE Name (for this dataset)</label>
              <select
                value={cpseName}
                onChange={(e) => setCpseName(e.target.value)}
                className="form-input"
              >
                <option value="CPSE A — Oil & Gas">CPSE A — Oil & Gas</option>
                <option value="CPSE B — Power">CPSE B — Power</option>
                <option value="CPSE C — Steel">CPSE C — Steel</option>
                <option value="CPSE D — Mining">CPSE D — Mining</option>
              </select>
            </div>
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '8px' }}>
              Select the CPSE this CSV file belongs to. All rows will be tagged with this CPSE.
            </p>
          </div>

          <div className="card" style={{ textAlign: 'center', padding: '40px', border: '2px dashed #cbd5e1' }}>
            <UploadCloud style={{ width: '48px', height: '48px', color: '#94a3b8', marginBottom: '16px' }} />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '8px' }}>Upload Material Masters File</h3>
            <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '20px' }}>
              Supports CSV format with columns: SIS_Code, SAP_Code, Material_Description, Material_Known_As, Unit
            </p>
            <div style={{ display: 'inline-block', position: 'relative' }}>
              <input
                type="file"
                accept=".csv,.json"
                onChange={handleFileChange}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  opacity: 0,
                  width: '100%',
                  height: '100%',
                  cursor: 'pointer'
                }}
              />
              <button className="btn btn-primary">Choose CSV / JSON File</button>
            </div>
          </div>

          {/* Validation Summary */}
          {validationSummary.total > 0 && (
            <div className="card" style={{ marginTop: '20px', padding: '16px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '12px', color: '#0f172a' }}>Validation Summary</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a' }}>{validationSummary.total}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Total Records</div>
                </div>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}>{validationSummary.valid}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Valid</div>
                </div>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f59e0b' }}>{validationSummary.warnings}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Warnings</div>
                </div>
                <div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ef4444' }}>{validationSummary.errors}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase' }}>Errors</div>
                </div>
              </div>
            </div>
          )}

          {/* Validation Feed & Previews */}
          {previewRows.length > 0 && (
            <div className="card">
              <h3 className="card-title" style={{ fontSize: '1.05rem' }}>
                <span>File Preview (Mapped Columns)</span>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>({previewRows.length} rows)</span>
              </h3>

              {validationErrors.length > 0 && (
                <div style={{ padding: '16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#b91c1c', fontSize: '0.85rem', marginBottom: '20px', display: 'flex', gap: '8px' }}>
                  <AlertTriangle style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 700 }}>Data Validation Errors:</div>
                    <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                      {validationErrors.slice(0, 5).map((e, idx) => <li key={idx}>{e}</li>)}
                      {validationErrors.length > 5 && <li>...and {validationErrors.length - 5} more errors.</li>}
                    </ul>
                  </div>
                </div>
              )}

              {validationWarnings.length > 0 && validationErrors.length === 0 && (
                <div style={{ padding: '16px', background: '#fffbeb', border: '1px solid #fde047', borderRadius: '8px', color: '#854d0e', fontSize: '0.85rem', marginBottom: '20px', display: 'flex', gap: '8px' }}>
                  <AlertTriangle style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 700 }}>Data Validation Warnings:</div>
                    <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                      {validationWarnings.slice(0, 5).map((e, idx) => <li key={idx}>{e}</li>)}
                      {validationWarnings.length > 5 && <li>...and {validationWarnings.length - 5} more warnings.</li>}
                    </ul>
                  </div>
                </div>
              )}

              {validationErrors.length === 0 && validationWarnings.length === 0 && validationSummary.total > 0 && (
                <div style={{ padding: '16px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', color: '#065f46', fontSize: '0.85rem', marginBottom: '20px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <CheckCircle style={{ width: '20px' }} />
                  <span style={{ fontWeight: 600 }}>Validation Complete: All rows contain required mapping fields.</span>
                </div>
              )}

              <div className="table-container" style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '20px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                <table className="custom-table" style={{ fontSize: '0.8rem' }}>
                  <thead>
                    <tr>
                      <th>CPSE</th>
                      <th>SIS Code</th>
                      <th>SAP Code</th>
                      <th>Material Description</th>
                      <th>Material Known As</th>
                      <th>Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 10).map((row, idx) => (
                      <tr key={idx} style={{ backgroundColor: row._validation?.errors?.length ? '#fef2f2' : '' }}>
                        <td>{row.cpse_name}</td>
                        <td style={{ fontWeight: 600 }}>{row.original_code || '-'}</td>
                        <td>{row.sap_code || '-'}</td>
                        <td>{row.description || '-'}</td>
                        <td>{row.material_known_as || '-'}</td>
                        <td>{row.unit || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Import Progress UI */}
              {renderImportProgress()}

              {/* Import Button - only show when not importing */}
              {!importStatus && (
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    onClick={handleStartImport}
                    disabled={loading || validationErrors.length > 0}
                    className="btn btn-success"
                  >
                    <Database style={{ width: '18px', marginRight: '8px' }} />
                    <span>Import {previewRows.length} Records to Database</span>
                  </button>
                  <button
                    onClick={() => {
                      setPreviewRows([]);
                      setFileContent(null);
                      setValidationErrors([]);
                      setValidationWarnings([]);
                      setValidationSummary({ total: 0, valid: 0, warnings: 0, errors: 0 });
                    }}
                    className="btn btn-secondary"
                  >
                    Discard File
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Manual Form */}
      {activeTab === 'manual' && (
        <form onSubmit={handleManualSubmit} className="card animated-fadeIn" style={{ maxWidth: '800px', margin: '0 auto' }}>
          <h3 className="card-title">Add Material Record</h3>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">CPSE Enterprise</label>
              <select
                value={manualForm.cpse_name}
                onChange={(e) => setManualForm({ ...manualForm, cpse_name: e.target.value })}
                className="form-input"
                required
              >
                <option value="CPSE A — Oil & Gas">CPSE A — Oil & Gas</option>
                <option value="CPSE B — Power">CPSE B — Power</option>
                <option value="CPSE C — Steel">CPSE C — Steel</option>
                <option value="CPSE D — Mining">CPSE D — Mining</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">SIS Code (Original Material Code)</label>
              <input
                type="text"
                placeholder="e.g. 1001"
                className="form-input"
                value={manualForm.original_code}
                onChange={(e) => setManualForm({ ...manualForm, original_code: e.target.value.toUpperCase() })}
                required
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">SAP Code</label>
              <input
                type="text"
                placeholder="e.g. SAP001"
                className="form-input"
                value={manualForm.sap_code}
                onChange={(e) => setManualForm({ ...manualForm, sap_code: e.target.value.toUpperCase() })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Unit</label>
              <input
                type="text"
                placeholder="e.g. EA"
                className="form-input"
                value={manualForm.unit}
                onChange={(e) => setManualForm({ ...manualForm, unit: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Material Description</label>
            <input
              type="text"
              placeholder="e.g. SS PIPE 25MM"
              className="form-input"
              value={manualForm.description}
              onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Material Known As</label>
            <input
              type="text"
              placeholder="e.g. STAINLESS STEEL PIPE"
              className="form-input"
              value={manualForm.material_known_as}
              onChange={(e) => setManualForm({ ...manualForm, material_known_as: e.target.value })}
            />
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Specifications (Auxiliary)</label>
              <input
                type="text"
                placeholder="e.g. Schedule 40 seamless"
                className="form-input"
                value={manualForm.specifications}
                onChange={(e) => setManualForm({ ...manualForm, specifications: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Classification / Category</label>
              <input
                type="text"
                placeholder="e.g. Pipes & Tubes"
                className="form-input"
                value={manualForm.classification}
                onChange={(e) => setManualForm({ ...manualForm, classification: e.target.value })}
              />
            </div>
          </div>

          <div className="grid-3">
            <div className="form-group">
              <label className="form-label">Product Type</label>
              <input
                type="text"
                placeholder="e.g. pipe"
                className="form-input"
                value={manualForm.material_type}
                onChange={(e) => setManualForm({ ...manualForm, material_type: e.target.value.toLowerCase() })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Grade</label>
              <input
                type="text"
                placeholder="e.g. SS304"
                className="form-input"
                value={manualForm.material_grade}
                onChange={(e) => setManualForm({ ...manualForm, material_grade: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">UoM</label>
              <input
                type="text"
                placeholder="e.g. METER"
                className="form-input"
                value={manualForm.unit_of_measurement}
                onChange={(e) => setManualForm({ ...manualForm, unit_of_measurement: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="grid-2">
            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ flex: 2 }} className="form-group">
                <label className="form-label">Dimension Value</label>
                <input
                  type="text"
                  placeholder="e.g. 25"
                  className="form-input"
                  value={manualForm.dimension}
                  onChange={(e) => setManualForm({ ...manualForm, dimension: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }} className="form-group">
                <label className="form-label">Unit</label>
                <input
                  type="text"
                  className="form-input"
                  value={manualForm.dimension_unit}
                  onChange={(e) => setManualForm({ ...manualForm, dimension_unit: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ flex: 2 }} className="form-group">
                <label className="form-label">Length Value</label>
                <input
                  type="text"
                  placeholder="e.g. 6"
                  className="form-input"
                  value={manualForm.length}
                  onChange={(e) => setManualForm({ ...manualForm, length: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }} className="form-group">
                <label className="form-label">Unit</label>
                <input
                  type="text"
                  className="form-input"
                  value={manualForm.length_unit}
                  onChange={(e) => setManualForm({ ...manualForm, length_unit: e.target.value })}
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ width: '200px', justifyContent: 'center' }}
          >
            <PlusCircle style={{ width: '18px' }} />
            <span>{loading ? 'Uploading...' : 'Save Material'}</span>
          </button>
        </form>
      )}

      {/* Tab Content: Demo seed */}
      {activeTab === 'demo' && (
        <div className="card animated-fadeIn" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center', padding: '40px' }}>
          <Database style={{ width: '48px', height: '48px', color: '#10b981', margin: '0 auto 16px' }} />
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '8px' }}>Load National Demo Catalog</h3>
          <p style={{ color: '#64748b', fontSize: '0.9rem', marginBottom: '24px', lineHeight: '1.6' }}>
            Initializes the SQLite database with 40+ realistic materials from different CPSEs. It sets up the core demonstration groups:
          </p>
          <div style={{ textAlign: 'left', background: '#f8fafc', padding: '16px', borderRadius: '8px', fontSize: '0.85rem', color: '#334155', marginBottom: '24px', border: '1px solid #e2e8f0' }}>
            <div style={{ marginBottom: '8px' }}>✓ <strong>Group 1:</strong> SS Pipe dia 25mm matching (A101/B205/C330).</div>
            <div style={{ marginBottom: '8px' }}>✓ <strong>Group 2:</strong> CS Globe Valve DN50 matching (A102/B206).</div>
            <div style={{ marginBottom: '8px' }}>✓ <strong>Group 3 (Trap):</strong> Steel Pipe (A103-SS vs B207-Carbon Steel) - must remain rejected.</div>
            <div style={{ marginBottom: '8px' }}>✓ <strong>Group 4 (Review):</strong> Different names (A104-Gauge vs B208-Pipe).</div>
            <div>✓ <strong>Group 5 (Missing):</strong> Industrial Pipe (C331) - triggers insufficient attributes flags.</div>
          </div>
          <button
            onClick={handleLoadDemo}
            disabled={loading}
            className="btn btn-success"
            style={{ padding: '12px 24px', fontSize: '0.95rem' }}
          >
            {loading ? 'Populating Database...' : 'Seed Catalog Now'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Upload;
