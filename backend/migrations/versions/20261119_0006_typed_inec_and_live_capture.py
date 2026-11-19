"""INEC may type figures without a sheet; record how evidence was captured

Revision ID: 20261119_0006
"""

import sqlalchemy as sa
from alembic import op

revision = "20261119_0006"
down_revision = "20261119_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("documents")}
    if "capture_metadata" not in columns:
        op.add_column("documents", sa.Column("capture_metadata", sa.JSON(), nullable=True))
    op.alter_column("result_submissions", "document_id", existing_type=sa.UUID(), nullable=True)


def downgrade() -> None:
    op.alter_column("result_submissions", "document_id", existing_type=sa.UUID(), nullable=False)
    op.drop_column("documents", "capture_metadata")
