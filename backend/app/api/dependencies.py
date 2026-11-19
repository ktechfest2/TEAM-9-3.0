import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.identity import User
from app.models.organisation import GeographyAssignment, GeographyNode, Membership

bearer = HTTPBearer(auto_error=False)


def get_current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise AppError("not_authenticated", "Authentication is required", 401)
    payload = decode_access_token(credentials.credentials)
    user = db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise AppError("inactive_user", "User is inactive or unavailable", 401)
    request.state.user_id = user.id
    request.state.mfa = bool(payload.get("mfa"))
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_workspace_roles(*roles: str, require_mfa: bool = False) -> Callable:
    def dependency(
        request: Request,
        workspace_id: uuid.UUID,
        user: CurrentUser,
        db: Annotated[Session, Depends(get_db)],
    ) -> Membership:
        membership = db.scalar(
            select(Membership).where(
                Membership.workspace_id == workspace_id,
                Membership.user_id == user.id,
                Membership.is_active.is_(True),
            )
        )
        if membership is None or membership.role not in roles:
            raise AppError("forbidden", "You do not have permission in this workspace", 403)
        if require_mfa and get_settings().enforce_mfa and not getattr(request.state, "mfa", False):
            raise AppError("mfa_required", "Multi-factor authentication is required", 403)
        return membership

    return dependency


def require_geography_scope(
    db: Session, membership: Membership, node: GeographyNode
) -> GeographyAssignment:
    assignments = db.scalars(
        select(GeographyAssignment).where(
            GeographyAssignment.membership_id == membership.id,
            GeographyAssignment.can_submit.is_(True),
        )
    ).all()
    current = node
    permitted_ids = {assignment.geography_node_id for assignment in assignments}
    while current is not None:
        if current.id in permitted_ids:
            return next(item for item in assignments if item.geography_node_id == current.id)
        current = current.parent
    raise AppError(
        "geography_scope_forbidden", "Submission is outside your assigned geography", 403
    )


def mfa_satisfied(request: Request) -> bool:
    """True when the session passed MFA, or MFA enforcement is relaxed (never in production)."""
    return bool(getattr(request.state, "mfa", False)) or not get_settings().enforce_mfa
