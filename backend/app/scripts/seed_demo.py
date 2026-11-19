"""Seed a running TallyTrail API with a party-vs-INEC demonstration, through the public API.

    uv run python -m app.scripts.seed_demo          # API at http://127.0.0.1:8000

Creates one INEC account and three fictional party accounts that share a real Ikeja ward
(5 polling units). Party agents are invited with their polling unit, upload a result-sheet
image, and enter figures; INEC uploads its own figures. At PU 003 INEC's entry differs from
both parties' agents so the cross-check flags it. All figures are synthetic.

Uses BOOTSTRAP_ADMIN_* for the platform admin. Every demo user gets DEMO_USER_PASSWORD, or the
bootstrap password when that is unset. Requires ENFORCE_MFA=false (local demo only).
"""

import io
import os
import struct
import sys
import uuid
import zlib

import httpx

from app.core.config import get_settings

API = os.environ.get("TALLYTRAIL_API", "http://127.0.0.1:8000").rstrip("/") + "/api/v1"

GEOGRAPHY = """level,code,name,parent_code
state,25,Lagos,
lga,25/11,Ikeja,25
ward,25/11/01,Anifowoshe/Ikeja,25/11
polling_unit,25/11/01/001,Anifowoshe Pry. Sch.,25/11/01
polling_unit,25/11/01/002,Junction of Oduyemi/Independence St.,25/11/01
polling_unit,25/11/01/003,Along Independence St.,25/11/01
polling_unit,25/11/01/004,Junction of Akinremi/Araromi St.,25/11/01
polling_unit,25/11/01/005,Junction of Oduyemi/Araromi St.,25/11/01
"""

PARTIES = [  # fictional parties: code, name, candidate
    ("PA", "Progressive Alliance", "Adaeze Okonkwo"),
    ("DU", "Democratic Union", "Babatunde Lawal"),
    ("PF", "People's Front", "Ibrahim Musa"),
]
ELECTION = {
    "name": "2027 Lagos Governorship Election",
    "election_type": "governorship",
    "election_date": "2027-03-06",
    "jurisdiction": "Lagos State",
}
# What actually happened at each unit (synthetic): votes per party + rejected ballots.
TRUE_RESULTS = {
    "001": ({"PA": 182, "DU": 143, "PF": 61}, 9),
    "002": ({"PA": 127, "DU": 166, "PF": 48}, 6),
    "003": ({"PA": 151, "DU": 118, "PF": 74}, 11),
    "004": ({"PA": 98, "DU": 131, "PF": 57}, 4),
    "005": ({"PA": 140, "DU": 109, "PF": 66}, 8),
}
INEC_ENTRY_ERROR = {"003": {"PF": 150}}  # INEC's PU 003 entry carries +150 for PF
AGENT_UNITS = {"PA": ["001", "002", "003", "004", "005"], "DU": ["001", "002", "003"], "PF": []}
INEC_UNITS = ["001", "002", "003", "004"]


def die(r: httpx.Response) -> None:
    sys.exit(f"{r.request.method} {r.request.url.path} -> {r.status_code}: {r.text[:400]}")


def ok(r: httpx.Response):
    if r.status_code >= 400:
        die(r)
    return r.json() if r.content else None


def sheet_png(seed: int) -> bytes:
    """A plain synthetic 'result sheet' image (ruled form), generated without dependencies."""
    w, h = 480, 640
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            if y < 70:
                px = (0, 107 + seed % 3 * 10, 61)  # green header band
            elif 90 <= x <= 390 and y > 110 and (y - 110) % 46 < 2:
                px = (190, 196, 192)  # ruled lines
            elif 410 <= x <= 450 and 110 < y < 560 and (y - 110) % 46 > 8:
                px = (232, 236, 233)  # figure boxes
            else:
                px = (250, 250, 247)
            row += bytes(px)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", raw)
        + chunk(b"IEND", b"")
    )


class Session:
    def __init__(self, email: str, password: str):
        self.http = httpx.Client(base_url=API, timeout=60)
        token = ok(self.http.post("/auth/login", json={"email": email, "password": password}))
        self.http.headers["Authorization"] = f"Bearer {token['access_token']}"

    def get(self, path, **kw):
        return ok(self.http.get(path, **kw))

    def post(self, path, **kw):
        return ok(self.http.post(path, **kw))

    def put(self, path, **kw):
        return ok(self.http.put(path, **kw))


def accept(token: str, name: str, password: str) -> None:
    ok(
        httpx.post(
            f"{API}/auth/invitations/accept",
            json={"token": token, "full_name": name, "password": password},
        )
    )


def submit(s: Session, ws: str, election: dict, unit: dict, votes: dict, rejected: int) -> None:
    contest = election["contests"][0]
    by_code = {c["party_code"]: c["id"] for c in contest["candidates"]}
    doc = s.http.post(
        f"/workspaces/{ws}/documents",
        files={
            "file": (
                f"EC8A-{unit['code'].replace('/', '-')}.png",
                io.BytesIO(sheet_png(len(votes))),
                "image/png",
            )
        },
    )
    doc = ok(doc)
    valid = sum(votes.values())
    s.post(
        f"/workspaces/{ws}/submissions",
        headers={"Idempotency-Key": f"seed-{uuid.uuid4()}"},
        json={
            "election_id": election["id"],
            "contest_id": contest["id"],
            "geography_node_id": unit["id"],
            "document_id": doc["id"],
            "form_type": "EC8A",
            "figures": [{"candidate_id": by_code[c], "votes": v} for c, v in votes.items()],
            "valid_votes": valid,
            "rejected_ballots": rejected,
            "total_votes_cast": valid + rejected,
        },
    )


