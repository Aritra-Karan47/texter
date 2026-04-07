import io
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from models import Document, User
from auth import get_current_user

router = APIRouter(prefix="/export", tags=["export"])


@router.get("/{doc_id}/txt")
def export_txt(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc = (
        db.query(Document)
        .filter(Document.id == doc_id, Document.user_id == current_user.id)
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    content = f"{doc.title}\n{'=' * len(doc.title)}\n\n{doc.content}"
    buf = io.BytesIO(content.encode("utf-8"))
    filename = doc.title.replace(" ", "_")[:80] + ".txt"

    return StreamingResponse(
        buf,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{doc_id}/pdf")
def export_pdf(
    doc_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.enums import TA_LEFT
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF generation library not available")

    doc = (
        db.query(Document)
        .filter(Document.id == doc_id, Document.user_id == current_user.id)
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    buf = io.BytesIO()
    pdf = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=2.5 * cm,
        rightMargin=2.5 * cm,
        topMargin=2.5 * cm,
        bottomMargin=2.5 * cm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "CustomTitle",
        parent=styles["Title"],
        fontSize=18,
        spaceAfter=12,
        alignment=TA_LEFT,
    )
    body_style = ParagraphStyle(
        "CustomBody",
        parent=styles["Normal"],
        fontSize=11,
        leading=16,
        spaceAfter=6,
    )

    elements = [
        Paragraph(doc.title, title_style),
        Spacer(1, 0.5 * cm),
    ]

    # Split content into paragraphs preserving line breaks
    for para in doc.content.split("\n"):
        safe = para.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if safe.strip():
            elements.append(Paragraph(safe, body_style))
        else:
            elements.append(Spacer(1, 0.3 * cm))

    pdf.build(elements)
    buf.seek(0)

    filename = doc.title.replace(" ", "_")[:80] + ".pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )