import uuid
from datetime import UTC, datetime
from time import time

import pytest
from pydantic import ValidationError

from app.core.errors import AppError
from app.schemas.organisation import InvitationCreate
from app.schemas.results import SubmissionCreate
from app.services import local_storage
from app.services.crosscheck import Reported, compare, unit_status


def reported(votes: dict[str, int], rejected: int = 0, version: int = 1) -> Reported:
    valid = sum(votes.values())
    return Reported(
        submission_id=uuid.uuid4(),
        document_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        version=version,
        submitted_at=datetime.now(UTC),
        totals={
            "valid_votes": valid,
            "rejected_ballots": rejected,
            "total_votes_cast": valid + rejected,
        },
        votes=votes,
    )


def test_matching_figures_are_a_match() -> None:
    status, diffs = compare(reported({"PA": 120, "DU": 80}), reported({"PA": 120, "DU": 80}))
    assert status == "match"
    assert diffs == []


def test_inflated_inec_figure_is_quantified_per_party_and_total() -> None:
    party = reported({"PA": 100, "DU": 80})
    inec = reported({"PA": 250, "DU": 80})
    status, diffs = compare(party, inec)
    assert status == "mismatch"
    by_field = {d.field: d for d in diffs}
    assert by_field["party:PA"].delta == 150
    assert by_field["valid_votes"].party == 180 and by_field["valid_votes"].inec == 330
    assert "party:DU" not in by_field


def test_missing_sides_are_never_a_match() -> None:
    assert compare(None, reported({"PA": 1}))[0] == "awaiting_party"
    assert compare(reported({"PA": 1}), None)[0] == "awaiting_inec"
    assert compare(None, None)[0] == "not_reported"


def test_inec_unit_status_rolls_up_party_reports() -> None:
    assert unit_status(["match", "mismatch"], True) == "mismatch"
    assert unit_status(["match", "match"], True) == "match"
    assert unit_status(["awaiting_inec"], False) == "awaiting_inec"
    assert unit_status([], True) == "awaiting_party"
    assert unit_status([], False) == "not_reported"


def test_agents_must_be_invited_with_a_polling_unit() -> None:
    with pytest.raises(ValidationError):
        InvitationCreate(email="agent@example.com", role="pu_agent")
    ok = InvitationCreate(
        email="agent@example.com", role="pu_agent", geography_node_id=uuid.uuid4()
    )
    assert ok.geography_node_id is not None
    assert InvitationCreate(email="ops@example.com", role="operations").geography_node_id is None


def test_corrections_require_a_reason() -> None:
    base = dict(
        election_id=uuid.uuid4(),
        contest_id=uuid.uuid4(),
        geography_node_id=uuid.uuid4(),
        document_id=uuid.uuid4(),
        form_type="EC8A",
        figures=[{"candidate_id": uuid.uuid4(), "votes": 10}],
        valid_votes=10,
        rejected_ballots=0,
        total_votes_cast=10,
    )
    with pytest.raises(ValidationError):
        SubmissionCreate(**base, supersedes_id=uuid.uuid4())
    fixed = SubmissionCreate(**base, supersedes_id=uuid.uuid4(), correction_reason="Recount")
    assert fixed.correction_reason == "Recount"


def test_local_evidence_links_are_signed_and_expire(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(local_storage, "_root", lambda: tmp_path)
    stored = local_storage.store(b"\x89PNG demo", "image/png", uuid.uuid4())
    assert stored["resource_type"] == "local"
    assert local_storage.sha256_of(stored["public_id"]) == stored["sha256"]
    sig = local_storage._signature(stored["public_id"], int(time()) + 60)
    path, media = local_storage.resolve_signed(stored["public_id"], int(time()) + 60, sig)
    assert path.read_bytes() == b"\x89PNG demo" and media == "image/png"
    with pytest.raises(AppError):
        local_storage.resolve_signed(stored["public_id"], int(time()) + 60, "0" * 64)
    with pytest.raises(AppError):
        local_storage.resolve_signed(stored["public_id"], int(time()) - 1, sig)
    with pytest.raises(AppError):
        local_storage._path("../../etc/passwd")


def test_custom_validation_errors_return_readable_422() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from pydantic import BaseModel, model_validator

    from app.core.errors import register_exception_handlers

    class Figures(BaseModel):
        valid: int
        rejected: int
        total: int

        @model_validator(mode="after")
        def sums(self):
            if self.valid + self.rejected != self.total:
                raise ValueError("valid_votes plus rejected_ballots must equal total_votes_cast")
            return self

    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/check")
    def check(body: Figures) -> dict:
        return {"ok": True}

    response = TestClient(app).post("/check", json={"valid": 1, "rejected": 1, "total": 5})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["message"] == "valid_votes plus rejected_ballots must equal total_votes_cast"
    assert error["details"][0]["ctx"]["error"].startswith("valid_votes")


def test_agents_must_submit_fresh_live_camera_photos() -> None:
    from datetime import timedelta

    from app.api.routes.results import check_live_capture

    now = datetime.now(UTC)
    check_live_capture("camera", now - timedelta(seconds=30), "image/jpeg", now)
    for source, taken, media in [
        ("file", now, "image/jpeg"),  # gallery / file upload
        (None, now, "image/jpeg"),
        ("camera", None, "image/jpeg"),
        ("camera", now - timedelta(minutes=11), "image/jpeg"),  # old photo
        ("camera", now + timedelta(minutes=5), "image/jpeg"),  # clock forged forward
        ("camera", now, "application/pdf"),
    ]:
        with pytest.raises(AppError):
            check_live_capture(source, taken, media, now)


def test_corrections_only_supersede_the_same_unit_election_and_form() -> None:
    from types import SimpleNamespace

    from app.api.routes.results import can_supersede

    ws, election, unit, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    def previous(**changes) -> SimpleNamespace:
        fields = dict(
            status="submitted",
            workspace_id=ws,
            election_id=election,
            geography_node_id=unit,
            form_type="EC8A",
        )
        return SimpleNamespace(**(fields | changes))

    assert can_supersede(previous(), ws, election, unit, "EC8A")
    assert not can_supersede(None, ws, election, unit, "EC8A")  # unknown supersedes_id
    assert not can_supersede(previous(geography_node_id=other), ws, election, unit, "EC8A")
    assert not can_supersede(previous(election_id=other), ws, election, unit, "EC8A")
    assert not can_supersede(previous(workspace_id=other), ws, election, unit, "EC8A")
    assert not can_supersede(previous(form_type="EC8B"), ws, election, unit, "EC8A")
    assert not can_supersede(previous(status="superseded"), ws, election, unit, "EC8A")


def test_inec_may_type_figures_without_a_sheet() -> None:
    body = SubmissionCreate(
        election_id=uuid.uuid4(),
        contest_id=uuid.uuid4(),
        geography_node_id=uuid.uuid4(),
        form_type="EC8A",
        figures=[{"candidate_id": uuid.uuid4(), "votes": 5}],
        valid_votes=5,
        rejected_ballots=1,
        total_votes_cast=6,
    )
    assert body.document_id is None
