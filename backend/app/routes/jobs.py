import logging
import hashlib
import time
from pathlib import Path
from typing import Optional, Union
from uuid import uuid4

from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.config import Settings, get_settings
from app.models import CompletedJobResponse, UrlJobRequest, WarningResponse
from app.services.errors import DocuSenseError
from app.services.gemini_processor import GeminiDocumentProcessor
from app.services.html_sanitizer import extract_metadata, sanitize_html
from app.services.pdf_service import count_pages, download_pdf, save_upload
from app.services.result_store import ResultStore

router = APIRouter(prefix="/api/jobs", tags=["jobs"])
logger = logging.getLogger("docusense")
PREVIEW_MAX_CHARS = 200_000
PREVIEW_MAX_SECTIONS = 8


@router.post("/upload", response_model=Union[CompletedJobResponse, WarningResponse])
async def create_job_from_upload(
    file: UploadFile = File(...),
    force: bool = Form(False),
    settings: Settings = Depends(get_settings),
):
    pdf_path = await save_upload(file, settings)
    return await _process_pdf(pdf_path, force, settings, source_type="upload")


@router.post("/url", response_model=Union[CompletedJobResponse, WarningResponse])
async def create_job_from_url(
    request: UrlJobRequest,
    settings: Settings = Depends(get_settings),
):
    url = str(request.url)
    store = ResultStore(settings)
    if not request.force:
        cached_job_id = store.get_cached_url_job_id(url)
        if cached_job_id:
            metadata = store.get_metadata(cached_job_id)
            logger.info(
                "[docusense] job=%s status=cache_hit source=url url=%s",
                cached_job_id,
                url,
            )
            return CompletedJobResponse(
                job_id=cached_job_id,
                page_count=metadata["page_count"],
                result_url=f"{settings.backend_base_url.rstrip('/')}/api/results/{cached_job_id}",
                preview_html=build_preview_html(store.get_html(cached_job_id)),
                cached=True,
            )

    pdf_path = await download_pdf(url, settings)
    return await _process_pdf(
        pdf_path,
        request.force,
        settings,
        source_type="url",
        source_url=url,
    )


