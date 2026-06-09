from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl


class UrlJobRequest(BaseModel):
    url: HttpUrl
    force: bool = False


class WarningResponse(BaseModel):
    status: Literal["warning"] = "warning"
    warning_type: Literal["PAGE_LIMIT_EXCEEDED"] = "PAGE_LIMIT_EXCEEDED"
    message: str
    page_count: int
    can_continue: bool = True


class CompletedJobResponse(BaseModel):
    job_id: str
    status: Literal["completed"] = "completed"
    page_count: int
    result_url: str
    preview_html: str
    cached: bool = False


class CacheMissResponse(BaseModel):
    status: Literal["not_found"] = "not_found"


class ErrorResponse(BaseModel):
    status: Literal["error"] = "error"
    error_code: str
    message: str


class ResultMetadata(BaseModel):
    job_id: str
    title: str = "Untitled document"
    language: str = "en"
    page_count: int
    html: str
    created_at: datetime
    processor: str
    requested_processor: str = ""
    processing_goal: str = "reading_order_repair"
    processing_stages: list[str] = Field(default_factory=list)
    stage_timings_ms: dict[str, int] = Field(default_factory=dict)
    stage_statuses: dict[str, str] = Field(default_factory=dict)
    stage_results: list[dict] = Field(default_factory=list)
