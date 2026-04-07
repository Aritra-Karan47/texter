from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime
from uuid import UUID


# ─── Auth ────────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: UUID
    email: str
    created_at: datetime

    model_config = {"from_attributes": True}


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ─── Documents ───────────────────────────────────────────────────────────────

class DocumentCreate(BaseModel):
    title: str = "Untitled Document"
    content: str = ""


class DocumentUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    updated_at: Optional[datetime] = None  # client can send its local timestamp


class DocumentOut(BaseModel):
    id: UUID
    user_id: UUID
    title: str
    content: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ─── Files ───────────────────────────────────────────────────────────────────

class FileOut(BaseModel):
    id: UUID
    user_id: UUID
    file_url: str
    file_name: str
    created_at: datetime

    model_config = {"from_attributes": True}