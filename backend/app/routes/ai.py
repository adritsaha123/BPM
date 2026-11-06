from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import llm

router = APIRouter(prefix="/ai", tags=["ai"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    system: str | None = None


class ChatResponse(BaseModel):
    reply: str


@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    try:
        return ChatResponse(reply=llm.complete(req.message, system=req.system))
    except Exception as exc:  # surface provider errors to the app during the hackathon
        raise HTTPException(status_code=502, detail=f"AI provider error: {exc}") from exc
