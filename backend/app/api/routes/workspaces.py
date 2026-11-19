import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, File, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser, mfa_satisfied, require_workspace_roles
from app.core.errors import AppError
from app.core.security import hash_token, random_token
from app.db.session import get_db
from app.models.elections import Candidate, Contest, Election, PoliticalParty
from app.models.identity import Invitation, RefreshSession, User
from app.models.organisation import GeographyAssignment, GeographyNode, Membership, Workspace
from app.schemas.organisation import (
    BallotCandidate,
    BallotContest,
    BallotElection,
    CoverageSummary,
    GeographyAssignmentCreate,
    GeographyAssignmentResponse,
    GeographyNodeResponse,
    InvitationCreate,
    InvitationResponse,
    MembershipResponse,
    MembershipUpdate,
    NodeSummary,
    PendingInvitationResponse,
    PeopleResponse,
    PersonResponse,
    WorkspaceContext,
    WorkspaceCreate,
    WorkspaceResponse,
)
from app.services.geography_import import LEVEL_PARENT, validate_geography_csv

router = APIRouter()
admin = Depends(require_workspace_roles("party_admin", require_mfa=True))


@router.get("/workspaces", response_model=list[WorkspaceResponse])
def list_workspaces(user: CurrentUser, db: Annotated[Session, Depends(get_db)]) -> list[Workspace]:
    if user.is_platform_admin:
        return list(db.scalars(select(Workspace).order_by(Workspace.created_at.desc())).all())
    return list(
        db.scalars(
            select(Workspace)
            .join(Membership)
            .where(Membership.user_id == user.id, Membership.is_active.is_(True))
        ).all()
    )


@router.post("/workspaces", response_model=WorkspaceResponse, status_code=201)
def create_workspace(
    payload: WorkspaceCreate,
    request: Request,
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Workspace:
    if not user.is_platform_admin or not mfa_satisfied(request):
        raise AppError("forbidden", "A platform administrator with MFA is required", 403)
    if payload.kind == "inec" and db.scalar(select(Workspace.id).where(Workspace.kind == "inec")):
        raise AppError("inec_account_exists", "The INEC account already exists", 409)
    if payload.kind == "party" and db.scalar(
        select(Workspace.id).where(
            Workspace.kind == "party",
            func.upper(Workspace.party_code) == payload.party_code.strip().upper(),
        )
    ):
        raise AppError("party_account_exists", "This political party already has an account", 409)
    workspace = Workspace(**payload.model_dump(), created_by_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(Membership(workspace_id=workspace.id, user_id=user.id, role="party_admin"))
    db.commit()
    db.refresh(workspace)
    return workspace


@router.get("/workspaces/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(
    workspace_id: uuid.UUID,
    _: Annotated[
        Membership,
        Depends(
            require_workspace_roles(
                "party_admin",
                "pu_agent",
                "ward_agent",
                "collation_officer",
                "operations",
                "legal_compliance",
            )
        ),
    ],
    db: Annotated[Session, Depends(get_db)],
) -> Workspace:
    workspace = db.get(Workspace, workspace_id)
    if workspace is None:
        raise AppError("workspace_not_found", "Workspace was not found", 404)
    return workspace


@router.post(
    "/workspaces/{workspace_id}/invitations",
    response_model=InvitationResponse,
    status_code=201,
    dependencies=[admin],
)
def invite_member(
    workspace_id: uuid.UUID,
    payload: InvitationCreate,
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    if payload.geography_node_id is not None:
        node = db.get(GeographyNode, payload.geography_node_id)
        if node is None or node.workspace_id != workspace_id:
            raise AppError("invalid_polling_unit", "Polling unit is not in this account", 422)
        if payload.role == "pu_agent" and node.level != "polling_unit":
            raise AppError("invalid_polling_unit", "Agents must be assigned a polling unit", 422)
    raw = random_token()
    invitation = Invitation(
        workspace_id=workspace_id,
        email=payload.email.strip().lower(),
        role=payload.role,
        geography_node_id=payload.geography_node_id,
        token_hash=hash_token(raw),
        invited_by_id=user.id,
        expires_at=datetime.now(UTC) + timedelta(days=3),
    )
    db.add(invitation)
    db.commit()
    db.refresh(invitation)
    return InvitationResponse(
        id=invitation.id,
        email=invitation.email,
        role=invitation.role,
        geography_node_id=invitation.geography_node_id,
        expires_at=invitation.expires_at,
        invitation_token=raw,
    )


@router.get(
    "/workspaces/{workspace_id}/members",
    response_model=list[MembershipResponse],
    dependencies=[admin],
)
def list_members(
    workspace_id: uuid.UUID, db: Annotated[Session, Depends(get_db)]
) -> list[Membership]:
    return list(
        db.scalars(
            select(Membership)
            .where(Membership.workspace_id == workspace_id)
            .order_by(Membership.created_at)
        ).all()
    )


@router.patch(
    "/workspaces/{workspace_id}/members/{membership_id}",
    response_model=MembershipResponse,
    dependencies=[admin],
)
def update_member(
    workspace_id: uuid.UUID,
    membership_id: uuid.UUID,
    payload: MembershipUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> Membership:
    membership = db.get(Membership, membership_id)
    if membership is None or membership.workspace_id != workspace_id:
        raise AppError("membership_not_found", "Membership was not found", 404)
    for key, value in payload.model_dump(exclude_none=True).items():
        setattr(membership, key, value)
    if payload.is_active is False:
        sessions = db.scalars(
            select(RefreshSession).where(
                RefreshSession.user_id == membership.user_id,
                RefreshSession.revoked_at.is_(None),
            )
        ).all()
        for session in sessions:
            session.revoked_at = datetime.now(UTC)
    db.commit()
    db.refresh(membership)
    return membership


@router.post(
    "/workspaces/{workspace_id}/geography/import",
    response_model=list[GeographyNodeResponse],
    dependencies=[admin],
)
async def import_geography(
    workspace_id: uuid.UUID,
    db: Annotated[Session, Depends(get_db)],
    file: Annotated[UploadFile, File()],
) -> list[GeographyNode]:
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise AppError("file_too_large", "Hierarchy import may not exceed 10 MB", 413)
    result = validate_geography_csv(content)
    if result.errors:
        raise AppError(
            "invalid_geography_import", "Hierarchy validation failed", 422, result.errors
        )
    created: list[GeographyNode] = []
    by_key: dict[tuple[str, str], GeographyNode] = {}
    for level in ("state", "lga", "ward", "polling_unit"):
        for row in (item for item in result.rows if item["level"] == level):
            parent_level = LEVEL_PARENT[level]
            parent = by_key.get((parent_level, row["parent_code"])) if parent_level else None
            node = GeographyNode(
                workspace_id=workspace_id,
                parent_id=parent.id if parent else None,
                level=level,
                code=row["code"],
                name=row["name"],
            )
            db.add(node)
            db.flush()
            by_key[(level, row["code"])] = node
            created.append(node)
    db.commit()
    return created


@router.get("/workspaces/{workspace_id}/geography", response_model=list[GeographyNodeResponse])
def list_geography(
    workspace_id: uuid.UUID,
    _: Annotated[
        Membership,
        Depends(
            require_workspace_roles(
                "party_admin",
                "pu_agent",
                "ward_agent",
                "collation_officer",
                "operations",
                "legal_compliance",
            )
        ),
    ],
    db: Annotated[Session, Depends(get_db)],
    level: str | None = None,
    parent_id: uuid.UUID | None = None,
) -> list[GeographyNode]:
    query = select(GeographyNode).where(GeographyNode.workspace_id == workspace_id)
    if level:
        query = query.where(GeographyNode.level == level)
    if parent_id:
        query = query.where(GeographyNode.parent_id == parent_id)
    return list(db.scalars(query.order_by(GeographyNode.code)).all())


@router.post(
    "/workspaces/{workspace_id}/assignments",
    response_model=GeographyAssignmentResponse,
    status_code=201,
    dependencies=[admin],
)
def create_assignment(
    workspace_id: uuid.UUID,
    payload: GeographyAssignmentCreate,
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> GeographyAssignment:
    membership = db.get(Membership, payload.membership_id)
    node = db.get(GeographyNode, payload.geography_node_id)
    if (
        membership is None
        or node is None
        or membership.workspace_id != workspace_id
        or node.workspace_id != workspace_id
    ):
        raise AppError(
            "invalid_assignment", "Membership and geography must belong to this workspace", 422
        )
    assignment = GeographyAssignment(**payload.model_dump(), assigned_by_id=user.id)
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return assignment


@router.post(
    "/workspaces/{workspace_id}/activate", response_model=WorkspaceResponse, dependencies=[admin]
)
def activate_workspace(
    workspace_id: uuid.UUID, db: Annotated[Session, Depends(get_db)]
) -> Workspace:
    workspace = db.get(Workspace, workspace_id)
    polling_units = (
        db.scalar(
            select(func.count())
            .select_from(GeographyNode)
            .where(
                GeographyNode.workspace_id == workspace_id, GeographyNode.level == "polling_unit"
            )
        )
        or 0
    )
    admins = (
        db.scalar(
            select(func.count())
            .select_from(Membership)
            .where(
                Membership.workspace_id == workspace_id,
                Membership.role == "party_admin",
                Membership.is_active.is_(True),
            )
        )
        or 0
    )
    if not polling_units or not admins:
        raise AppError(
            "workspace_not_ready",
            "Workspace requires an administrator and polling-unit hierarchy",
            409,
        )
    workspace.status = "active"
    db.commit()
    db.refresh(workspace)
    return workspace


@router.get("/workspaces/{workspace_id}/coverage", response_model=CoverageSummary)
def coverage(
    workspace_id: uuid.UUID,
    _: Annotated[
        Membership,
        Depends(require_workspace_roles("party_admin", "operations", "legal_compliance")),
    ],
    db: Annotated[Session, Depends(get_db)],
) -> CoverageSummary:
    counts = {
        level: db.scalar(
            select(func.count())
            .select_from(GeographyNode)
            .where(GeographyNode.workspace_id == workspace_id, GeographyNode.level == level)
        )
        or 0
        for level in ("state", "lga", "ward", "polling_unit")
    }
    return CoverageSummary(
        states=counts["state"],
        lgas=counts["lga"],
        wards=counts["ward"],
        polling_units=counts["polling_unit"],
        active_members=db.scalar(
            select(func.count())
            .select_from(Membership)
            .where(Membership.workspace_id == workspace_id, Membership.is_active.is_(True))
        )
        or 0,
        assignments=db.scalar(
            select(func.count())
            .select_from(GeographyAssignment)
            .join(Membership)
            .where(Membership.workspace_id == workspace_id)
        )
        or 0,
    )


ALL_ROLES = (
    "party_admin",
    "pu_agent",
    "ward_agent",
    "collation_officer",
    "operations",
    "legal_compliance",
)


def node_summary(node: GeographyNode) -> NodeSummary:
    path: list[str] = []
    current = node.parent
    while current is not None:
        path.insert(0, current.name)
        current = current.parent
    return NodeSummary(id=node.id, level=node.level, code=node.code, name=node.name, path=path)


@router.get("/workspaces/{workspace_id}/people", response_model=PeopleResponse)
def list_people(
    workspace_id: uuid.UUID,
    _: Annotated[Membership, Depends(require_workspace_roles("party_admin", "operations"))],
    db: Annotated[Session, Depends(get_db)],
) -> PeopleResponse:
    """Members with their assigned polling units, plus invitations not yet accepted."""
    rows = db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.workspace_id == workspace_id)
        .order_by(Membership.created_at)
    ).all()
    assignments = db.execute(
        select(GeographyAssignment.membership_id, GeographyNode)
        .join(GeographyNode, GeographyNode.id == GeographyAssignment.geography_node_id)
        .join(Membership, Membership.id == GeographyAssignment.membership_id)
        .where(Membership.workspace_id == workspace_id)
    ).all()
    by_member: dict[uuid.UUID, list[NodeSummary]] = {}
    for membership_id, node in assignments:
        by_member.setdefault(membership_id, []).append(node_summary(node))
    pending = db.scalars(
        select(Invitation)
        .where(
            Invitation.workspace_id == workspace_id,
            Invitation.accepted_at.is_(None),
            Invitation.expires_at > datetime.now(UTC),
        )
        .order_by(Invitation.created_at.desc())
    ).all()
    return PeopleResponse(
        members=[
            PersonResponse(
                membership_id=m.id,
                user_id=u.id,
                full_name=u.full_name,
                email=u.email,
                role=m.role,
                is_active=m.is_active,
                assignments=by_member.get(m.id, []),
            )
            for m, u in rows
        ],
        pending=[
            PendingInvitationResponse(
                id=i.id,
                email=i.email,
                role=i.role,
                polling_unit=(
                    node_summary(db.get(GeographyNode, i.geography_node_id))
                    if i.geography_node_id
                    else None
                ),
                expires_at=i.expires_at,
            )
            for i in pending
        ],
    )


@router.get("/workspaces/{workspace_id}/context", response_model=WorkspaceContext)
def workspace_context(
    workspace_id: uuid.UUID,
    membership: Annotated[Membership, Depends(require_workspace_roles(*ALL_ROLES))],
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceContext:
    """Everything a signed-in member needs: their role, assigned units, and the ballot."""
    workspace = db.get(Workspace, workspace_id)
    nodes = db.scalars(
        select(GeographyNode)
        .join(GeographyAssignment, GeographyAssignment.geography_node_id == GeographyNode.id)
        .where(GeographyAssignment.membership_id == membership.id)
        .order_by(GeographyNode.code)
    ).all()
    elections = db.scalars(
        select(Election)
        .where(Election.workspace_id == workspace_id)
        .order_by(Election.election_date.desc())
    ).all()
    ballot: list[BallotElection] = []
    for election in elections:
        contests = db.scalars(
            select(Contest).where(Contest.election_id == election.id).order_by(Contest.name)
        ).all()
        items = []
        for contest in contests:
            candidates = db.execute(
                select(Candidate, PoliticalParty)
                .join(PoliticalParty, PoliticalParty.id == Candidate.party_id)
                .where(Candidate.contest_id == contest.id)
                .order_by(Candidate.ballot_code)
            ).all()
            items.append(
                BallotContest(
                    id=contest.id,
                    name=contest.name,
                    office=contest.office,
                    form_type=contest.form_type,
                    geography_level=contest.geography_level,
                    candidates=[
                        BallotCandidate(
                            id=c.id,
                            name=c.name,
                            ballot_code=c.ballot_code,
                            party_code=p.code,
                            party_name=p.name,
                        )
                        for c, p in candidates
                    ],
                )
            )
        ballot.append(
            BallotElection(
                id=election.id,
                name=election.name,
                election_type=election.election_type,
                election_date=election.election_date.isoformat(),
                status=election.status,
                contests=items,
            )
        )
    return WorkspaceContext(
        workspace=WorkspaceResponse.model_validate(workspace),
        role=membership.role,
        can_submit_anywhere=workspace.kind == "inec" and membership.role == "party_admin",
        assignments=[node_summary(n) for n in nodes],
        elections=ballot,
    )
