import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Header, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser, require_geography_scope, require_workspace_roles
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.session import get_db
from app.models.compliance import EvidenceIntegrityCheck
from app.models.elections import Candidate, Contest, Election
from app.models.organisation import GeographyNode, Membership, Workspace
from app.models.results import Document, ResultFigure, ResultSubmission
from app.schemas.results import (
    DocumentAccessResponse,
    DocumentResponse,
    IntegrityResponse,
    SubmissionCreate,
    SubmissionResponse,
)
from app.services.cloudinary_storage import remote_sha256, signed_download_url, upload_evidence

router = APIRouter(prefix="/workspaces/{workspace_id}")
all_roles = require_workspace_roles(
    "party_admin", "pu_agent", "ward_agent", "collation_officer", "operations", "legal_compliance"
)


@router.post("/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(
    workspace_id: uuid.UUID,
    user: CurrentUser,
    membership: Annotated[Membership, Depends(all_roles)],
    db: Annotated[Session, Depends(get_db)],
    file: Annotated[UploadFile, File()],
    provenance: Literal["party_submitted", "public_irev"] = "party_submitted",
    parent_document_id: uuid.UUID | None = None,
) -> Document:
    del membership
    content = await file.read()
    parent = db.get(Document, parent_document_id) if parent_document_id else None
    if parent_document_id and (parent is None or parent.workspace_id != workspace_id):
        raise AppError(
            "invalid_parent_document", "Parent document was not found in this workspace", 422
        )
    uploaded = upload_evidence(
        content, file.filename or "evidence", file.content_type or "", workspace_id
    )
    document = Document(
        workspace_id=workspace_id,
        cloudinary_public_id=uploaded["public_id"],
        cloudinary_version=str(uploaded["version"]),
        resource_type=uploaded["resource_type"],
        cloudinary_format=uploaded.get("format") or "bin",
        secure_url=uploaded["secure_url"],
        original_filename=file.filename or "evidence",
        media_type=file.content_type or "application/octet-stream",
        size_bytes=len(content),
        sha256=uploaded["sha256"],
        provenance=provenance,
        parent_document_id=parent_document_id,
        uploaded_by_id=user.id,
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


def workspace_document(db: Session, workspace_id: uuid.UUID, document_id: uuid.UUID) -> Document:
    document = db.get(Document, document_id)
    if document is None or document.workspace_id != workspace_id:
        raise AppError("document_not_found", "Document was not found", 404)
    return document


@router.get("/documents/{document_id}/access", response_model=DocumentAccessResponse)
def access_document(
    workspace_id: uuid.UUID,
    document_id: uuid.UUID,
    _: Annotated[Membership, Depends(all_roles)],
    db: Annotated[Session, Depends(get_db)],
) -> DocumentAccessResponse:
    document = workspace_document(db, workspace_id, document_id)
    return DocumentAccessResponse(
        url=signed_download_url(
            document.cloudinary_public_id, document.resource_type, document.cloudinary_format
        ),
        expires_in=3600,
    )


@router.post("/documents/{document_id}/verify-integrity", response_model=IntegrityResponse)
def verify_document_integrity(
    workspace_id: uuid.UUID,
    document_id: uuid.UUID,
    user: CurrentUser,
    _: Annotated[
        Membership,
        Depends(
            require_workspace_roles(
                "party_admin", "operations", "legal_compliance", require_mfa=True
            )
        ),
    ],
    db: Annotated[Session, Depends(get_db)],
) -> IntegrityResponse:
    document = workspace_document(db, workspace_id, document_id)
    observed = remote_sha256(
        document.cloudinary_public_id,
        document.resource_type,
        document.cloudinary_format,
        get_settings().max_document_bytes,
    )
    matches = observed == document.sha256
    if not matches:
        document.status = "quarantined"
    db.add(
        EvidenceIntegrityCheck(
            document_id=document.id,
            checked_by_id=user.id,
            expected_sha256=document.sha256,
            observed_sha256=observed,
            matches=matches,
        )
    )
    db.commit()
    return IntegrityResponse(
        document_id=document.id,
        expected_sha256=document.sha256,
        observed_sha256=observed,
        matches=matches,
        status=document.status,
    )


@router.post("/submissions", response_model=SubmissionResponse, status_code=201)
def create_submission(
    workspace_id: uuid.UUID,
    payload: SubmissionCreate,
    user: CurrentUser,
    membership: Annotated[Membership, Depends(all_roles)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=100)],
) -> ResultSubmission:
    existing = db.scalar(
        select(ResultSubmission).where(
            ResultSubmission.workspace_id == workspace_id,
            ResultSubmission.idempotency_key == idempotency_key,
        )
    )
    if existing:
        return existing
    election = db.get(Election, payload.election_id)
    contest = db.get(Contest, payload.contest_id)
    node = db.get(GeographyNode, payload.geography_node_id)
    document = db.get(Document, payload.document_id)
    if not election or election.workspace_id != workspace_id or election.status != "active":
        raise AppError("invalid_election", "An active workspace election is required", 422)
    form_levels = {"EC8A": "polling_unit", "EC8B": "ward", "EC8C": "lga", "EC8D": "state"}
    if not contest or contest.election_id != election.id:
        raise AppError("invalid_contest", "Contest does not match the election", 422)
    if (
        not node
        or node.workspace_id != workspace_id
        or node.level != form_levels[payload.form_type]
    ):
        raise AppError(
            "invalid_geography", "Geography does not match the configured form level", 422
        )
    if not document or document.workspace_id != workspace_id or document.status != "available":
        raise AppError("invalid_document", "An available workspace document is required", 422)
    workspace = db.get(Workspace, workspace_id)
    # The single INEC account reports official results for every polling unit.
    if not (workspace and workspace.kind == "inec" and membership.role == "party_admin"):
        require_geography_scope(db, membership, node)
    candidate_ids = {item.candidate_id for item in payload.figures}
    valid_ids = set(
        db.scalars(
            select(Candidate.id).where(
                Candidate.contest_id == contest.id, Candidate.id.in_(candidate_ids)
            )
        ).all()
    )
    if len(valid_ids) != len(candidate_ids) or len(candidate_ids) != len(payload.figures):
        raise AppError(
            "invalid_figures", "Candidate figures must be unique and belong to the contest", 422
        )
    previous = db.get(ResultSubmission, payload.supersedes_id) if payload.supersedes_id else None
    if previous and (previous.workspace_id != workspace_id or previous.status == "superseded"):
        raise AppError(
            "invalid_superseded_submission", "Submission cannot supersede that record", 422
        )
    totals = payload.model_dump(
        include={
            "valid_votes",
            "rejected_ballots",
            "total_votes_cast",
            "accredited_voters",
            "registered_voters",
        }
    )
    snapshot = {
        "election": election.name,
        "contest": contest.name,
        "form_type": payload.form_type,
        "geography_level": node.level,
        "correction_reason": payload.correction_reason,
    }
    submission = ResultSubmission(
        workspace_id=workspace_id,
        election_id=election.id,
        contest_id=contest.id,
        geography_node_id=node.id,
        document_id=document.id,
        form_type=payload.form_type,
        version=(previous.version + 1) if previous else 1,
        supersedes_id=payload.supersedes_id,
        idempotency_key=idempotency_key,
        totals=totals,
        configuration_snapshot=snapshot,
        submitted_by_id=user.id,
    )
    db.add(submission)
    db.flush()
    db.add_all(
        [
            ResultFigure(
                submission_id=submission.id, candidate_id=item.candidate_id, votes=item.votes
            )
            for item in payload.figures
        ]
    )
    if previous:
        previous.status = "superseded"
    db.commit()
    db.refresh(submission)
    return submission


@router.get("/submissions", response_model=list[SubmissionResponse])
def list_submissions(
    workspace_id: uuid.UUID,
    _: Annotated[Membership, Depends(all_roles)],
    db: Annotated[Session, Depends(get_db)],
    election_id: uuid.UUID | None = None,
) -> list[ResultSubmission]:
    query = select(ResultSubmission).where(ResultSubmission.workspace_id == workspace_id)
    if election_id:
        query = query.where(ResultSubmission.election_id == election_id)
    return list(db.scalars(query.order_by(ResultSubmission.submitted_at.desc())).all())
