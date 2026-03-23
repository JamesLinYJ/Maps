from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .ai_layer import ProviderConfigurationError, UpstreamProviderError
from .schemas import HandleTurnRequest, HandleTurnResponse, RuntimeConfigResponse
from .service import AssistantService

app = FastAPI(title="Maps Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

service = AssistantService()
DIST_DIR = Path(__file__).resolve().parents[3] / "dist" / "web"
INDEX_FILE = DIST_DIR / "index.html"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/runtime", response_model=RuntimeConfigResponse)
def get_runtime() -> RuntimeConfigResponse:
    inspection = service.inspect_runtime(service.default_runtime)
    return RuntimeConfigResponse(
        runtime=service.default_runtime,
        bindings=inspection["bindings"],
        warnings=inspection["warnings"],
        architectureSummary=inspection["architectureSummary"],
        stack=inspection["stack"],
    )


@app.post("/api/turn", response_model=HandleTurnResponse)
def handle_turn(payload: HandleTurnRequest) -> HandleTurnResponse:
    try:
        return service.handle_turn(
            runtime=payload.runtime,
            session_id=payload.session_id,
            transcript_text=payload.transcript_text,
            map_context=payload.map_context.model_dump(by_alias=True),
        )
    except ProviderConfigurationError as error:
        # 缺少真实 provider 配置时直接返回 503，避免静默退回占位逻辑。
        raise HTTPException(status_code=503, detail=str(error)) from error
    except UpstreamProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/")
def serve_index() -> FileResponse:
    if not INDEX_FILE.exists():
        raise HTTPException(
            status_code=404,
            detail="Frontend build not found. Run `npm run build` before production startup.",
        )
    return FileResponse(INDEX_FILE)


@app.get("/{full_path:path}")
def serve_frontend_asset(full_path: str):
    if full_path.startswith(("api/", "health")):
        raise HTTPException(status_code=404, detail="Not found")

    candidate = DIST_DIR / full_path
    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)

    if INDEX_FILE.exists():
        return FileResponse(INDEX_FILE)

    raise HTTPException(
        status_code=404,
        detail="Frontend build not found. Run `npm run build` before production startup.",
    )
