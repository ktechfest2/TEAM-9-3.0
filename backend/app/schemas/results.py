import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    original_filename: str
    media_type: str
    size_bytes: int
    sha256: str
    provenance: str
    status: str
    capture_metadata: dict | None = None
    parent_document_id: uuid.UUID | None
    created_at: datetime


class DocumentAccessResponse(BaseModel):
    url: str
    expires_in: int


class IntegrityResponse(BaseModel):
    document_id: uuid.UUID
    expected_sha256: str
    observed_sha256: str
    matches: bool
    status: str


class FigureInput(BaseModel):
    candidate_id: uuid.UUID
    votes: int = Field(ge=0)


class SubmissionCreate(BaseModel):
    election_id: uuid.UUID
    contest_id: uuid.UUID
    geography_node_id: uuid.UUID
    # Required for party accounts; the INEC account may type figures without a sheet.
    document_id: uuid.UUID | None = None
    form_type: Literal["EC8A", "EC8B", "EC8C", "EC8D"]
    figures: list[FigureInput] = Field(min_length=1)
    valid_votes: int = Field(ge=0)
    rejected_ballots: int = Field(ge=0)
    total_votes_cast: int = Field(ge=0)
    accredited_voters: int | None = Field(default=None, ge=0)
    registered_voters: int | None = Field(default=None, ge=0)
    supersedes_id: uuid.UUID | None = None
    # Why a submission replaces an earlier one (e.g. INEC confirming the correct figure).
    correction_reason: str | None = Field(default=None, min_length=3, max_length=500)

    @model_validator(mode="after")
    def validate_totals(self):
        if self.supersedes_id and not self.correction_reason:
            raise ValueError("a correction_reason is required when replacing a submission")
        vote_sum = sum(item.votes for item in self.figures)
        if vote_sum != self.valid_votes:
            raise ValueError("candidate votes must equal valid_votes")
        if self.valid_votes + self.rejected_ballots != self.total_votes_cast:
            raise ValueError("valid_votes plus rejected_ballots must equal total_votes_cast")
        if self.accredited_voters is not None and self.total_votes_cast > self.accredited_voters:
            raise ValueError("total_votes_cast cannot exceed accredited_voters")
        return self


class SubmissionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    workspace_id: uuid.UUID
    election_id: uuid.UUID
    contest_id: uuid.UUID
    geography_node_id: uuid.UUID
    document_id: uuid.UUID | None
    form_type: str
    status: str
    version: int
    supersedes_id: uuid.UUID | None
    totals: dict
    configuration_snapshot: dict
    submitted_by_id: uuid.UUID
    submitted_at: datetime
