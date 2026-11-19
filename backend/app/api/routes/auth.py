import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import (
    create_access_token,
    create_mfa_challenge,
    decode_mfa_challenge,
    hash_password,
    hash_token,
    new_totp_secret,
    provisioning_uri,
    random_token,
    verify_password,
    verify_totp,
)
from app.db.session import get_db
from app.models.identity import Invitation, MFARecoveryCode, RefreshSession, User
from app.models.organisation import GeographyAssignment, Membership
from app.schemas.identity import (
    InvitationAccept,
    LoginRequest,
    MFAChallengeRequest,
    MFACodeRequest,
    MFAConfirmResponse,
    MFADisableRequest,
    MFASetupResponse,
    RefreshRequest,
    TokenResponse,
    UserResponse,
)

router = APIRouter()


def issue_tokens(db: Session, user: User, request: Request, *, mfa: bool) -> TokenResponse:
    settings = get_settings()
    refresh = random_token()
    access, expires = create_access_token(user.id, mfa=mfa)
    db.add(
        RefreshSession(
            user_id=user.id,
            token_hash=hash_token(refresh),
            user_agent=request.headers.get("user-agent"),
            ip_address=request.client.host if request.client else None,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_days),
            mfa_verified=mfa,
        )
    )
    db.commit()
    return TokenResponse(access_token=access, refresh_token=refresh, expires_in=expires)


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest, request: Request, db: Annotated[Session, Depends(get_db)]
) -> TokenResponse:
    user = db.scalar(select(User).where(User.email == payload.email))
    if (
        user is None
        or not user.is_active
        or not verify_password(payload.password, user.password_hash)
    ):
        raise AppError("invalid_credentials", "Email or password is incorrect", 401)
    if user.mfa_enabled:
        return TokenResponse(status="mfa_required", challenge_token=create_mfa_challenge(user.id))
    response = issue_tokens(db, user, request, mfa=False)
    if user.is_platform_admin:
        response.status = "mfa_setup_required"
    return response


@router.post("/mfa/challenge", response_model=TokenResponse)
def mfa_challenge(
    payload: MFAChallengeRequest, request: Request, db: Annotated[Session, Depends(get_db)]
) -> TokenResponse:
    user = db.get(User, decode_mfa_challenge(payload.challenge_token))
    if user is None or not user.mfa_secret:
        raise AppError("mfa_unavailable", "MFA is not configured", 409)
    valid = verify_totp(user.mfa_secret, payload.code)
    if not valid:
        recovery = db.scalar(
            select(MFARecoveryCode).where(
                MFARecoveryCode.user_id == user.id,
                MFARecoveryCode.code_hash == hash_token(payload.code),
                MFARecoveryCode.used_at.is_(None),
            )
        )
        if recovery:
            recovery.used_at = datetime.now(UTC)
            valid = True
    if not valid:
        raise AppError("invalid_mfa_code", "MFA code is invalid", 401)
    return issue_tokens(db, user, request, mfa=True)


@router.post("/refresh", response_model=TokenResponse)
def refresh(
    payload: RefreshRequest, request: Request, db: Annotated[Session, Depends(get_db)]
) -> TokenResponse:
    session = db.scalar(
        select(RefreshSession).where(RefreshSession.token_hash == hash_token(payload.refresh_token))
    )
    now = datetime.now(UTC)
    if session is None or session.revoked_at or session.expires_at <= now:
        raise AppError("invalid_refresh_token", "Refresh token is invalid or expired", 401)
    session.revoked_at = now
    session.last_used_at = now
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise AppError("inactive_user", "User is inactive", 401)
    return issue_tokens(db, user, request, mfa=session.mfa_verified)


@router.post("/logout", status_code=204)
def logout(payload: RefreshRequest, db: Annotated[Session, Depends(get_db)]) -> None:
    session = db.scalar(
        select(RefreshSession).where(RefreshSession.token_hash == hash_token(payload.refresh_token))
    )
    if session and not session.revoked_at:
        session.revoked_at = datetime.now(UTC)
        db.commit()


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> User:
    return user


