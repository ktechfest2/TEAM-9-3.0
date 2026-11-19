import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.organisation import NodeSummary

Status = Literal["match", "mismatch", "awaiting_inec", "awaiting_party", "not_reported"]


class ReportedFigures(BaseModel):
    submission_id: uuid.UUID
    document_id: uuid.UUID
    version: int
    submitted_at: datetime
    totals: dict[str, int]
    votes: dict[str, int]
    correction_reason: str | None = None
    document_url: str | None = None


class DifferenceOut(BaseModel):
    field: str
    label: str
    party: int | None
    inec: int | None
    delta: int | None


class PartyReport(BaseModel):
    workspace_id: uuid.UUID
    party_code: str
    party_name: str
    status: Status
    result: ReportedFigures | None
    differences: list[DifferenceOut]


class UnitCrossCheck(BaseModel):
    node: NodeSummary
    status: Status
    inec: ReportedFigures | None
    reports: list[PartyReport]


class CrossCheckSummary(BaseModel):
    total_units: int
    match: int = 0
    mismatch: int = 0
    awaiting_inec: int = 0
    awaiting_party: int = 0
    not_reported: int = 0


class CrossCheckResponse(BaseModel):
    viewer: Literal["party", "inec"]
    election_id: uuid.UUID
    inec_connected: bool
    summary: CrossCheckSummary
    units: list[UnitCrossCheck]
