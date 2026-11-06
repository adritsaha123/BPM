"""Thin wrapper around the LLM so the rest of the app never imports a vendor SDK.

Swap providers (OpenAI, Gemini, a sponsor's API...) by changing only this file.
With no API key set, it returns a mock reply so everyone can develop offline.
"""

from anthropic import Anthropic

from app.config import get_settings


def complete(prompt: str, system: str | None = None, max_tokens: int = 512) -> str:
    settings = get_settings()

    if not settings.ai_enabled:
        return f"[mock AI] You said: {prompt!r}. Set ANTHROPIC_API_KEY in backend/.env for real replies."

    client = Anthropic(api_key=settings.anthropic_api_key)
    kwargs = {
        "model": settings.anthropic_model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system

    response = client.messages.create(**kwargs)
    return "".join(block.text for block in response.content if block.type == "text")
