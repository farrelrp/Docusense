from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
