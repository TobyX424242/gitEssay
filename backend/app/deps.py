"""gitEssay backend — shared router dependencies."""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import Project


def get_project_or_404(db: Session, pid: str) -> Project:
    project = db.get(Project, pid)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project
