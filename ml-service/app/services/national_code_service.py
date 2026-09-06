from typing import List, Dict, Any, Optional
from app.config import settings


def generate_nmc_code(prefix: str, index: int) -> str:
    """Generate a National Material Code with the given prefix and index."""
    return f"{prefix}{index:06d}"


def build_canonical_description(attrs: Dict[str, Any]) -> str:
    """
    Build a canonical material description from extracted technical attributes.
    Only includes attributes that are reliably extracted.
    """
    parts = []

    if attrs.get("material"):
        parts.append(attrs["material"].upper())
    
    if attrs.get("material_grade"):
        grade = attrs["material_grade"]
        if not grade.startswith("GRADE"):
            parts.append(f"GRADE {grade}")
        else:
            parts.append(grade)
    
    if attrs.get("product_type"):
        parts.append(attrs["product_type"].upper())
    
    if attrs.get("dimension"):
        dim = attrs["dimension"]
        unit = attrs.get("dimension_unit", "mm")
        parts.append(f"{dim} {unit}")
    
    if attrs.get("pressure"):
        pressure = attrs["pressure"]
        pressure_unit = attrs.get("pressure_unit", "")
        if pressure_unit:
            parts.append(f"{pressure} {pressure_unit}")
        else:
            parts.append(f"CLASS {pressure}")

    if attrs.get("standard_reference"):
        parts.append(attrs["standard_reference"])

    if attrs.get("thread_size"):
        parts.append(f"THREAD {attrs['thread_size']}")
        if attrs.get("thread_length"):
            parts.append(f"x{attrs['thread_length']}{attrs.get('thread_length_unit', 'mm')}")

    return " ".join(parts) if parts else "UNDEFINED MATERIAL"


def validate_cluster_consistency(materials: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Validate that all materials in a cluster can safely share the same NMC.
    Returns validation result with any conflicts found.
    """
    conflicts = []
    
    if len(materials) <= 1:
        return {"valid": True, "conflicts": []}
    
    # Check critical attributes for conflicts
    critical_attrs = [
        "material", "material_grade", "product_type", 
        "dimension", "dimension_unit", "pressure", "pressure_unit",
        "thread_size", "thread_length", "thread_length_unit"
    ]
    
    reference = materials[0]
    for i, mat in enumerate(materials[1:], 1):
        for attr in critical_attrs:
            ref_val = reference.get(attr)
            mat_val = mat.get(attr)
            
            if ref_val and mat_val and ref_val != mat_val:
                conflicts.append({
                    "attribute": attr,
                    "reference_value": ref_val,
                    "material_index": i,
                    "material_value": mat_val,
                    "material_id": mat.get("id")
                })
    
    return {
        "valid": len(conflicts) == 0,
        "conflicts": conflicts
    }


async def generate_national_material_codes(
    clusters: List[List[int]],
    materials_map: Dict[int, Dict[str, Any]],
    prefix: str = "NMC"
) -> List[Dict[str, Any]]:
    """
    Generate National Material Codes for validated clusters.
    
    Args:
        clusters: List of clusters (each cluster is a list of material IDs)
        materials_map: Mapping of material_id -> material data with attributes
        prefix: Prefix for NMC codes (default: NMC)
    
    Returns:
        List of NMC assignments with canonical descriptions
    """
    nmc_assignments = []
    
    # Sort clusters for deterministic ordering
    sorted_clusters = sorted(clusters, key=lambda c: min(c))
    
    for idx, cluster in enumerate(sorted_clusters, 1):
        if not cluster:
            continue
            
        # Get material data for this cluster
        cluster_materials = [materials_map[mid] for mid in cluster if mid in materials_map]
        if not cluster_materials:
            continue
        
        # Validate cluster consistency
        validation = validate_cluster_consistency(cluster_materials)
        if not validation["valid"]:
            # Cluster has conflicts - flag for review
            nmc_assignments.append({
                "cluster_ids": cluster,
                "national_code": None,
                "canonical_description": None,
                "status": "CONFLICT",
                "conflicts": validation["conflicts"],
                "materials": cluster_materials
            })
            continue
        
        # Build canonical description from the most complete material
        # Sort by number of non-null attributes
        cluster_materials.sort(key=lambda m: sum(1 for v in m.values() if v is not None), reverse=True)
        representative = cluster_materials[0]
        
        canonical_desc = build_canonical_description(representative)
        nmc_code = generate_nmc_code(prefix, idx)
        
        nmc_assignments.append({
            "cluster_ids": cluster,
            "national_code": nmc_code,
            "canonical_description": canonical_desc,
            "status": "ASSIGNED",
            "conflicts": [],
            "materials": cluster_materials
        })
    
    return nmc_assignments


def persist_nmc_mapping(
    db_connection,
    nmc_assignments: List[Dict[str, Any]],
    materials_map: Dict[int, Dict[str, Any]]
) -> None:
    """
    Persist NMC assignments to database.
    This is a placeholder - actual implementation depends on database schema.
    """
    # This would be implemented based on the specific database schema
    # For now, it's a no-op since the backend handles persistence
    pass