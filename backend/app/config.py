from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All config comes from environment variables / backend/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-5-5"
    cors_origins: str = "*"

    # WHOOP Developer API (developer-dashboard.whoop.com). Blank = mock WHOOP data.
    whoop_client_id: str = ""
    whoop_client_secret: str = ""
    whoop_redirect_uri: str = "http://localhost:8000/whoop/callback"
    whoop_token_file: str = ".whoop_tokens.json"

    # Spotify Web API (developer.spotify.com/dashboard). Blank = mock library + player.
    # Spotify rejects "localhost" redirects; it must be the 127.0.0.1 loopback address.
    spotify_client_id: str = ""
    spotify_client_secret: str = ""
    spotify_redirect_uri: str = "http://127.0.0.1:8000/spotify/callback"
    spotify_token_file: str = ".spotify_tokens.json"

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key.strip())

    @property
    def whoop_enabled(self) -> bool:
        return bool(self.whoop_client_id.strip() and self.whoop_client_secret.strip())

    @property
    def spotify_enabled(self) -> bool:
        return bool(self.spotify_client_id.strip() and self.spotify_client_secret.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
