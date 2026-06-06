import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.config import Settings
from app.services.errors import DocuSenseError


class ResultStore:
    def __init__(self, settings: Settings) -> None:
        self.root = settings.storage_root / "jobs"
        self.cache_path = settings.storage_root / "url_cache.json"
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, job_id: str, pdf_path: Path, html: str, metadata: dict) -> None:
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=False)
        shutil.copy2(pdf_path, job_dir / "original.pdf")
        (job_dir / "result.html").write_text(html, encoding="utf-8")

        metadata_with_time = {
            **metadata,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        (job_dir / "metadata.json").write_text(
            json.dumps(metadata_with_time, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def get_html(self, job_id: str) -> str:
        path = self.root / job_id / "result.html"
        if not path.exists():
            raise DocuSenseError("RESULT_NOT_FOUND", "DocuSense could not find this result.", 404)
        return path.read_text(encoding="utf-8")

    def get_metadata(self, job_id: str) -> dict:
        path = self.root / job_id / "metadata.json"
        if not path.exists():
            raise DocuSenseError("RESULT_NOT_FOUND", "DocuSense could not find this result.", 404)
        return json.loads(path.read_text(encoding="utf-8"))

    def get_cached_url_job_id(self, url: str) -> Optional[str]:
        cache = self._read_url_cache()
        job_id = cache.get(url)
        if not job_id:
            return None
        if not (self.root / job_id / "result.html").exists():
            self.delete_url_cache_entry(url)
            return None
        return job_id

    def save_url_cache_entry(self, url: str, job_id: str) -> None:
        cache = self._read_url_cache()
        cache[url] = job_id
        self._write_url_cache(cache)

    def delete_url_cache_entry(self, url: str) -> None:
        cache = self._read_url_cache()
        if url in cache:
            del cache[url]
            self._write_url_cache(cache)

    def _read_url_cache(self) -> dict[str, str]:
        if not self.cache_path.exists():
            return {}
        try:
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(url): str(job_id) for url, job_id in data.items()}

    def _write_url_cache(self, cache: dict[str, str]) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
