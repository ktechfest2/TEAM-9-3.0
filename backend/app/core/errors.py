from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: Any = None):
        self.code, self.message, self.status_code, self.details = (
            code,
            message,
            status_code,
            details,
        )


def payload(request: Request, code: str, message: str, details: Any = None) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": getattr(request.state, "request_id", None),
        }
    }


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        return JSONResponse(
            status_code=exc.status_code,
            content=payload(request, exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Pydantic puts the raised ValueError object in `ctx`; it is not JSON-serialisable and
        # used to turn every custom validator failure (e.g. vote-sum checks) into an HTTP 500.
        details = []
        for item in exc.errors():
            clean = {k: v for k, v in item.items() if k not in ("ctx", "url")}
            if "ctx" in item:
                clean["ctx"] = {k: str(v) for k, v in item["ctx"].items()}
            details.append(clean)
        first = details[0]["msg"].removeprefix("Value error, ") if details else ""
        message = first if details and details[0].get("type") == "value_error" else ""
        return JSONResponse(
            status_code=422,
            content=payload(
                request, "validation_error", message or "Request validation failed", details
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content=payload(request, f"http_{exc.status_code}", str(exc.detail)),
        )