def setup_account(admin: Session, ws: str) -> dict:
    """Same hierarchy and election in every account, so units and parties line up by code."""
    admin.http.post(
        f"/workspaces/{ws}/geography/import",
        files={"file": ("ikeja-ward-01.csv", GEOGRAPHY.encode(), "text/csv")},
    ).raise_for_status()
    ok(admin.http.post(f"/workspaces/{ws}/activate"))
    election = admin.post(f"/workspaces/{ws}/elections", json=ELECTION)
    contest = admin.post(
        f"/workspaces/{ws}/elections/{election['id']}/contests",
        json={
            "name": "Governor of Lagos State",
            "office": "governorship",
            "form_type": "EC8A",
            "geography_level": "polling_unit",
        },
    )
    for i, (code, name, candidate) in enumerate(PARTIES, start=1):
        party = admin.post(
            f"/workspaces/{ws}/parties", json={"name": name, "code": code, "is_monitored": True}
        )
        admin.post(
            f"/workspaces/{ws}/elections/{election['id']}/contests/{contest['id']}/candidates",
            json={"party_id": party["id"], "name": candidate, "ballot_code": f"{i:02d}"},
        )
    wards = admin.get(f"/workspaces/{ws}/geography", params={"level": "ward"})
    admin.put(
        f"/workspaces/{ws}/elections/{election['id']}/coverage",
        json={"geography_node_ids": [w["id"] for w in wards]},
    )
    admin.post(f"/workspaces/{ws}/elections/{election['id']}/activate")
    context = admin.get(f"/workspaces/{ws}/context")
    return next(e for e in context["elections"] if e["id"] == election["id"])


def main() -> None:
    settings = get_settings()
    if settings.enforce_mfa:
        sys.exit("Set ENFORCE_MFA=false for the local demo seed (never in production)")
    password = os.environ.get("DEMO_USER_PASSWORD") or settings.bootstrap_admin_password
    platform = Session(settings.bootstrap_admin_email, settings.bootstrap_admin_password)
    if any(w["kind"] == "inec" for w in platform.get("/workspaces")):
        print("Demo already seeded (INEC account exists). Nothing to do.")
        return

    accounts = [
        (
            "inec",
            "INEC",
            "Independent National Electoral Commission",
            "inec@tallytrail.test",
            "INEC Results Desk",
        )
    ]
    accounts += [
        ("party", code, name, f"{code.lower()}@tallytrail.test", f"{name} Admin")
        for code, name, _ in PARTIES
    ]
    ballots: dict[str, tuple[str, Session, dict]] = {}
    for kind, code, name, email, person in accounts:
        ws = platform.post("/workspaces", json={"name": name, "party_code": code, "kind": kind})[
            "id"
        ]
        invite = platform.post(
            f"/workspaces/{ws}/invitations", json={"email": email, "role": "party_admin"}
        )
        accept(invite["invitation_token"], person, password)
        admin = Session(email, password)
        ballots[code] = (ws, admin, setup_account(admin, ws))
        print(f"account   {kind:5} {code:4} {name}  ->  {email}")

    for code, units in AGENT_UNITS.items():
        ws, admin, election = ballots[code]
        nodes = {
            n["code"][-3:]: n
            for n in admin.get(f"/workspaces/{ws}/geography", params={"level": "polling_unit"})
        }
        for suffix in units:
            email = f"agent{suffix}@{code.lower()}.tallytrail.test"
            invite = admin.post(
                f"/workspaces/{ws}/invitations",
                json={"email": email, "role": "pu_agent", "geography_node_id": nodes[suffix]["id"]},
            )
            accept(invite["invitation_token"], f"{code} Agent PU {suffix}", password)
            agent = Session(email, password)
            votes, rejected = TRUE_RESULTS[suffix]
            submit(agent, ws, election, nodes[suffix], dict(votes), rejected)
        print(f"agents    {code}: {len(units)} invited with polling units and reported")

    ws, inec, election = ballots["INEC"]
    nodes = {
        n["code"][-3:]: n
        for n in inec.get(f"/workspaces/{ws}/geography", params={"level": "polling_unit"})
    }
    for suffix in INEC_UNITS:
        votes, rejected = TRUE_RESULTS[suffix]
        votes = {k: v + INEC_ENTRY_ERROR.get(suffix, {}).get(k, 0) for k, v in votes.items()}
        submit(inec, ws, election, nodes[suffix], votes, rejected)
    print(f"inec      uploaded {len(INEC_UNITS)} polling-unit results (PU 003 differs from agents)")

    summary = inec.get(f"/workspaces/{ws}/crosscheck", params={"election_id": election["id"]})[
        "summary"
    ]
    print(f"crosscheck INEC view: {summary}")
    print("\nDemo users all share the bootstrap password unless DEMO_USER_PASSWORD is set.")


if __name__ == "__main__":
    main()
