import hashlib
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
        self.content_cache_path = settings.storage_root / "content_cache.json"
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
        return self._get_cached_job_id(self._read_url_cache(), url, self.delete_url_cache_entry)

    def get_cached_content_job_id(self, content_hash: str) -> Optional[str]:
        cached_job_id = self._get_cached_job_id(
            self._read_content_cache(),
            content_hash,
            self.delete_content_cache_entry,
        )
        if cached_job_id:
            return cached_job_id

        existing_job_id = self._find_existing_job_by_content_hash(content_hash)
        if existing_job_id:
            self.save_content_cache_entry(content_hash, existing_job_id)
        return existing_job_id

    def _get_cached_job_id(
        self,
        cache: dict[str, str],
        key: str,
        delete_entry,
    ) -> Optional[str]:
        job_id = cache.get(key)
        if not job_id:
            return None
        if not (self.root / job_id / "result.html").exists():
            delete_entry(key)
            return None
        return job_id

    def save_url_cache_entry(self, url: str, job_id: str) -> None:
        cache = self._read_url_cache()
        cache[url] = job_id
        self._write_url_cache(cache)

    def save_content_cache_entry(self, content_hash: str, job_id: str) -> None:
        cache = self._read_content_cache()
        cache[content_hash] = job_id
        self._write_content_cache(cache)

    def delete_url_cache_entry(self, url: str) -> None:
        cache = self._read_url_cache()
        if url in cache:
            del cache[url]
            self._write_url_cache(cache)

    def delete_content_cache_entry(self, content_hash: str) -> None:
        cache = self._read_content_cache()
        if content_hash in cache:
            del cache[content_hash]
            self._write_content_cache(cache)

    def _read_url_cache(self) -> dict[str, str]:
        return self._read_cache_file(self.cache_path)

    def _read_content_cache(self) -> dict[str, str]:
        return self._read_cache_file(self.content_cache_path)

    def _read_cache_file(self, path: Path) -> dict[str, str]:
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(url): str(job_id) for url, job_id in data.items()}

    def _write_url_cache(self, cache: dict[str, str]) -> None:
        self._write_cache_file(self.cache_path, cache)

    def _write_content_cache(self, cache: dict[str, str]) -> None:
        self._write_cache_file(self.content_cache_path, cache)

    def _write_cache_file(self, path: Path, cache: dict[str, str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _find_existing_job_by_content_hash(self, content_hash: str) -> Optional[str]:
        for pdf_path in self.root.glob("*/original.pdf"):
            job_id = pdf_path.parent.name
            if not (pdf_path.parent / "result.html").exists():
                continue
            if self._hash_file(pdf_path) == content_hash:
                return job_id
        return None

    def _hash_file(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
