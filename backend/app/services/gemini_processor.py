from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable

from pypdf import PdfReader, PdfWriter

from app.config import Settings
from app.services.document_processor import DocumentProcessor
from app.services.errors import DocuSenseError

logger = logging.getLogger("docusense")


@dataclass
class ProcessingStageResult:
    name: str
    status: str
    duration_ms: int
    output_chars: int = 0
    error_code: str = ""
    message: str = ""


class GeminiDocumentProcessor(DocumentProcessor):
    _FALLBACK_ERROR_MARKERS = (
        "429",
        "503",
        "overloaded",
        "over load",
        "overload",
        "crowded",
        "capacity",
        "quota",
        "rate limit",
        "rate_limit",
        "resource exhausted",
        "unavailable",
        "too many requests",
    )

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.prompt_dir = Path(__file__).resolve().parents[1] / "prompts"
        self._active_gemini_model = settings.gemini_model

    async def process_pdf(self, pdf_path: Path, job_id: str, page_count: int) -> dict:
        return await asyncio.to_thread(self._process_pdf_sync, pdf_path, job_id, page_count)

    def _process_pdf_sync(self, pdf_path: Path, job_id: str, page_count: int) -> dict:
        stage_results: list[ProcessingStageResult] = []
        self._run_stage(
            "intake",
            job_id,
            stage_results,
            lambda: self._run_intake(pdf_path, job_id, page_count),
        )

        client, uploaded_pdf = self._upload_pdf(pdf_path, job_id, stage_results)

        document_information = self._run_stage(
            "document_information",
            job_id,
            stage_results,
            lambda: self._generate_document_information(client, pdf_path),
            "GEMINI_DOCUMENT_INFORMATION_FAILED",
        )

        document_plan = self._run_stage(
            "document_plan",
            job_id,
            stage_results,
            lambda: self._generate_json_stage(
                client=client,
                uploaded_pdf=uploaded_pdf,
                prompt_name="document_plan_prompt.txt",
                error_code="GEMINI_DOCUMENT_PLAN_FAILED",
                empty_message="Gemini returned an empty document plan.",
            ),
            "GEMINI_DOCUMENT_PLAN_FAILED",
        )

        visual_explanations = self._run_stage(
            "visual_explanations",
            job_id,
            stage_results,
            lambda: self._generate_json_stage(
                client=client,
                uploaded_pdf=uploaded_pdf,
                prompt_name="visual_explanations_prompt.txt",
                error_code="GEMINI_VISUAL_EXPLANATIONS_FAILED",
                empty_message="Gemini returned empty visual explanations.",
                context={"document_plan": document_plan},
            ),
            "GEMINI_VISUAL_EXPLANATIONS_FAILED",
        )

        html = self._run_stage(
            "html_assembly",
            job_id,
            stage_results,
            lambda: self._generate_html(
                client=client,
                uploaded_pdf=uploaded_pdf,
                document_information=document_information,
                document_plan=document_plan,
                visual_explanations=visual_explanations,
            ),
            "GEMINI_HTML_ASSEMBLY_FAILED",
        )

        return {
            "html": html,
            "processor": self._active_gemini_model,
            "requested_processor": self.settings.gemini_model,
            "processing_goal": "reading_order_repair",
            "processing_stages": [stage.name for stage in stage_results],
            "stage_timings_ms": {stage.name: stage.duration_ms for stage in stage_results},
            "stage_statuses": {stage.name: stage.status for stage in stage_results},
            "stage_results": [asdict(stage) for stage in stage_results],
            "document_information": document_information,
        }

    def _run_intake(self, pdf_path: Path, job_id: str, page_count: int) -> dict:
        if not self.settings.gemini_api_key:
            raise DocuSenseError(
                "GEMINI_PROCESSING_FAILED",
                "GEMINI_API_KEY is not configured on the backend.",
                status_code=500,
            )
        if not pdf_path.exists():
            raise DocuSenseError(
                "PDF_NOT_FOUND",
                "DocuSense could not find the PDF selected for processing.",
                status_code=400,
            )

        file_size = pdf_path.stat().st_size
        logger.info(
            "[docusense] job=%s stage=intake status=metadata model=%s page_count=%s file_size_bytes=%s",
            job_id,
            self.settings.gemini_model,
            page_count,
            file_size,
        )
        return {"file_size": file_size}

    def _upload_pdf(self, pdf_path: Path, job_id: str, stage_results: list[ProcessingStageResult]):
        def upload() -> tuple[Any, Any]:
            try:
                from google import genai
            except ImportError as exc:
                raise DocuSenseError(
                    "GEMINI_PROCESSING_FAILED",
                    "The google-genai package is not installed.",
                    status_code=500,
                ) from exc

            client = genai.Client(api_key=self.settings.gemini_api_key)
            uploaded_pdf = client.files.upload(file=str(pdf_path))
            return client, uploaded_pdf

        return self._run_stage("gemini_upload", job_id, stage_results, upload, "GEMINI_UPLOAD_FAILED")

    def _generate_json_stage(
        self,
        client: Any,
        uploaded_pdf: Any,
        prompt_name: str,
        error_code: str,
        empty_message: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        prompt = self._read_prompt(prompt_name)
        contents: list[Any] = [prompt]
        if context:
            contents.append(self._json_context(context))
        contents.append(uploaded_pdf)

        response = self._generate_content(
            client,
            contents=contents,
            json_response=True,
        )
        text = (getattr(response, "text", "") or "").strip()
        if not text:
            raise DocuSenseError(error_code, empty_message, status_code=502)

        try:
            parsed = self._parse_json_object(text)
        except ValueError as exc:
            raise DocuSenseError(
                error_code,
                "Gemini returned invalid structured stage output.",
                status_code=502,
            ) from exc
        if not parsed:
            raise DocuSenseError(error_code, empty_message, status_code=502)
        return parsed

    def _generate_document_information(self, client: Any, pdf_path: Path) -> dict[str, Any]:
        with TemporaryDirectory(prefix="docusense-first-page-") as temp_dir:
            first_page_path = Path(temp_dir) / "first-page.pdf"
            try:
                reader = PdfReader(str(pdf_path))
                if not reader.pages:
                    raise ValueError("PDF has no pages.")
                writer = PdfWriter()
                writer.add_page(reader.pages[0])
                with first_page_path.open("wb") as first_page_file:
                    writer.write(first_page_file)
            except Exception as exc:
                raise DocuSenseError(
                    "GEMINI_DOCUMENT_INFORMATION_FAILED",
                    "DocuSense could not prepare the first page for metadata extraction.",
                    status_code=502,
                ) from exc

            uploaded_first_page = client.files.upload(file=str(first_page_path))
            raw_information = self._generate_json_stage(
                client=client,
                uploaded_pdf=uploaded_first_page,
                prompt_name="document_information_prompt.txt",
                error_code="GEMINI_DOCUMENT_INFORMATION_FAILED",
                empty_message="Gemini returned empty document information.",
            )
        return self._normalize_document_information(raw_information)

    @staticmethod
    def _normalize_document_information(value: dict[str, Any]) -> dict[str, Any]:
        def clean_string(field: str) -> str:
            raw_value = value.get(field, "")
            if not isinstance(raw_value, str):
                return ""
            cleaned = " ".join(raw_value.split()).strip(" .:-")
            if cleaned.lower() in {"", "unknown", "n/a", "none", "not available", "not provided"}:
                return ""
            return cleaned

        raw_authors = value.get("authors", [])
        authors = []
        if isinstance(raw_authors, list):
            for author in raw_authors:
                if not isinstance(author, str):
                    continue
                cleaned_author = " ".join(author.split()).strip(" .,:;-")
                if cleaned_author and cleaned_author.lower() not in {
                    "unknown",
                    "n/a",
                    "none",
                    "not available",
                    "not provided",
                }:
                    authors.append(cleaned_author)

        return {
            "title": clean_string("title"),
            "authors": authors,
            "publisher": clean_string("publisher"),
            "publication": clean_string("publication"),
            "publication_date": clean_string("publication_date"),
        }

    def _generate_html(
        self,
        client: Any,
        uploaded_pdf: Any,
        document_information: dict[str, Any],
        document_plan: dict[str, Any],
        visual_explanations: dict[str, Any],
    ) -> str:
        response = self._generate_content(
            client,
            contents=[
                self._read_prompt("html_assembly_prompt.txt"),
                self._json_context(
                    {
                        "document_information": document_information,
                        "document_plan": document_plan,
                        "visual_explanations": visual_explanations,
                    }
                ),
                uploaded_pdf,
            ],
        )
        html = (getattr(response, "text", "") or "").strip()
        if not html:
            raise DocuSenseError(
                "GEMINI_HTML_ASSEMBLY_FAILED",
                "Gemini returned an empty accessible HTML document.",
                status_code=502,
            )
        return html

    def _generate_content(self, client: Any, contents: list[Any], json_response: bool = False) -> Any:
        config = self._generation_config(json_response=json_response)
        generate_kwargs: dict[str, Any] = {
            "model": self._active_gemini_model,
            "contents": contents,
        }
        if config is not None:
            generate_kwargs["config"] = config

        try:
            return client.models.generate_content(**generate_kwargs)
        except Exception as exc:
            fallback_model = self._fallback_model_for(exc)
            if not fallback_model:
                raise

            previous_model = self._active_gemini_model
            self._active_gemini_model = fallback_model
            logger.warning(
                "[docusense] gemini_model_fallback from_model=%s to_model=%s reason=%s",
                previous_model,
                fallback_model,
                exc.__class__.__name__,
            )
            generate_kwargs["model"] = self._active_gemini_model
            return client.models.generate_content(**generate_kwargs)

    @staticmethod
    def _generation_config(json_response: bool) -> Any | None:
        if not json_response:
            return None
        try:
            from google.genai import types
        except ImportError:
            return None
        return types.GenerateContentConfig(response_mime_type="application/json")

    def _fallback_model_for(self, exc: Exception) -> str:
        fallback_model = self.settings.gemini_fallback_model.strip()
        if not fallback_model:
            return ""
        if self._active_gemini_model != self.settings.gemini_model:
            return ""
        if fallback_model == self._active_gemini_model:
            return ""
        if self.settings.gemini_model != "gemini-2.5-flash":
            return ""
        if not self._is_capacity_error(exc):
            return ""
        return fallback_model

    @classmethod
    def _is_capacity_error(cls, exc: Exception) -> bool:
        status_code = getattr(exc, "status_code", None) or getattr(exc, "code", None)
        if status_code in {429, 503}:
            return True

        details = " ".join(
            str(part)
            for part in (
                exc,
                getattr(exc, "message", ""),
                getattr(exc, "status", ""),
                getattr(exc, "reason", ""),
            )
            if part
        ).lower()
        return any(marker in details for marker in cls._FALLBACK_ERROR_MARKERS)

    def _run_stage(
        self,
        name: str,
        job_id: str,
        stage_results: list[ProcessingStageResult],
        func: Callable[[], Any],
        default_error_code: str | None = None,
    ) -> Any:
        started = time.perf_counter()
        logger.info("[docusense] job=%s stage=%s status=started", job_id, name)
        try:
            result = func()
        except DocuSenseError as exc:
            duration_ms = self._elapsed_ms(started)
            stage_results.append(
                ProcessingStageResult(
                    name=name,
                    status="failed",
                    duration_ms=duration_ms,
                    error_code=exc.error_code,
                    message=exc.message,
                )
            )
            logger.exception(
                "[docusense] job=%s stage=%s status=failed duration_ms=%s error_code=%s message=%s",
                job_id,
                name,
                duration_ms,
                exc.error_code,
                exc.message,
            )
            raise
        except Exception as exc:
            duration_ms = self._elapsed_ms(started)
            error_code = default_error_code or f"{name.upper()}_FAILED"
            message = self._stage_failure_message(name)
            stage_results.append(
                ProcessingStageResult(
                    name=name,
                    status="failed",
                    duration_ms=duration_ms,
                    error_code=error_code,
                    message=message,
                )
            )
            logger.exception(
                "[docusense] job=%s stage=%s status=failed duration_ms=%s error_code=%s exception=%s",
                job_id,
                name,
                duration_ms,
                error_code,
                exc.__class__.__name__,
            )
            raise DocuSenseError(error_code, message, status_code=502) from exc

        duration_ms = self._elapsed_ms(started)
        output_chars = self._output_chars(result)
        stage_results.append(
            ProcessingStageResult(
                name=name,
                status="completed",
                duration_ms=duration_ms,
                output_chars=output_chars,
            )
        )
        logger.info(
            "[docusense] job=%s stage=%s status=completed duration_ms=%s output_chars=%s",
            job_id,
            name,
            duration_ms,
            output_chars,
        )
        return result

    def _read_prompt(self, filename: str) -> str:
        return (self.prompt_dir / filename).read_text(encoding="utf-8")

    @staticmethod
    def _json_context(payload: dict[str, Any]) -> str:
        return "Structured context for this stage:\n" + json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
        )

    @staticmethod
    def _parse_json_object(text: str) -> dict[str, Any]:
        stripped = text.strip()
        if stripped.startswith("```"):
            lines = stripped.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            stripped = "\n".join(lines).strip()

        try:
            parsed = json.loads(stripped, strict=False)
        except json.JSONDecodeError:
            start = stripped.find("{")
            end = stripped.rfind("}")
            if start < 0 or end <= start:
                raise ValueError("No JSON object found.")
            parsed = json.loads(stripped[start : end + 1], strict=False)

        if not isinstance(parsed, dict):
            raise ValueError("Stage output must be a JSON object.")
        return parsed

    @staticmethod
    def _elapsed_ms(started: float) -> int:
        return round((time.perf_counter() - started) * 1000)

    @staticmethod
    def _output_chars(result: Any) -> int:
        if isinstance(result, str):
            return len(result)
        if result is None:
            return 0
        try:
            return len(json.dumps(result, ensure_ascii=False))
        except TypeError:
            return 0

    @staticmethod
    def _stage_failure_message(stage_name: str) -> str:
        return f"DocuSense failed during the {stage_name.replace('_', ' ')} stage."
