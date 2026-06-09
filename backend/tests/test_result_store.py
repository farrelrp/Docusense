from pathlib import Path
import hashlib
from tempfile import TemporaryDirectory
import unittest

from app.config import Settings
from app.services.result_store import ResultStore


class ResultStoreTest(unittest.TestCase):
    def test_url_cache_returns_existing_job_and_drops_missing_result(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            store = ResultStore(settings)

            pdf_path = Path(tmpdir) / "source.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")
            store.save(
                "job-1",
                pdf_path,
                "<!doctype html><html><body>Result</body></html>",
                {"page_count": 3},
            )

            store.save_url_cache_entry("https://example.com/paper.pdf", "job-1")

            self.assertEqual(
                store.get_cached_url_job_id("https://example.com/paper.pdf"),
                "job-1",
            )

            (Path(tmpdir) / "jobs" / "job-1" / "result.html").unlink()

            self.assertIsNone(store.get_cached_url_job_id("https://example.com/paper.pdf"))
            self.assertIsNone(store.get_cached_url_job_id("https://example.com/paper.pdf"))

    def test_content_cache_returns_existing_job_and_drops_missing_result(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            store = ResultStore(settings)

            pdf_path = Path(tmpdir) / "source.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")
            store.save(
                "job-1",
                pdf_path,
                "<!doctype html><html><body>Result</body></html>",
                {"page_count": 3},
            )

            store.save_content_cache_entry("hash-1", "job-1")

            self.assertEqual(store.get_cached_content_job_id("hash-1"), "job-1")

            (Path(tmpdir) / "jobs" / "job-1" / "result.html").unlink()

            self.assertIsNone(store.get_cached_content_job_id("hash-1"))
            self.assertIsNone(store.get_cached_content_job_id("hash-1"))

    def test_content_cache_discovers_existing_job_by_saved_pdf_hash(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = Settings(TEMP_STORAGE_DIR=Path(tmpdir))
            store = ResultStore(settings)

            pdf_bytes = b"%PDF-1.4\nsame-pdf\n"
            pdf_path = Path(tmpdir) / "source.pdf"
            pdf_path.write_bytes(pdf_bytes)
            store.save(
                "job-1",
                pdf_path,
                "<!doctype html><html><body>Result</body></html>",
                {"page_count": 3},
            )

            content_hash = hashlib.sha256(pdf_bytes).hexdigest()

            self.assertEqual(store.get_cached_content_job_id(content_hash), "job-1")
            self.assertEqual(store._read_content_cache()[content_hash], "job-1")


if __name__ == "__main__":
    unittest.main()
