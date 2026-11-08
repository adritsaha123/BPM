from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All config comes from environment variables / backend/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-5-5"
    cors_origins: str = "*"

    # Postgres for OAuth tokens (cloud deploy, e.g. Neon). Blank = JSON files next to the backend.
    database_url: str = ""

    # WHOOP Developer API (developer-dashboard.whoop.com). Blank = mock WHOOP data.
    whoop_client_id: str = ""
    whoop_client_secret: str = ""
    whoop_redirect_uri: str = "http://localhost:8000/whoop/callback"
    whoop_token_file: str = ".whoop_tokens.json"

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key.strip())

    @property
    def whoop_enabled(self) -> bool:
        return bool(self.whoop_client_id.strip() and self.whoop_client_secret.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
