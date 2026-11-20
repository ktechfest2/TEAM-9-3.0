"""Development-only evidence store, used when Cloudinary credentials are absent.

Mirrors the Cloudinary contract: files are immutable once written, hashed with SHA-256 at
ingestion, and only readable through short-lived HMAC-signed URLs. Production refuses to start
without Cloudinary (see Settings.validate_production), so this never serves real evidence.
"""

import hashlib
import hmac
import mimetypes
import uuid
from pathlib import Path
from time import time
from urllib.parse import urlencode

from app.core.config import get_settings
from app.core.errors import AppError

# How long a signed evidence link stays valid, shared by the local and Cloudinary stores.
EVIDENCE_LINK_SECONDS = 3600

EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "application/zip": "zip",
}


def _root() -> Path:
    root = Path(get_settings().local_evidence_dir)
    if not root.is_absolute():
        root = Path(__file__).resolve().parents[2] / root
    return root


def _path(public_id: str) -> Path:
    root = _root().resolve()
    target = (root / public_id).resolve()
    if root not in target.parents:
        raise AppError("invalid_evidence_key", "Evidence key is invalid", 400)
    return target


def _signature(public_id: str, expires: int) -> str:
    key = get_settings().auth_secret_key.encode()
    return hmac.new(key, f"{public_id}|{expires}".encode(), hashlib.sha256).hexdigest()


def store(content: bytes, media_type: str, workspace_id: uuid.UUID) -> dict:
    digest = hashlib.sha256(content).hexdigest()
    ext = EXTENSIONS.get(media_type, "bin")
    public_id = f"local/{workspace_id}/{uuid.uuid4()}.{ext}"
    target = _path(public_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as fh:  # exclusive create: never overwrite evidence
        fh.write(content)
    return {
        "sha256": digest,
        "public_id": public_id,
        "version": "1",
        "resource_type": "local",
        "format": ext,
        "secure_url": f"local://{public_id}",
    }


def signed_url(public_id: str, lifetime: int = EVIDENCE_LINK_SECONDS) -> str:
    expires = int(time()) + lifetime
    query = urlencode({"key": public_id, "exp": expires, "sig": _signature(public_id, expires)})
    return f"{get_settings().api_v1_prefix}/evidence/local?{query}"


def resolve_signed(public_id: str, expires: int, signature: str) -> tuple[Path, str]:
    if expires < int(time()):
        raise AppError("evidence_link_expired", "Evidence link has expired", 410)
    if not hmac.compare_digest(_signature(public_id, expires), signature):
        raise AppError("invalid_evidence_signature", "Evidence link is invalid", 403)
    target = _path(public_id)
    if not target.is_file():
        raise AppError("evidence_not_found", "Evidence file was not found", 404)
    return target, mimetypes.guess_type(target.name)[0] or "application/octet-stream"


def sha256_of(public_id: str) -> str:
    return hashlib.sha256(_path(public_id).read_bytes()).hexdigest()
