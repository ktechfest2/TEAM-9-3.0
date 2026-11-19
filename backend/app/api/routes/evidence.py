from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from app.services.local_storage import resolve_signed

router = APIRouter()


@router.get("/evidence/local", include_in_schema=False)
def local_evidence(
    key: Annotated[str, Query(max_length=300)],
    exp: Annotated[int, Query()],
    sig: Annotated[str, Query(min_length=64, max_length=64)],
) -> FileResponse:
    """Serve a development-store evidence file through its signed, expiring link."""
    path, media_type = resolve_signed(key, exp, sig)
    return FileResponse(
        path, media_type=media_type, headers={"Cache-Control": "private, max-age=300"}
    )
