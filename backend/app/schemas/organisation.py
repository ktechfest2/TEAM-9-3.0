import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

RoleName = Literal[
    "party_admin", "pu_agent", "ward_agent", "collation_officer", "operations", "legal_compliance"
]


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    party_code: str = Field(min_length=1, max_length=30)
    kind: Literal["party", "inec"] = "party"
    timezone: str = "Africa/Lagos"
    branding: dict[str, Any] = Field(default_factory=dict)


class WorkspaceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    party_code: str
    kind: str
    timezone: str
    status: str
    branding: dict[str, Any]
    created_at: datetime


class MembershipResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    workspace_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    is_active: bool


class MembershipUpdate(BaseModel):
    role: RoleName | None = None
    is_active: bool | None = None


class InvitationCreate(BaseModel):
    email: str
    role: RoleName
    # Required for polling-unit agents: the unit they will report from.
    geography_node_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def agents_need_a_polling_unit(self):
        if self.role == "pu_agent" and self.geography_node_id is None:
            raise ValueError("Pick the polling unit this agent will report from")
        return self


class InvitationResponse(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    geography_node_id: uuid.UUID | None = None
    expires_at: datetime
    invitation_token: str


class GeographyNodeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    workspace_id: uuid.UUID
    parent_id: uuid.UUID | None
    level: str
    code: str
    name: str
    metadata_json: dict[str, Any]
    is_active: bool


class GeographyAssignmentCreate(BaseModel):
    membership_id: uuid.UUID
    geography_node_id: uuid.UUID
    can_submit: bool = True
    explicit_override: bool = False
    override_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def require_override_reason(self):
        if self.explicit_override and not self.override_reason:
            raise ValueError("override_reason is required for an explicit override")
        return self


class GeographyAssignmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    membership_id: uuid.UUID
    geography_node_id: uuid.UUID
    can_submit: bool
    explicit_override: bool
    override_reason: str | None


class CoverageSummary(BaseModel):
    states: int
    lgas: int
    wards: int
    polling_units: int
    active_members: int
    assignments: int


class NodeSummary(BaseModel):
    id: uuid.UUID
    level: str
    code: str
    name: str
    path: list[str] = Field(default_factory=list)


class PersonResponse(BaseModel):
    membership_id: uuid.UUID
    user_id: uuid.UUID
    full_name: str
    email: str
    role: str
    is_active: bool
    assignments: list[NodeSummary]


class PendingInvitationResponse(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    polling_unit: NodeSummary | None
    expires_at: datetime


class PeopleResponse(BaseModel):
    members: list[PersonResponse]
    pending: list[PendingInvitationResponse]


class BallotCandidate(BaseModel):
    id: uuid.UUID
    name: str
    ballot_code: str
    party_code: str
    party_name: str


class BallotContest(BaseModel):
    id: uuid.UUID
    name: str
    office: str
    form_type: str
    geography_level: str
    candidates: list[BallotCandidate]


class BallotElection(BaseModel):
    id: uuid.UUID
    name: str
    election_type: str
    election_date: str
    status: str
    contests: list[BallotContest]


class WorkspaceContext(BaseModel):
    workspace: WorkspaceResponse
    role: str
    can_submit_anywhere: bool
    assignments: list[NodeSummary]
    elections: list[BallotElection]
