import os
import io
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as FastAPIFile
from sqlalchemy.orm import Session
from typing import List

from database import get_db
from models import File, User
from schemas import FileOut
from auth import get_current_user

router = APIRouter(prefix="/files", tags=["files"])

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


def get_dropbox_client():
    import dropbox

    token = os.getenv("DROPBOX_ACCESS_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="Dropbox not configured")
    return dropbox.Dropbox(token)


@router.post("/upload", response_model=FileOut)
async def upload_file(
    file: UploadFile = FastAPIFile(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    dbx = get_dropbox_client()
    import dropbox as dbx_module

    dropbox_path = f"/docubase/{current_user.id}/{file.filename}"

    try:
        dbx.files_upload(
            contents,
            dropbox_path,
            mode=dbx_module.files.WriteMode("overwrite"),
        )
        # Create a shared link
        try:
            shared = dbx.sharing_create_shared_link_with_settings(dropbox_path)
            file_url = shared.url.replace("dl=0", "dl=1")
        except dbx_module.exceptions.ApiError as e:
            # Link may already exist
            links = dbx.sharing_list_shared_links(path=dropbox_path).links
            if links:
                file_url = links[0].url.replace("dl=0", "dl=1")
            else:
                raise HTTPException(status_code=500, detail=f"Dropbox link error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    db_file = File(
        user_id=current_user.id,
        file_url=file_url,
        file_name=file.filename,
    )
    db.add(db_file)
    db.commit()
    db.refresh(db_file)
    return db_file


@router.get("/", response_model=List[FileOut])
def list_files(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return (
        db.query(File)
        .filter(File.user_id == current_user.id)
        .order_by(File.created_at.desc())
        .all()
    )


@router.delete("/{file_id}", status_code=204)
def delete_file(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    f = db.query(File).filter(File.id == file_id, File.user_id == current_user.id).first()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")
    db.delete(f)
    db.commit()