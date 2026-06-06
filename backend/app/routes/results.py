from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from app.config import Settings, get_settings
from app.services.result_store import ResultStore

router = APIRouter(prefix="/api/results", tags=["results"])


@router.get("/{job_id}", response_class=HTMLResponse)
async def get_result_page(job_id: str, settings: Settings = Depends(get_settings)):
    return HTMLResponse(ResultStore(settings).get_html(job_id))


@router.get("/{job_id}/json")
async def get_result_json(job_id: str, settings: Settings = Depends(get_settings)):
    return ResultStore(settings).get_metadata(job_id)
