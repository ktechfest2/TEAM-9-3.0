from fastapi import APIRouter

from app.api.routes.auth import router as auth_router
from app.api.routes.compliance import router as compliance_router
from app.api.routes.crosscheck import router as crosscheck_router
from app.api.routes.elections import router as election_router
from app.api.routes.evidence import router as evidence_router
from app.api.routes.health import router as health_router
from app.api.routes.reconciliation import router as reconciliation_router
from app.api.routes.results import router as result_router
from app.api.routes.workspaces import router as workspace_router

api_router = APIRouter()
api_router.include_router(auth_router, prefix="/auth", tags=["authentication"])
api_router.include_router(health_router, prefix="/health", tags=["health"])
api_router.include_router(workspace_router, tags=["workspaces"])
api_router.include_router(election_router, tags=["elections"])
api_router.include_router(result_router, tags=["results"])
api_router.include_router(reconciliation_router, tags=["reconciliation"])
api_router.include_router(compliance_router, tags=["compliance"])
api_router.include_router(crosscheck_router, tags=["crosscheck"])
api_router.include_router(evidence_router, tags=["evidence"])
