"""INEC account kind, one account per party, and polling-unit invitations

Revision ID: 20261119_0005
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "20261119_0005"
down_revision = "20261119_0004"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    # Earlier revisions create tables from the live models, so guard every change.
    if "kind" not in _columns("workspaces"):
        op.add_column(
            "workspaces",
            sa.Column("kind", sa.String(10), nullable=False, server_default="party"),
        )
    if "ix_workspaces_kind" not in _indexes("workspaces"):
        op.create_index("ix_workspaces_kind", "workspaces", ["kind"])
    if "geography_node_id" not in _columns("invitations"):
        op.add_column(
            "invitations",
            sa.Column(
                "geography_node_id",
                UUID(as_uuid=True),
                sa.ForeignKey("geography_nodes.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
    # Audit rows store full request paths; nested routes overflowed VARCHAR(100) and turned
    # successful mutations into HTTP 500s after commit.
    op.alter_column("audit_events", "entity_id", type_=sa.String(500), existing_nullable=True)
    # A political party can hold only one account; there is exactly one INEC account.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_party_code "
        "ON workspaces (upper(party_code)) WHERE kind = 'party'"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_single_inec "
        "ON workspaces (kind) WHERE kind = 'inec'"
    )


def downgrade() -> None:
    op.alter_column("audit_events", "entity_id", type_=sa.String(100), existing_nullable=True)
    op.execute("DROP INDEX IF EXISTS uq_workspaces_single_inec")
    op.execute("DROP INDEX IF EXISTS uq_workspaces_party_code")
    op.drop_column("invitations", "geography_node_id")
    op.drop_index("ix_workspaces_kind", table_name="workspaces")
    op.drop_column("workspaces", "kind")
