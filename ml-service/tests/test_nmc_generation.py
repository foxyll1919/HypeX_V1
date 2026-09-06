import pytest
from app.services.national_code_service import (
    generate_nmc_code,
    build_canonical_description,
    validate_cluster_consistency,
    generate_national_material_codes
)


class TestNMCGeneration:
    def test_generate_nmc_code_basic(self):
        code = generate_nmc_code("NMC", 1)
        assert code == "NMC000001"
    
    def test_generate_nmc_code_large_index(self):
        code = generate_nmc_code("NMC", 123456)
        assert code == "NMC123456"
    
    def test_generate_nmc_code_custom_prefix(self):
        code = generate_nmc_code("NAT", 42)
        assert code == "NAT000042"
    
    def test_build_canonical_description_complete(self):
        attrs = {
            "material": "stainless steel",
            "material_grade": "SS304",
            "product_type": "pipe",
            "dimension": "25",
            "dimension_unit": "mm",
            "pressure": "150",
            "pressure_unit": "CLASS",
            "standard_reference": "ASME B16.9"
        }
        desc = build_canonical_description(attrs)
        assert "STAINLESS STEEL" in desc
        assert "GRADE SS304" in desc
        assert "PIPE" in desc
        assert "25 mm" in desc
        assert "150 CLASS" in desc
        assert "ASME B16.9" in desc
    
    def test_build_canonical_description_minimal(self):
        attrs = {
            "material": "carbon steel",
            "product_type": "valve"
        }
        desc = build_canonical_description(attrs)
        assert "CARBON STEEL" in desc
        assert "VALVE" in desc
    
    def test_build_canonical_description_with_thread(self):
        attrs = {
            "material": "stainless steel",
            "product_type": "bolt",
            "thread_size": "M16",
            "thread_length": "50",
            "thread_length_unit": "mm"
        }
        desc = build_canonical_description(attrs)
        assert "STAINLESS STEEL" in desc
        assert "BOLT" in desc
        assert "THREAD M16" in desc
        assert "x50mm" in desc
    
    def test_build_canonical_description_empty(self):
        attrs = {}
        desc = build_canonical_description(attrs)
        assert desc == "UNDEFINED MATERIAL"
    
    def test_validate_cluster_consistency_single(self):
        materials = [{"id": 1, "material": "stainless steel", "dimension": "25"}]
        result = validate_cluster_consistency(materials)
        assert result["valid"] is True
        assert result["conflicts"] == []
    
    def test_validate_cluster_consistency_matching(self):
        materials = [
            {"id": 1, "material": "stainless steel", "material_grade": "SS304", "dimension": "25"},
            {"id": 2, "material": "stainless steel", "material_grade": "SS304", "dimension": "25"}
        ]
        result = validate_cluster_consistency(materials)
        assert result["valid"] is True
        assert result["conflicts"] == []
    
    def test_validate_cluster_consistency_conflict(self):
        materials = [
            {"id": 1, "material": "stainless steel", "material_grade": "SS304", "dimension": "25"},
            {"id": 2, "material": "carbon steel", "material_grade": "SS304", "dimension": "25"}
        ]
        result = validate_cluster_consistency(materials)
        assert result["valid"] is False
        assert len(result["conflicts"]) > 0
        assert result["conflicts"][0]["attribute"] == "material"
    
    def test_validate_cluster_consistency_grade_conflict(self):
        materials = [
            {"id": 1, "material": "stainless steel", "material_grade": "SS304"},
            {"id": 2, "material": "stainless steel", "material_grade": "SS316"}
        ]
        result = validate_cluster_consistency(materials)
        assert result["valid"] is False
        assert any(c["attribute"] == "material_grade" for c in result["conflicts"])
    
    def test_validate_cluster_consistency_pressure_conflict(self):
        materials = [
            {"id": 1, "material": "stainless steel", "pressure": "150", "pressure_unit": "CLASS"},
            {"id": 2, "material": "stainless steel", "pressure": "300", "pressure_unit": "CLASS"}
        ]
        result = validate_cluster_consistency(materials)
        assert result["valid"] is False
        assert any(c["attribute"] == "pressure" for c in result["conflicts"])
    
    @pytest.mark.asyncio
    async def test_generate_national_material_codes_basic(self):
        clusters = [[1, 2], [3]]
        materials_map = {
            1: {"id": 1, "material": "stainless steel", "material_grade": "SS304", "product_type": "pipe", "dimension": "25", "dimension_unit": "mm"},
            2: {"id": 2, "material": "stainless steel", "material_grade": "SS304", "product_type": "pipe", "dimension": "25", "dimension_unit": "mm"},
            3: {"id": 3, "material": "carbon steel", "material_grade": "CS", "product_type": "valve", "dimension": "50", "dimension_unit": "mm"}
        }
        assignments = await generate_national_material_codes(clusters, materials_map, "NMC")
        
        assert len(assignments) == 2
        assert assignments[0]["national_code"] == "NMC000001"
        assert assignments[1]["national_code"] == "NMC000002"
        assert assignments[0]["status"] == "ASSIGNED"
        assert assignments[1]["status"] == "ASSIGNED"
        assert "STAINLESS STEEL" in assignments[0]["canonical_description"]
        assert "CARBON STEEL" in assignments[1]["canonical_description"]
    
    @pytest.mark.asyncio
    async def test_generate_national_material_codes_with_conflict(self):
        clusters = [[1, 2]]
        materials_map = {
            1: {"id": 1, "material": "stainless steel", "material_grade": "SS304"},
            2: {"id": 2, "material": "carbon steel", "material_grade": "SS304"}
        }
        assignments = await generate_national_material_codes(clusters, materials_map, "NMC")
        
        assert len(assignments) == 1
        assert assignments[0]["national_code"] is None
        assert assignments[0]["status"] == "CONFLICT"
        assert len(assignments[0]["conflicts"]) > 0
    
    @pytest.mark.asyncio
    async def test_generate_national_material_codes_deterministic_order(self):
        # Test that clusters are sorted by minimum material ID
        clusters = [[3, 4], [1, 2]]
        materials_map = {
            1: {"id": 1, "material": "stainless steel"},
            2: {"id": 2, "material": "stainless steel"},
            3: {"id": 3, "material": "carbon steel"},
            4: {"id": 4, "material": "carbon steel"}
        }
        assignments = await generate_national_material_codes(clusters, materials_map, "NMC")
        
        # Cluster with min ID 1 should get NMC000001
        assert assignments[0]["national_code"] == "NMC000001"
        assert 1 in assignments[0]["cluster_ids"]
        assert assignments[1]["national_code"] == "NMC000002"
        assert 3 in assignments[1]["cluster_ids"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])