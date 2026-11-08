from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import whoop as whoop_client
from app.config import get_settings
from app.routes import ai, coach, live, runs, whoop

settings = get_settings()

app = FastAPI(title="BPM Coach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "ai": "live" if get_settings().ai_enabled else "mock",
        "whoop": whoop_client.mode(),
    }


app.include_router(ai.router)
app.include_router(whoop.router)
app.include_router(live.router)
app.include_router(coach.router)
app.include_router(runs.router)
