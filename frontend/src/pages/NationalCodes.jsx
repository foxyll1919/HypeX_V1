import React, { useState, useEffect } from 'react';
import { Barcode, RefreshCw, Layers, Download, Eye, X, FileText, CheckCircle2, History, Search, Filter } from 'lucide-react';
import { getNationalCodes, generateNationalCodes, exportNationalCodes } from '../services/api';

const NationalCodes = () => {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedCode, setSelectedCode] = useState(null);
  const [details, setDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const loadCodes = async () => {
    try {
      setLoading(true);
      const res = await getNationalCodes();
      setCodes(res);
    } catch (err) {
      console.error('Error fetching national codes:', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    try {
      setGenerating(true);
      const res = await generateNationalCodes();
      setCodes(res.nationalCodes);
      alert(`Successfully generated ${res.count} National Material Codes!`);
    } catch (err) {
      alert('Error generating NMCs: ' + err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async () => {
    try {
      const blob = await exportNationalCodes();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'National_Material_Master.csv';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      alert('Error exporting CSV: ' + err.message);
    }
  };

  const handleViewDetails = async (code) => {
    try {
      setSelectedCode(code);
      setDetailsLoading(true);
      // Fetch cluster details for this NMC
      const mappings = await fetch(`/api/mappings?national_code=${code}`).then(r => r.json());
      const clusterId = mappings[0]?.cluster_id || `CL-${code.replace('NMC-', '').padStart(5, '0')}`;
      
      const res = await fetch(`/api/clusters/${clusterId}`).then(r => r.json());
      setDetails(res);
    } catch (err) {
      alert('Error fetching cluster details: ' + err.message);
      setSelectedCode(null);
    } finally {
      setDetailsLoading(false);
    }
  };

  const filteredCodes = codes.filter(c => {
    const matchesSearch = c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.standard_description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.cpses.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.original_codes.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || c.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const categories = [...new Set(codes.map(c => c.category).filter(Boolean))];

  useEffect(() => {
    loadCodes();
  }, []);

  return (
    <div>
      <div className="card-title" style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>National Material Master Codes (NMC)</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="btn btn-primary"
          >
            <RefreshCw style={{ width: '16px', marginRight: '8px' }} />
            <span>{generating ? 'Generating...' : 'Generate NMCs'}</span>
          </button>
          <button
            onClick={handleExport}
            className="btn btn-success"
          >
            <Download style={{ width: '16px', marginRight: '8px' }} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '20px', padding: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
            <Search style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', width: '18px' }} />
            <input
              type="text"
              placeholder="Search NMC, Description, CPSE, or Source Code..."
              className="form-input"
              style={{ paddingLeft: '38px' }}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem', minWidth: '180px' }}
          >
            <option value="">All Categories</option>
            {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
            <Barcode className="animate-spin" style={{ color: '#2563eb' }} />
          </div>
        ) : (
          <div className="table-container">
            <table className="custom-table">
              <thead>
                <tr>
                  <th>NMC Code</th>
                  <th>Standard Description</th>
                  <th>Category Class</th>
                  <th>Source CPSE Owner(s)</th>
                  <th>Mapped Source Code(s)</th>
                  <th style={{ textAlign: 'center' }}>Total Sources</th>
                  <th>Created Date</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCodes.length === 0 ? (
                  <tr>
                    <td colSpan="9" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                      No National Material Codes registered. Approve equivalence mappings first to run clustering.
                    </td>
                  </tr>
                ) : (
                  filteredCodes.map((c) => (
                    <tr key={c.code}>
                      <td style={{ fontWeight: 800, color: '#2563eb', fontSize: '0.95rem' }}>{c.code}</td>
                      <td style={{ fontWeight: 500 }}>{c.standard_description}</td>
                      <td>
                        <span className="badge badge-pending" style={{ textTransform: 'capitalize' }}>
                          {c.category || 'General'}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: '#475569', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.cpses}>
                        {c.cpses}
                      </td>
                      <td style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: '#64748b', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.original_codes}>
                        {c.original_codes}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{c.original_codes_count}</td>
                      <td style={{ fontSize: '0.8rem' }}>{new Date(c.created_at).toLocaleDateString()}</td>
                      <td>
                        <span className="badge badge-approved" style={{ fontSize: '0.65rem' }}>
                          {c.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          onClick={() => handleViewDetails(c.code)}
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                        >
                          <Eye style={{ width: '14px', marginRight: '4px' }} />
                          <span>View Cluster</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CLUSTER DETAILS DRAWER MODAL */}
      {selectedCode && (
        <div style={{ position: 'fixed', top: 0, right: 0, width: '640px', height: '100vh', background: '#fff', boxShadow: '-5px 0 25px rgba(0,0,0,0.15)', zIndex: 100, padding: '30px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Barcode style={{ color: '#2563eb' }} />
              <span>Cluster Details: {selectedCode}</span>
            </h3>
            <button 
              onClick={() => {
                setSelectedCode(null);
                setDetails(null);
              }} 
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <X />
            </button>
          </div>

          {detailsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
              <Layers className="animate-spin" style={{ color: '#2563eb' }} />
            </div>
          ) : (
            details && (
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
                
                {/* Meta details */}
                <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '6px' }}>
                    National Unified Standarization Reference
                  </div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#2563eb', marginBottom: '4px' }}>
                    {details.cluster?.national_code || selectedCode}
                  </div>
                  <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#0f172a' }}>
                    {details.cluster?.standardized_description || 'N/A'}
                  </div>
                </div>

                {/* Member items list */}
                <div>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <FileText style={{ width: '16px', color: '#64748b' }} />
                    <span>Mapped CPSE Inventory Items ({details.members?.length || 0})</span>
                  </h4>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {details.members?.map((m) => (
                      <div key={m.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', backgroundColor: '#fff' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '0.8rem' }}>
                          <span style={{ fontWeight: 700, color: '#2563eb' }}>{m.cpse_name}</span>
                          <span style={{ fontWeight: 600, color: '#64748b' }}>Code: {m.original_code}</span>
                        </div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#0f172a', marginBottom: '8px' }}>
                          {m.description}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', fontSize: '0.75rem', color: '#64748b', borderTop: '1px solid #f1f5f9', paddingTop: '8px' }}>
                          <div><strong>Grade:</strong> {m.material_grade || '-'}</div>
                          <div><strong>Size:</strong> {m.dimension ? `${m.dimension}${m.dimension_unit}` : '-'}</div>
                          <div><strong>Length:</strong> {m.length ? `${m.length}${m.length_unit}` : '-'}</div>
                          <div><strong>Standard:</strong> {m.standard_reference || '-'}</div>
                          <div><strong>Thread:</strong> {m.thread_size || '-'}{m.thread_length ? `x${m.thread_length}${m.thread_length_unit}` : ''}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Audit & Review History */}
                <div>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <History style={{ width: '16px', color: '#64748b' }} />
                    <span>Audit Review Logs</span>
                  </h4>

                  {details.history?.length === 0 ? (
                    <div style={{ fontSize: '0.8rem', color: '#64748b', padding: '12px', border: '1px dashed #cbd5e1', borderRadius: '6px', textAlign: 'center' }}>
                      Direct standard mapping. No audit overrides recorded.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {details.history?.map((h) => (
                        <div key={h.id} style={{ display: 'flex', gap: '12px', fontSize: '0.8rem', padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                          <CheckCircle2 style={{ color: '#10b981', flexShrink: 0, width: '18px' }} />
                          <div>
                            <div style={{ fontWeight: 600 }}>Approved Equivalence Edge</div>
                            <div style={{ color: '#64748b', marginTop: '2px' }}>
                              Mapped {h.code_a} ↔ {h.code_b} (Score: {Math.round(h.final_score * 100)}%)
                            </div>
                            {h.reviewer_comment && (
                              <div style={{ fontStyle: 'italic', marginTop: '4px', color: '#334155' }}>
                                "{h.reviewer_comment}"
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};

export default NationalCodes;
