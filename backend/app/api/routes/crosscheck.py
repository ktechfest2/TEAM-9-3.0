import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import require_workspace_roles
from app.api.routes.workspaces import node_summary
from app.core.errors import AppError
from app.db.session import get_db
from app.models.elections import Election
from app.models.organisation import GeographyAssignment, GeographyNode, Membership, Workspace
from app.models.results import Document
from app.schemas.crosscheck import (
    CrossCheckResponse,
    CrossCheckSummary,
    DifferenceOut,
    PartyReport,
    ReportedFigures,
    UnitCrossCheck,
)
from app.services import crosscheck as cc
from app.services.cloudinary_storage import signed_download_url

router = APIRouter(prefix="/workspaces/{workspace_id}")
viewers = require_workspace_roles(
    "party_admin", "operations", "legal_compliance", "pu_agent", require_mfa=False
)


def _figures(db: Session, item: cc.Reported | None, with_url: bool) -> ReportedFigures | None:
    if item is None:
        return None
    url = None
    if with_url:
        document = db.get(Document, item.document_id)
        if document is not None:
            url = signed_download_url(
                document.cloudinary_public_id, document.resource_type, document.cloudinary_format
            )
    return ReportedFigures(
        submission_id=item.submission_id,
        document_id=item.document_id,
        version=item.version,
        submitted_at=item.submitted_at,
        totals=item.totals,
        votes=item.votes,
        correction_reason=item.correction_reason,
        document_url=url,
    )


def _diffs(diffs: list[cc.Difference]) -> list[DifferenceOut]:
    return [
        DifferenceOut(field=d.field, label=d.label, party=d.party, inec=d.inec, delta=d.delta)
        for d in diffs
    ]


def _build(
    db: Session,
    workspace: Workspace,
    membership: Membership,
    election: Election,
    only_node: uuid.UUID | None,
    with_urls: bool,
) -> CrossCheckResponse:
    nodes = db.scalars(
        select(GeographyNode)
        .where(
            GeographyNode.workspace_id == workspace.id,
            GeographyNode.level == "polling_unit",
            GeographyNode.is_active.is_(True),
        )
        .order_by(GeographyNode.code)
    ).all()
    if membership.role == "pu_agent":
        # Agents only ever see the units they were assigned.
        allowed = set(
            db.scalars(
                select(GeographyAssignment.geography_node_id).where(
                    GeographyAssignment.membership_id == membership.id
                )
            ).all()
        )
        nodes = [n for n in nodes if n.id in allowed]
    if only_node is not None:
        nodes = [n for n in nodes if n.id == only_node]
        if not nodes:
            raise AppError("polling_unit_not_found", "Polling unit was not found", 404)

    viewer = "inec" if workspace.kind == "inec" else "party"
    inec_ws = workspace if viewer == "inec" else cc.inec_workspace(db)
    inec_election = (
        election
        if viewer == "inec"
        else (cc.matching_election(db, election, inec_ws.id) if inec_ws else None)
    )
    inec_results = cc.latest_unit_results(db, inec_ws.id, inec_election.id) if inec_election else {}

    # Party reports: the viewer's own account, or every party account when INEC is viewing.
    party_sources: list[tuple[Workspace, dict[str, cc.Reported]]] = []
    if viewer == "party":
        party_sources.append((workspace, cc.latest_unit_results(db, workspace.id, election.id)))
    else:
        for party_ws in db.scalars(select(Workspace).where(Workspace.kind == "party")).all():
            party_election = cc.matching_election(db, election, party_ws.id)
            if party_election:
                party_sources.append(
                    (party_ws, cc.latest_unit_results(db, party_ws.id, party_election.id))
                )

    summary = CrossCheckSummary(total_units=len(nodes))
    units: list[UnitCrossCheck] = []
    for node in nodes:
        inec_item = inec_results.get(node.code)
        reports: list[PartyReport] = []
        for party_ws, results in party_sources:
            mine = results.get(node.code)
            if viewer == "inec" and mine is None:
                continue
            status, diffs = cc.compare(mine, inec_item)
            reports.append(
                PartyReport(
                    workspace_id=party_ws.id,
                    party_code=party_ws.party_code,
                    party_name=party_ws.name,
                    status=status,
                    result=_figures(db, mine, with_urls),
                    differences=_diffs(diffs),
                )
            )
        if viewer == "party":
            status = reports[0].status
        else:
            status = cc.unit_status([r.status for r in reports], inec_item is not None)
        setattr(summary, status, getattr(summary, status) + 1)
        units.append(
            UnitCrossCheck(
                node=node_summary(node),
                status=status,
                inec=_figures(db, inec_item, with_urls),
                reports=reports,
            )
        )
    return CrossCheckResponse(
        viewer=viewer,
        election_id=election.id,
        inec_connected=inec_election is not None,
        summary=summary,
        units=units,
    )


def _context(
    db: Session, workspace_id: uuid.UUID, election_id: uuid.UUID
) -> tuple[Workspace, Election]:
    workspace = db.get(Workspace, workspace_id)
    election = db.get(Election, election_id)
    if workspace is None or election is None or election.workspace_id != workspace_id:
        raise AppError("election_not_found", "Election was not found", 404)
    return workspace, election


@router.get("/crosscheck", response_model=CrossCheckResponse)
def crosscheck(
    workspace_id: uuid.UUID,
    election_id: uuid.UUID,
    membership: Annotated[Membership, Depends(viewers)],
    db: Annotated[Session, Depends(get_db)],
) -> CrossCheckResponse:
    """Party agents' polling-unit results compared with INEC's, unit by unit."""
    workspace, election = _context(db, workspace_id, election_id)
    return _build(db, workspace, membership, election, None, with_urls=False)


@router.get("/crosscheck/units/{node_id}", response_model=UnitCrossCheck)
def crosscheck_unit(
    workspace_id: uuid.UUID,
    node_id: uuid.UUID,
    election_id: uuid.UUID,
    membership: Annotated[Membership, Depends(viewers)],
    db: Annotated[Session, Depends(get_db)],
) -> UnitCrossCheck:
    """One unit side by side, with short-lived links to each result-sheet photo."""
    workspace, election = _context(db, workspace_id, election_id)
    return _build(db, workspace, membership, election, node_id, with_urls=True).units[0]
