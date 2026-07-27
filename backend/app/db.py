"""gitEssay backend — SQLAlchemy + SQLite setup."""
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

DB_PATH = os.environ.get("GITESSAY_DB", "gitessay.db")

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)


# Enable FK cascade support in SQLite. The "connect" event passes the raw DBAPI
# connection, so execute() takes a plain SQL string (not a SQLAlchemy text()).
# WAL + busy_timeout: background threads (literature ingest commits every few
# pages, summarizer) overlap with foreground writes (auto-checkpoint saves).
# With the default rollback journal and busy_timeout=0, any read/write overlap
# raises "database is locked". WAL lets readers proceed during a write and the
# timeout makes writers wait instead of failing. synchronous=NORMAL is the
# recommended companion to WAL (still crash-safe, faster per commit).
@event.listens_for(engine, "connect")
def _enable_fk(conn, _record):
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(
    bind=engine, autoflush=False, autocommit=False, expire_on_commit=False
)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
