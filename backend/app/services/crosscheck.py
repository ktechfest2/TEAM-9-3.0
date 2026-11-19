"""Polling-unit cross-check: each party's agent-reported EC8A against INEC's EC8A.

Accounts are isolated workspaces, so units are matched by their INEC polling-unit code, elections
by type and date, and vote figures by party code. Results are recomputed on every read, so an
INEC correction (a new superseding EC8A version) is reflected immediately. Language stays neutral:
a mismatch is a numerical difference to investigate, never an accusation.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.elections import Candidate, Election, PoliticalParty
from app.models.organisation import GeographyNode, Workspace
from app.models.results import ResultFigure, ResultSubmission

TOTAL_FIELDS = ("valid_votes", "rejected_ballots", "total_votes_cast")
TOTAL_LABELS = {
    "valid_votes": "Valid votes",
    "rejected_ballots": "Rejected ballots",
    "total_votes_cast": "Total votes cast",
}
ACTIVE = ("submitted", "verified")


@dataclass
class Reported:
    submission_id: uuid.UUID
    document_id: uuid.UUID
    workspace_id: uuid.UUID
    version: int
    submitted_at: datetime
    totals: dict[str, int]
    votes: dict[str, int] = field(default_factory=dict)  # party code -> votes
    correction_reason: str | None = None


@dataclass
class Difference:
    field: str
    label: str
    party: int | None
    inec: int | None

    @property
    def delta(self) -> int | None:
        if self.party is None or self.inec is None:
            return None
        return self.inec - self.party


def inec_workspace(db: Session) -> Workspace | None:
    return db.scalar(select(Workspace).where(Workspace.kind == "inec"))


def matching_election(db: Session, source: Election, workspace_id: uuid.UUID) -> Election | None:
    """The counterpart election in another account: same type and polling date."""
    candidates = db.scalars(
        select(Election).where(
            Election.workspace_id == workspace_id,
            Election.election_type == source.election_type,
            Election.election_date == source.election_date,
        )
    ).all()
    return next(
        (e for e in candidates if e.status == "active"), candidates[0] if candidates else None
    )


def latest_unit_results(
    db: Session, workspace_id: uuid.UUID, election_id: uuid.UUID
) -> dict[str, Reported]:
    """Latest active EC8A per polling-unit code for one account's election."""
    rows = db.execute(
        select(ResultSubmission, GeographyNode.code)
        .join(GeographyNode, GeographyNode.id == ResultSubmission.geography_node_id)
        .where(
            ResultSubmission.workspace_id == workspace_id,
            ResultSubmission.election_id == election_id,
            ResultSubmission.form_type == "EC8A",
            ResultSubmission.status.in_(ACTIVE),
            GeographyNode.level == "polling_unit",
        )
    ).all()
    latest: dict[str, ResultSubmission] = {}
    for submission, code in rows:
        current = latest.get(code)
        if current is None or (submission.version, submission.submitted_at) > (
            current.version,
            current.submitted_at,
        ):
            latest[code] = submission
    if not latest:
        return {}
    by_id = {s.id: code for code, s in latest.items()}
    figures = db.execute(
        select(ResultFigure.submission_id, PoliticalParty.code, ResultFigure.votes)
        .join(Candidate, Candidate.id == ResultFigure.candidate_id)
        .join(PoliticalParty, PoliticalParty.id == Candidate.party_id)
        .where(ResultFigure.submission_id.in_(list(by_id)))
    ).all()
    out = {
        code: Reported(
            submission_id=s.id,
            document_id=s.document_id,
            workspace_id=s.workspace_id,
            version=s.version,
            submitted_at=s.submitted_at,
            totals={k: int(s.totals.get(k) or 0) for k in TOTAL_FIELDS},
            correction_reason=(s.configuration_snapshot or {}).get("correction_reason"),
        )
        for code, s in latest.items()
    }
    for submission_id, party_code, votes in figures:
        out[by_id[submission_id]].votes[party_code.upper()] = votes
    return out


def compare(party: Reported | None, inec: Reported | None) -> tuple[str, list[Difference]]:
    """Return (status, field-level differences) for one party report against INEC's."""
    if party is None and inec is None:
        return "not_reported", []
    if inec is None:
        return "awaiting_inec", []
    if party is None:
        return "awaiting_party", []
    diffs: list[Difference] = []
    for code in sorted(set(party.votes) | set(inec.votes)):
        p, i = party.votes.get(code), inec.votes.get(code)
        if p != i:
            diffs.append(Difference(field=f"party:{code}", label=code, party=p, inec=i))
    for key in TOTAL_FIELDS:
        if party.totals.get(key) != inec.totals.get(key):
            diffs.append(
                Difference(
                    field=key,
                    label=TOTAL_LABELS[key],
                    party=party.totals[key],
                    inec=inec.totals[key],
                )
            )
    return ("mismatch" if diffs else "match"), diffs


def unit_status(statuses: list[str], has_inec: bool) -> str:
    """Roll several party comparisons for one unit into a single status for INEC's view."""
    if "mismatch" in statuses:
        return "mismatch"
    if statuses and all(s == "match" for s in statuses):
        return "match"
    if statuses:
        return "awaiting_inec"
    return "awaiting_party" if has_inec else "not_reported"
