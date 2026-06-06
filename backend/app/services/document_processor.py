from abc import ABC, abstractmethod
from pathlib import Path


class DocumentProcessor(ABC):
    @abstractmethod
    async def process_pdf(self, pdf_path: Path, job_id: str, page_count: int) -> dict:
        pass
