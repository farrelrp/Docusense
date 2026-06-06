from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_model: str = Field(default="gemini-2.5-flash", alias="GEMINI_MODEL")
    gemini_fallback_model: str = Field(default="gemini-3.1-flash-lite", alias="GEMINI_FALLBACK_MODEL")
    backend_base_url: str = Field(default="http://localhost:8000", alias="BACKEND_BASE_URL")
    max_recommended_pages: int = Field(default=50, alias="MAX_RECOMMENDED_PAGES")
    temp_storage_dir: Path = Field(default=Path("./tmp"), alias="TEMP_STORAGE_DIR")
    allow_origins: str = Field(
        default="http://localhost:5173,chrome-extension://replace_me",
        alias="ALLOW_ORIGINS",
    )
    max_pdf_size_bytes: int = Field(default=25 * 1024 * 1024, alias="MAX_PDF_SIZE_BYTES")

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allow_origins.split(",") if origin.strip()]

    @property
    def storage_root(self) -> Path:
        return self.temp_storage_dir


@lru_cache
def get_settings() -> Settings:
    return Settings()
