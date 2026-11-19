import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("cloudinary_public_id", "cloudinary_version"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    cloudinary_public_id: Mapped[str] = mapped_column(String(500), index=True)
    cloudinary_version: Mapped[str] = mapped_column(String(50))
    resource_type: Mapped[str] = mapped_column(String(20), default="image")
    cloudinary_format: Mapped[str] = mapped_column(String(20))
    secure_url: Mapped[str] = mapped_column(Text)
    original_filename: Mapped[str] = mapped_column(String(500))
    media_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    provenance: Mapped[str] = mapped_column(String(30))
    # How the file was produced, e.g. {"source": "camera", "captured_at": ...} for agent captures.
    capture_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="available")
    parent_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id")
    )
    uploaded_by_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ResultSubmission(Base):
    __tablename__ = "result_submissions"
    __table_args__ = (UniqueConstraint("workspace_id", "idempotency_key"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    election_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("elections.id"), index=True
    )
    contest_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contests.id"), index=True
    )
    geography_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("geography_nodes.id"), index=True
    )
    # Party submissions always carry their result-sheet evidence; INEC may type figures directly.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id"), nullable=True
    )
    form_type: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(30), default="submitted", index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("result_submissions.id")
    )
    idempotency_key: Mapped[str] = mapped_column(String(100))
    totals: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    configuration_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    submitted_by_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ResultFigure(Base):
    __tablename__ = "result_figures"
    __table_args__ = (UniqueConstraint("submission_id", "candidate_id"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    submission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("result_submissions.id", ondelete="CASCADE"), index=True
    )
    candidate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("candidates.id"))
    votes: Mapped[int] = mapped_column(Integer)