async def _process_pdf(
    pdf_path: Path,
    force: bool,
    settings: Settings,
    source_type: str,
    source_url: Optional[str] = None,
) -> Union[CompletedJobResponse, WarningResponse]:
    job_id = str(uuid4())
    content_hash = hash_file(pdf_path)
    store = ResultStore(settings)
    try:
        if not force:
            cached_job_id = store.get_cached_content_job_id(content_hash)
            if cached_job_id:
                metadata = store.get_metadata(cached_job_id)
                logger.info(
                    "[docusense] job=%s status=cache_hit source=%s cache=content content_hash=%s",
                    cached_job_id,
                    source_type,
                    content_hash,
                )
                if source_url:
                    store.save_url_cache_entry(source_url, cached_job_id)
                return CompletedJobResponse(
                    job_id=cached_job_id,
                    page_count=metadata["page_count"],
                    result_url=f"{settings.backend_base_url.rstrip('/')}/api/results/{cached_job_id}",
                    preview_html=build_preview_html(store.get_html(cached_job_id)),
                    cached=True,
                )

        page_count = count_pages(pdf_path)
        logger.info(
            "[docusense] job=%s status=received source=%s page_count=%s force=%s",
            job_id,
            source_type,
            page_count,
            force,
        )
        if page_count > settings.max_recommended_pages and not force:
            logger.info(
                "[docusense] job=%s status=warning warning_type=PAGE_LIMIT_EXCEEDED page_count=%s max_recommended_pages=%s",
                job_id,
                page_count,
                settings.max_recommended_pages,
            )
            return WarningResponse(
                message=(
                    f"This PDF has {page_count} pages. DocuSense is optimized for "
                    f"{settings.max_recommended_pages} pages or fewer in this prototype. "
                    "You can continue, but processing may be slow or incomplete."
                ),
                page_count=page_count,
            )

        processor = GeminiDocumentProcessor(settings)
        result = await processor.process_pdf(pdf_path, job_id=job_id, page_count=page_count)

        started = time.perf_counter()
        logger.info("[docusense] job=%s stage=sanitize_and_store status=started", job_id)
        try:
            sanitized_html = sanitize_html(result["html"])
            processing_stages = [*result.get("processing_stages", []), "sanitize_and_store"]
            stage_timings_ms = dict(result.get("stage_timings_ms", {}))
            stage_statuses = dict(result.get("stage_statuses", {}))
            stage_results = list(result.get("stage_results", []))
            duration_ms = round((time.perf_counter() - started) * 1000)
            stage_timings_ms["sanitize_and_store"] = duration_ms
            stage_statuses["sanitize_and_store"] = "completed"
            stage_results.append(
                {
                    "name": "sanitize_and_store",
                    "status": "completed",
                    "duration_ms": duration_ms,
                    "output_chars": len(sanitized_html),
                    "error_code": "",
                    "message": "",
                }
            )
            metadata = extract_metadata(
                sanitized_html,
                page_count=page_count,
                processor=result["processor"],
                job_id=job_id,
                requested_processor=result.get("requested_processor", result["processor"]),
                processing_goal=result.get("processing_goal", "reading_order_repair"),
                processing_stages=processing_stages,
                stage_timings_ms=stage_timings_ms,
                stage_statuses=stage_statuses,
                stage_results=stage_results,
            )
            if source_url:
                metadata["source_url"] = source_url

            store.save(job_id, pdf_path, sanitized_html, metadata)
            store.save_content_cache_entry(content_hash, job_id)
            if source_url:
                store.save_url_cache_entry(source_url, job_id)
            logger.info(
                "[docusense] job=%s stage=sanitize_and_store status=completed duration_ms=%s output_chars=%s",
                job_id,
                duration_ms,
                len(sanitized_html),
            )
        except DocuSenseError as exc:
            duration_ms = round((time.perf_counter() - started) * 1000)
            logger.exception(
                "[docusense] job=%s stage=sanitize_and_store status=failed duration_ms=%s error_code=%s message=%s",
                job_id,
                duration_ms,
                exc.error_code,
                exc.message,
            )
            raise
        except Exception as exc:
            duration_ms = round((time.perf_counter() - started) * 1000)
            logger.exception(
                "[docusense] job=%s stage=sanitize_and_store status=failed duration_ms=%s error_code=SANITIZE_AND_STORE_FAILED exception=%s",
                job_id,
                duration_ms,
                exc.__class__.__name__,
            )
            raise DocuSenseError(
                "SANITIZE_AND_STORE_FAILED",
                "DocuSense could not sanitize or store the generated result.",
                status_code=500,
            ) from exc
        logger.info(
            "[docusense] job=%s status=completed result_url=%s",
            job_id,
            f"{settings.backend_base_url.rstrip('/')}/api/results/{job_id}",
        )

        return CompletedJobResponse(
            job_id=job_id,
            page_count=page_count,
            result_url=f"{settings.backend_base_url.rstrip('/')}/api/results/{job_id}",
            preview_html=build_preview_html(sanitized_html),
            cached=False,
        )
    finally:
        pdf_path.unlink(missing_ok=True)


def build_preview_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    source_article = soup.select_one("main article") or soup.select_one("article") or soup.body
    if source_article is None:
        return html[:PREVIEW_MAX_CHARS]

    preview = BeautifulSoup(
        "<!doctype html><html><body><main><article></article></main></body></html>",
        "html.parser",
    )
    target_article = preview.select_one("article")
    if target_article is None:
        return html[:PREVIEW_MAX_CHARS]

    for node in source_article.select("[data-read-aloud-ui='true'], script, style, nav"):
        node.decompose()

    appended_sections = 0
    truncated = False
    for child in source_article.find_all(recursive=False):
        child_text = child.get_text(" ", strip=True) if hasattr(child, "get_text") else ""
        if not child_text:
            continue
        if getattr(child, "name", None) == "section":
            if appended_sections >= PREVIEW_MAX_SECTIONS:
                truncated = True
                break
            appended_sections += 1

        child_html = str(child)
        if len(str(target_article)) + len(child_html) >= PREVIEW_MAX_CHARS:
            if not target_article.find(recursive=False):
                paragraph = preview.new_tag("p")
                paragraph.string = child_text[:PREVIEW_MAX_CHARS]
                target_article.append(paragraph)
            truncated = True
            break
        target_article.append(BeautifulSoup(child_html, "html.parser"))

    if truncated:
        notice = preview.new_tag("p")
        notice.string = "Open the full HTML result to read the complete processed document."
        target_article.append(notice)

    return str(preview)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
