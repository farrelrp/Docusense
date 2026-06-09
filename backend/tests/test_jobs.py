from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from app.config import Settings
from app.models import UrlJobRequest
from app.routes.jobs import create_job_from_url, get_cached_job_from_url
from app.services.result_store import ResultStore


class UrlJobTest(unittest.IsolatedAsyncioTestCase):
    async def test_url_cache_does_not_skip_downloading_current_content(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            store = ResultStore(settings)
            old_pdf = Path(tmpdir) / "old.pdf"
            old_pdf.write_bytes(b"%PDF-1.4\nold content\n")
            store.save(
                "old-job",
                old_pdf,
                "<!doctype html><html><body>Old result</body></html>",
                {"page_count": 12},
            )
            url = "https://example.com/paper.pdf"
            store.save_url_cache_entry(url, "old-job")

            current_pdf = Path(tmpdir) / "current.pdf"
            current_pdf.write_bytes(b"%PDF-1.4\nnew content\n")
            expected = object()

            with (
                patch(
                    "app.routes.jobs.download_pdf",
                    new=AsyncMock(return_value=current_pdf),
                ) as download_mock,
                patch(
                    "app.routes.jobs._process_pdf",
                    new=AsyncMock(return_value=expected),
                ) as process_mock,
            ):
                result = await create_job_from_url(
                    UrlJobRequest(url=url),
                    settings=settings,
                )

            self.assertIs(result, expected)
            download_mock.assert_awaited_once_with(url, settings)
            process_mock.assert_awaited_once_with(
                current_pdf,
                False,
                settings,
                source_type="url",
                source_url=url,
            )

    async def test_url_cache_check_matches_downloaded_content_without_processing(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            store = ResultStore(settings)
            saved_pdf = Path(tmpdir) / "saved.pdf"
            saved_pdf.write_bytes(b"%PDF-1.4\nsame content\n")
            store.save(
                "saved-job",
                saved_pdf,
                "<!doctype html><html><body><main><article><p>Saved</p></article></main></body></html>",
                {"page_count": 4},
            )

            current_pdf = Path(tmpdir) / "current.pdf"
            current_pdf.write_bytes(saved_pdf.read_bytes())
            with patch(
                "app.routes.jobs.download_pdf",
                new=AsyncMock(return_value=current_pdf),
            ):
                result = await get_cached_job_from_url(
                    UrlJobRequest(url="https://example.com/paper.pdf"),
                    settings=settings,
                )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.job_id, "saved-job")
            self.assertTrue(result.cached)
            self.assertFalse(current_pdf.exists())

    async def test_url_cache_check_returns_not_found_for_new_content(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            current_pdf = Path(tmpdir) / "current.pdf"
            current_pdf.write_bytes(b"%PDF-1.4\nnew content\n")
            with patch(
                "app.routes.jobs.download_pdf",
                new=AsyncMock(return_value=current_pdf),
            ):
                result = await get_cached_job_from_url(
                    UrlJobRequest(url="https://example.com/paper.pdf"),
                    settings=settings,
                )

            self.assertEqual(result.status, "not_found")
            self.assertFalse(current_pdf.exists())


if __name__ == "__main__":
    unittest.main()
