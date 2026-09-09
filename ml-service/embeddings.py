import hashlib
import os
from typing import List, Optional

import httpx
import numpy as np

LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080")
LLAMA_EMBEDDING_ENDPOINT = os.getenv("LLAMA_EMBEDDING_ENDPOINT", "/v1/embeddings")
LLAMA_MODEL_NAME = os.getenv("LLAMA_MODEL_NAME", "Qwen3-Embedding-4B")
EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "384"))
_sentence_transformer = None


def _try_sentence_transformer(text: str) -> Optional[List[float]]:
    global _sentence_transformer
    try:
        if _sentence_transformer is None:
            from sentence_transformers import SentenceTransformer
            _sentence_transformer = SentenceTransformer("all-MiniLM-L6-v2")
        return _sentence_transformer.encode(text).tolist()
    except Exception:
        return None


def _try_qwen_embedding(text: str) -> Optional[List[float]]:
    try:
        response = httpx.post(
            f"{LLAMA_SERVER_URL}{LLAMA_EMBEDDING_ENDPOINT}",
            json={"model": LLAMA_MODEL_NAME, "input": [text]},
            timeout=float(os.getenv("LLAMA_TIMEOUT_SECONDS", "120")),
        )
        response.raise_for_status()
        items = response.json().get("data", [])
        if items and items[0].get("embedding"):
            return _fit_embedding_dimension(items[0]["embedding"])
    except Exception as exc:
        print(f"Qwen embedding unavailable ({exc}); trying fallback provider.")
    return None


def _fit_embedding_dimension(values: List[float]) -> List[float]:
    """Fold model vectors into the existing 384-dimensional database contract."""
    vector = np.zeros(EMBEDDING_DIMENSION, dtype=float)
    for index, value in enumerate(values):
        vector[index % EMBEDDING_DIMENSION] += float(value)
    norm = np.linalg.norm(vector)
    if norm > 0:
        vector /= norm
    return vector.tolist()

def get_fallback_embedding(text: str, dimension: int = 384) -> List[float]:
    """
    Generates a deterministic 384-dimensional unit vector using word and character bigram hashing.
    Maintains similarity score scaling when calculating dot products.
    """
    if not text:
        return [0.0] * dimension
        
    vector = np.zeros(dimension, dtype=float)
    words = text.lower().split()
    
    # Feature hash words to index positions
    for word in words:
        h1 = int(hashlib.md5(word.encode()).hexdigest(), 16) % dimension
        h2 = int(hashlib.md5((word + "_salt").encode()).hexdigest(), 16) % dimension
        vector[h1] += 1.0
        vector[h2] += 0.5
        
    # Feature hash character bigrams for edit distance / spelling correction mapping
    chars = text.lower()
    for i in range(len(chars) - 1):
        bigram = chars[i:i+2]
        h = int(hashlib.md5(bigram.encode()).hexdigest(), 16) % dimension
        vector[h] += 0.2
        
    # Unit normalization (L2 norm)
    norm = np.linalg.norm(vector)
    if norm > 0:
        vector = vector / norm
        
    return vector.tolist()

def generate_embedding(text: str) -> List[float]:
    """
    Computes a 384-dimensional vector embedding.
    Attempts sentence-transformers first, and falls back to feature-hashing if not installed/configured.
    """
    return (
        _try_qwen_embedding(text)
        or _try_sentence_transformer(text)
        or get_fallback_embedding(text)
    )

def calculate_cosine_similarity(emb_a: List[float], emb_b: List[float]) -> float:
    """
    Calculates the cosine similarity between two unit vectors.
    """
    vec_a = np.array(emb_a)
    vec_b = np.array(emb_b)
    
    norm_a = np.linalg.norm(vec_a)
    norm_b = np.linalg.norm(vec_b)
    
    if norm_a == 0 or norm_b == 0:
        return 0.0
        
    similarity = np.dot(vec_a, vec_b) / (norm_a * norm_b)
    return float(np.clip(similarity, 0.0, 1.0))
