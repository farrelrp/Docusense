import ipaddress
import socket
from pathlib import Path
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
from fastapi import UploadFile
from pypdf import PdfReader

from app.config import Settings
from app.services.errors import DocuSenseError

PDF_SIGNATURE = b"%PDF"


def is_pdf_bytes(data: bytes) -> bool:
    return data.startswith(PDF_SIGNATURE)


def ensure_pdf_upload(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    if content_type != "application/pdf" and not filename.endswith(".pdf"):
        raise DocuSenseError(
            "INVALID_FILE_TYPE",
            "Please upload a PDF file.",
            status_code=415,
        )


async def save_upload(file: UploadFile, settings: Settings) -> Path:
    ensure_pdf_upload(file)
    incoming_dir = settings.storage_root / "incoming"
    incoming_dir.mkdir(parents=True, exist_ok=True)
    destination = incoming_dir / f"{uuid4()}.pdf"
    total = 0

    with destination.open("wb") as output:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > settings.max_pdf_size_bytes:
                destination.unlink(missing_ok=True)
                raise DocuSenseError(
                    "PDF_TOO_LARGE",
                    "This PDF is larger than the prototype limit of 25 MB.",
                    status_code=413,
                )
            output.write(chunk)

    with destination.open("rb") as pdf_file:
        if not is_pdf_bytes(pdf_file.read(4)):
            destination.unlink(missing_ok=True)
            raise DocuSenseError("INVALID_FILE_TYPE", "The uploaded file is not a valid PDF.", 415)

    return destination


def count_pages(pdf_path: Path) -> int:
    try:
        reader = PdfReader(str(pdf_path))
        return len(reader.pages)
    except Exception as exc:
        raise DocuSenseError(
            "PDF_PAGE_COUNT_FAILED",
            "DocuSense could not read the PDF page count.",
            status_code=400,
        ) from exc


def _host_is_internal(hostname: str) -> bool:
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return True

    try:
        addresses = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise DocuSenseError("PDF_DOWNLOAD_FAILED", "DocuSense could not resolve this PDF URL.")

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return True
    return False


def validate_remote_pdf_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise DocuSenseError("PDF_DOWNLOAD_FAILED", "Please provide an HTTP or HTTPS PDF URL.")
    if _host_is_internal(parsed.hostname):
        raise DocuSenseError(
            "PDF_DOWNLOAD_FAILED",
            "DocuSense cannot download PDFs from local or private network addresses.",
        )


async def download_pdf(url: str, settings: Settings) -> Path:
    incoming_dir = settings.storage_root / "incoming"
    incoming_dir.mkdir(parents=True, exist_ok=True)
    destination = incoming_dir / f"{uuid4()}.pdf"
    total = 0
    current_url = url

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=30.0) as client:
            for redirect_count in range(6):
                validate_remote_pdf_url(current_url)
                async with client.stream("GET", current_url) as response:
                    if response.is_redirect:
                        if redirect_count == 5:
                            raise DocuSenseError(
                                "PDF_DOWNLOAD_FAILED",
                                "The PDF URL redirected too many times.",
                            )
                        location = response.headers.get("location")
                        if not location:
                            raise DocuSenseError(
                                "PDF_DOWNLOAD_FAILED",
                                "The PDF URL redirected without a destination.",
                            )
                        current_url = urljoin(current_url, location)
                        continue

                    response.raise_for_status()
                    validate_remote_pdf_url(str(response.url))

                    content_length = response.headers.get("content-length")
                    try:
                        declared_size = int(content_length) if content_length else 0
                    except ValueError:
                        declared_size = 0
                    if declared_size > settings.max_pdf_size_bytes:
                        raise DocuSenseError(
                            "PDF_TOO_LARGE",
                            "This PDF is larger than the prototype limit of 25 MB.",
                            status_code=413,
                        )

                    content_type = response.headers.get("content-type", "").lower()
                    first_chunk = True

                    with destination.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if not chunk:
                                continue
                            total += len(chunk)
                            if total > settings.max_pdf_size_bytes:
                                destination.unlink(missing_ok=True)
                                raise DocuSenseError(
                                    "PDF_TOO_LARGE",
                                    "This PDF is larger than the prototype limit of 25 MB.",
                                    status_code=413,
                                )
                            if first_chunk:
                                first_chunk = False
                                if "pdf" not in content_type and not is_pdf_bytes(chunk[:4]):
                                    destination.unlink(missing_ok=True)
                                    raise DocuSenseError(
                                        "INVALID_FILE_TYPE",
                                        "The URL did not return a PDF file.",
                                        status_code=415,
                                    )
                            output.write(chunk)
                    break
            else:
                raise DocuSenseError(
                    "PDF_DOWNLOAD_FAILED",
                    "The PDF URL redirected too many times.",
                )
    except DocuSenseError:
        raise
    except httpx.HTTPError as exc:
        destination.unlink(missing_ok=True)
        raise DocuSenseError(
            "PDF_DOWNLOAD_FAILED",
            "DocuSense could not download the PDF from this URL.",
        ) from exc

    if total == 0:
        destination.unlink(missing_ok=True)
        raise DocuSenseError("PDF_DOWNLOAD_FAILED", "The PDF URL returned an empty file.")

    return destination
