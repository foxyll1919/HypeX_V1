const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const mlBaseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';

// Log the ML service URL being used
console.log(`[ML Client] Connecting to ML service at: ${mlBaseUrl}`);

const mlClient = {
  /**
   * Normalize a material description
   * @param {string} description - Raw material description
   * @returns {Object} { normalized_description }
   */
  normalize: async (description) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/normalize`, { description }, { timeout: 30000 });
      return response.data;
    } catch (err) {
      console.error('ML normalize service error:', err.message);
      throw err;
    }
  },

  /**
   * Extract technical attributes from a description
   * @param {string} description - Raw material description
   * @returns {Object} Extracted attributes
   */
  extract: async (description) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/extract`, { description }, { timeout: 30000 });
      return response.data;
    } catch (err) {
      console.error('ML extract service error:', err.message);
      throw err;
    }
  },

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Object} { embedding: number[] }
   */
  embed: async (text) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/embed`, { text }, { timeout: 60000 });
      return response.data;
    } catch (err) {
      console.error('ML embed service error:', err.message);
      throw err;
    }
  },

  /**
   * Match two materials
   * @param {Object} materialA - First material
   * @param {Object} materialB - Second material
   * @returns {Object} Match result with scores and comparison
   */
  match: async (materialA, materialB) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/match`, { material_a: materialA, material_b: materialB }, { timeout: 30000 });
      return response.data;
    } catch (err) {
      console.error('ML match service error:', err.message);
      throw err;
    }
  },

  /**
   * Run the full matching pipeline on a list of materials
   * This is the main entry point for batch processing
   * @param {Array} materials - Array of material objects
   * @returns {Object} { processed_materials, matches }
   */
  runPipeline: async (materials) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/pipeline/run`, materials, { timeout: 120000 });
      return response.data;
    } catch (err) {
      console.error('ML pipeline run error:', err.message);
      throw err;
    }
  },

  /**
   * Cluster materials based on approved matches
   * @param {Array} materials - List of material IDs
   * @param {Array} approvedMatches - List of [material_a_id, material_b_id] pairs
   * @returns {Object} { clusters: [[material_ids], ...] }
   */
  cluster: async (materials, approvedMatches) => {
    try {
      const response = await axios.post(`${mlBaseUrl}/pipeline/cluster`,
        { materials, approved_matches: approvedMatches },
        { timeout: 60000 }
      );
      return response.data;
    } catch (err) {
      console.error('ML clustering error:', err.message);
      throw err;
    }
  },

  /**
   * Generate National Material Codes for clusters
   * @param {Array} clusters - Array of material ID arrays
   * @param {Object} materials - Map of material_id -> material data
   * @param {string} prefix - NMC prefix (default: NMC)
   * @returns {Object} { nmc_assignments: [...] }
   */
  generateNMC: async (clusters, materials, prefix = 'NMC') => {
    try {
      const response = await axios.post(`${mlBaseUrl}/national-codes/generate`,
        { clusters, materials, prefix },
        { timeout: 60000 }
      );
      return response.data;
    } catch (err) {
      console.error('ML NMC generation error:', err.message);
      throw err;
    }
  },

  /**
   * Health check for ML service
   * @returns {boolean} True if service is healthy
   */
  healthCheck: async () => {
    try {
      const response = await axios.get(`${mlBaseUrl}/health`, { timeout: 5000 });
      return response.status === 200;
    } catch (err) {
      console.error('ML health check failed:', err.message);
      return false;
    }
  }
};

module.exports = mlClient;
