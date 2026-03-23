from fastapi.testclient import TestClient

from apps.backend.app.main import app


client = TestClient(app)


def test_runtime_endpoint_returns_defaults() -> None:
    response = client.get("/api/runtime")
    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["mapMode"] == "internal"
    assert payload["runtime"]["mapProvider"] == "osm"
    assert payload["runtime"]["enableForeignMapExperiments"] is True
    assert len(payload["bindings"]) == 5
    assert "PydanticAI" in payload["architectureSummary"]
    assert any(
        item["stack"] == "Gemini / OpenAI-compatible / Anthropic / LiteLLM gateway"
        for item in payload["stack"]
    )
    assert any(binding["adapterMode"] == "requires_configuration" for binding in payload["bindings"])


def test_turn_endpoint_fails_gracefully_without_llm_credentials() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "china_public",
                "mapProvider": "tianditu",
                "llmProvider": "openai",
                "enableForeignMapExperiments": False,
            },
            "sessionId": "backend-session",
            "transcriptText": "带我看看浦东新区的重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503
    payload = response.json()
    assert "provider" in payload["detail"]


def test_runtime_endpoint_allows_osm_in_experimental_mode() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "experimental",
                "mapProvider": "osm",
                "llmProvider": "openai",
                "enableForeignMapExperiments": True,
            },
            "sessionId": "backend-session-3",
            "transcriptText": "带我看看浦东新区的重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503


def test_turn_endpoint_requires_real_credentials_for_gemini() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "internal",
                "mapProvider": "osm",
                "llmProvider": "gemini",
                "enableForeignMapExperiments": True,
            },
            "sessionId": "backend-session-4",
            "transcriptText": "统计浦东新区有哪些重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503
    payload = response.json()
    assert "Gemini" in payload["detail"] or "provider" in payload["detail"]
