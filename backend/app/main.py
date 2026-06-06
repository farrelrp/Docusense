import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.logging_config import configure_logging
from app.routes import jobs, results
from app.services.errors import DocuSenseError

settings = get_settings()
configure_logging()
logger = logging.getLogger("docusense")

app = FastAPI(
    title="DocuSense API",
    description="Prototype backend for accessible research paper conversion.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"chrome-extension://.*|edge-extension://.*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs.router)
app.include_router(results.router)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.exception_handler(DocuSenseError)
async def docusense_error_handler(_: Request, exc: DocuSenseError):
    logger.error(
        "[docusense] status=error error_code=%s message=%s",
        exc.error_code,
        exc.message,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "status": "error",
            "error_code": exc.error_code,
            "message": exc.message,
        },
    )


@app.exception_handler(Exception)
async def unknown_error_handler(_: Request, exc: Exception):
    logger.exception(
        "[docusense] status=error error_code=UNKNOWN_ERROR exception=%s",
        exc.__class__.__name__,
    )
    return JSONResponse(
        status_code=500,
        content={
            "status": "error",
            "error_code": "UNKNOWN_ERROR",
            "message": "DocuSense hit an unexpected backend error.",
        },
    )
