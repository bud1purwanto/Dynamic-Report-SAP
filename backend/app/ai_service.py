import json
import logging
from typing import Any, Tuple
import httpx

from .config import settings

logger = logging.getLogger("lumina.ai")


async def call_openai_compatible_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    timeout: float = 90.0,
    response_format: dict[str, str] | None = None,
) -> str:
    """Call an OpenAI-compatible /chat/completions endpoint with robust streaming support."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if response_format:
        payload["response_format"] = response_format

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as res:
            res.raise_for_status()
            content_type = res.headers.get("content-type", "")

            # Check if SSE stream
            if "text/event-stream" in content_type:
                collected_chunks: list[str] = []
                async for line in res.aiter_lines():
                    line = line.strip()
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            choices = chunk.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                if delta.get("content"):
                                    collected_chunks.append(delta["content"])
                        except Exception:
                            continue
                content = "".join(collected_chunks).strip()
                if not content:
                    raise ValueError("Respons AI stream kosong.")
                return content
            else:
                # Regular body
                raw_bytes = await res.aread()
                text_content = raw_bytes.decode("utf-8", errors="replace").strip()
                if text_content.startswith("data: "):
                    collected_chunks: list[str] = []
                    for line in text_content.splitlines():
                        line = line.strip()
                        if line.startswith("data: "):
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                choices = chunk.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    if delta.get("content"):
                                        collected_chunks.append(delta["content"])
                            except Exception:
                                continue
                    content = "".join(collected_chunks).strip()
                    if not content:
                        raise ValueError("Respons AI stream kosong.")
                    return content

                data = json.loads(text_content)
                choices = data.get("choices")
                if not choices or not isinstance(choices, list):
                    raise ValueError(f"Respons AI tidak valid (tidak ada pilihan): {data}")
                content = choices[0].get("message", {}).get("content", "")
                if not content:
                    raise ValueError("Respons AI kosong.")
                return content


async def query_llm_with_fallback(
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    timeout: float = 75.0,
) -> Tuple[str, str]:
    """Execute chat completion with automatic fallback from 9Router to OpenRouter.

    Returns:
        Tuple[content, provider_name_used]
    """
    errors: list[str] = []

    # 1. Try 9Router (Primary / Local Proxy)
    if settings.nine_router_base_url:
        try:
            logger.info("Mencoba AI Primary: 9Router (%s)", settings.nine_router_model)
            content = await call_openai_compatible_chat(
                base_url=settings.nine_router_base_url,
                api_key=settings.nine_router_api_key,
                model=settings.nine_router_model,
                messages=messages,
                temperature=temperature,
                timeout=timeout,
                response_format={"type": "json_object"},
            )
            return content, "AI Service"
        except Exception as exc:
            err_msg = f"Layanan AI utama gagal: {exc}"
            logger.warning("9Router gagal: %s", exc)
            errors.append(err_msg)

    # 2. Try OpenRouter (Fallback / Cloud)
    if settings.openrouter_base_url and settings.openrouter_api_key:
        # Try primary OpenRouter model first, then fallback model
        models_to_try = [settings.openrouter_model]
        if settings.openrouter_fallback_model and settings.openrouter_fallback_model != settings.openrouter_model:
            models_to_try.append(settings.openrouter_fallback_model)

        for or_model in models_to_try:
            try:
                logger.info("Mencoba AI Fallback: OpenRouter (%s)", or_model)
                content = await call_openai_compatible_chat(
                    base_url=settings.openrouter_base_url,
                    api_key=settings.openrouter_api_key,
                    model=or_model,
                    messages=messages,
                    temperature=temperature,
                    timeout=timeout,
                    response_format={"type": "json_object"},
                )
                return content, "AI Service"
            except Exception as exc:
                err_msg = f"Layanan AI cadangan gagal: {exc}"
                logger.warning("OpenRouter (%s) gagal: %s", or_model, exc)
                errors.append(err_msg)

    # 3. Optional Local Ollama fallback if configured
    if settings.ollama_base_url and settings.ollama_model:
        try:
            logger.info("Mencoba AI Ollama Lokal (%s)", settings.ollama_model)
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.post(
                    f"{settings.ollama_base_url}/api/chat",
                    json={
                        "model": settings.ollama_model,
                        "stream": False,
                        "format": "json",
                        "options": {"temperature": temperature},
                        "messages": messages,
                    },
                )
                res.raise_for_status()
                content = res.json()["message"]["content"].strip()
                return content, "AI Service"
        except Exception as exc:
            err_msg = f"Layanan AI lokal gagal: {exc}"
            logger.warning("Ollama gagal: %s", exc)
            errors.append(err_msg)

    raise RuntimeError("Layanan AI sedang tidak tersedia atau belum dikonfigurasi: " + " | ".join(errors))


async def check_ai_providers_status() -> dict[str, Any]:
    """Check connectivity and readiness of AI providers."""
    status: dict[str, Any] = {
        "primary": {
            "name": "AI Service",
            "endpoint": settings.nine_router_base_url,
            "model": settings.nine_router_model,
            "configured": bool(settings.nine_router_base_url),
            "online": False,
        },
        "fallback": {
            "name": "AI Service (Cadangan)",
            "endpoint": settings.openrouter_base_url,
            "model": settings.openrouter_model,
            "configured": bool(settings.openrouter_api_key),
            "online": False,
        },
    }

    # Ping 9Router
    if settings.nine_router_base_url:
        try:
            headers = {}
            if settings.nine_router_api_key:
                headers["Authorization"] = f"Bearer {settings.nine_router_api_key}"
            async with httpx.AsyncClient(timeout=4) as client:
                res = await client.get(f"{settings.nine_router_base_url.rstrip('/')}/models", headers=headers)
                status["primary"]["online"] = res.status_code == 200
        except Exception:
            status["primary"]["online"] = False

    # Ping OpenRouter
    if settings.openrouter_api_key:
        try:
            async with httpx.AsyncClient(timeout=4) as client:
                res = await client.get(
                    f"{settings.openrouter_base_url.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                )
                status["fallback"]["online"] = res.status_code == 200
        except Exception:
            status["fallback"]["online"] = False

    return status