@router.post("/mfa/setup", response_model=MFASetupResponse)
def setup_mfa(user: CurrentUser, db: Annotated[Session, Depends(get_db)]) -> MFASetupResponse:
    if user.mfa_enabled:
        raise AppError("mfa_already_enabled", "MFA is already enabled", 409)
    user.mfa_secret = new_totp_secret()
    db.commit()
    return MFASetupResponse(
        secret=user.mfa_secret, provisioning_uri=provisioning_uri(user.mfa_secret, user.email)
    )


@router.post("/mfa/confirm", response_model=MFAConfirmResponse)
def confirm_mfa(
    payload: MFACodeRequest, user: CurrentUser, db: Annotated[Session, Depends(get_db)]
) -> MFAConfirmResponse:
    if not user.mfa_secret or not verify_totp(user.mfa_secret, payload.code):
        raise AppError("invalid_mfa_code", "MFA code is invalid", 422)
    raw_codes = [secrets.token_hex(5) for _ in range(8)]
    db.execute(delete(MFARecoveryCode).where(MFARecoveryCode.user_id == user.id))
    db.add_all([MFARecoveryCode(user_id=user.id, code_hash=hash_token(code)) for code in raw_codes])
    user.mfa_enabled = True
    db.commit()
    return MFAConfirmResponse(recovery_codes=raw_codes)


@router.post("/mfa/disable", status_code=204)
def disable_mfa(
    payload: MFADisableRequest, user: CurrentUser, db: Annotated[Session, Depends(get_db)]
) -> None:
    if not verify_password(payload.password, user.password_hash):
        raise AppError("invalid_credentials", "Password is incorrect", 401)
    if not user.mfa_secret or not verify_totp(user.mfa_secret, payload.code):
        raise AppError("invalid_mfa_code", "MFA code is invalid", 422)
    user.mfa_enabled = False
    user.mfa_secret = None
    db.execute(delete(MFARecoveryCode).where(MFARecoveryCode.user_id == user.id))
    db.execute(delete(RefreshSession).where(RefreshSession.user_id == user.id))
    db.commit()


@router.post("/sessions/revoke-all", status_code=204)
def revoke_all_sessions(user: CurrentUser, db: Annotated[Session, Depends(get_db)]) -> None:
    now = datetime.now(UTC)
    sessions = db.scalars(
        select(RefreshSession).where(
            RefreshSession.user_id == user.id, RefreshSession.revoked_at.is_(None)
        )
    ).all()
    for session in sessions:
        session.revoked_at = now
    db.commit()


@router.post("/invitations/accept", response_model=UserResponse, status_code=201)
def accept_invitation(payload: InvitationAccept, db: Annotated[Session, Depends(get_db)]) -> User:
    invitation = db.scalar(
        select(Invitation).where(Invitation.token_hash == hash_token(payload.token))
    )
    if invitation is None or invitation.accepted_at or invitation.expires_at <= datetime.now(UTC):
        raise AppError("invalid_invitation", "Invitation is invalid or expired", 410)
    if db.scalar(select(User.id).where(User.email == invitation.email)):
        raise AppError("email_in_use", "A user with this email already exists", 409)
    user = User(
        email=invitation.email,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.flush()
    membership = Membership(
        workspace_id=invitation.workspace_id, user_id=user.id, role=invitation.role
    )
    db.add(membership)
    db.flush()
    if invitation.geography_node_id:
        # The inviting administrator picked this polling unit when adding the agent.
        db.add(
            GeographyAssignment(
                membership_id=membership.id,
                geography_node_id=invitation.geography_node_id,
                assigned_by_id=invitation.invited_by_id,
            )
        )
    invitation.accepted_at = datetime.now(UTC)
    db.commit()
    db.refresh(user)
    return user
