from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import httpx


DEFAULT_DEVIN_API_BASE_URL = "https://api.devin.ai/v3"


@dataclass(frozen=True, slots=True)
class DevinSettings:
    api_key: str | None = None
    org_id: str | None = None
    api_base_url: str = DEFAULT_DEVIN_API_BASE_URL
    repos: tuple[str, ...] = ()
    mode: str = "normal"


class DevinAPIError(RuntimeError):
    pass


class DevinClient:
    def __init__(
        self,
        settings: DevinSettings,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self._http = http_client or httpx.AsyncClient(timeout=30)
        self._owns_http_client = http_client is None

    async def create_session(
        self,
        *,
        prompt: str,
        title: str | None = None,
        tags: Iterable[str] = (),
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "prompt": prompt,
            "bypass_approval": True,
            "structured_output_required": False,
        }
        if title:
            payload["title"] = title
        if self.settings.repos:
            payload["repos"] = list(self.settings.repos)
        if self.settings.mode:
            payload["devin_mode"] = self.settings.mode
        tag_list = [tag for tag in tags if tag]
        if tag_list:
            payload["tags"] = tag_list

        return await self._request(
            "POST",
            f"/organizations/{self._org_id()}/sessions",
            json=payload,
        )

    async def get_session(self, devin_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/organizations/{self._org_id()}/sessions/{devin_id}",
        )

    async def send_message(self, devin_id: str, message: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/organizations/{self._org_id()}/sessions/{devin_id}/messages",
            json={"message": message},
        )

    async def list_messages(
        self,
        devin_id: str,
        *,
        after: str | None = None,
        first: int = 100,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"first": first}
        if after:
            params["after"] = after
        return await self._request(
            "GET",
            f"/organizations/{self._org_id()}/sessions/{devin_id}/messages",
            params=params,
        )

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        api_key = self.settings.api_key
        if not api_key:
            raise DevinAPIError("DEVIN_API_KEY is required")

        url = self.settings.api_base_url.rstrip("/") + path
        response = await self._http.request(
            method,
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json=json,
            params=params,
        )
        if response.status_code >= 400:
            raise DevinAPIError(_response_error_message(response))
        data = response.json()
        if not isinstance(data, dict):
            raise DevinAPIError("Devin API returned a non-object response")
        return data

    def _org_id(self) -> str:
        if not self.settings.org_id:
            raise DevinAPIError("DEVIN_ORG_ID is required")
        return self.settings.org_id


def progress_phrase(session: dict[str, Any]) -> str:
    status = session.get("status")
    detail = session.get("status_detail")

    if status == "new":
        return "Devin is queued..."
    if status == "claimed":
        return "Starting Devin session..."
    if status == "resuming":
        return "Devin is resuming..."
    if detail == "waiting_for_approval":
        return "Devin is blocked by approval settings. Enable autonomous sessions or verify bypass_approval permissions."
    if status == "running" and detail == "waiting_for_user":
        return "Devin needs user input..."
    if status == "running" and detail == "finished":
        return "Devin is finishing up..."
    if status == "running":
        return "Devin is working..."
    if status == "exit":
        return "Devin finished."
    if status == "error" or detail == "error":
        return "Devin failed."
    if detail == "usage_limit_exceeded":
        return "Devin stopped: usage limit exceeded."
    if detail in {"out_of_credits", "out_of_quota", "no_quota_allocation"}:
        return "Devin stopped: quota is unavailable."
    if detail == "payment_declined":
        return "Devin stopped: payment was declined."
    if status == "suspended":
        return "Devin stopped."
    return "Checking Devin status..."


def is_terminal_session(session: dict[str, Any]) -> bool:
    return session.get("status") in {"exit", "error", "suspended"}


def is_approval_blocked(session: dict[str, Any]) -> bool:
    return session.get("status_detail") == "waiting_for_approval"


def _response_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"Devin API request failed with HTTP {response.status_code}"

    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, str):
        return f"Devin API request failed with HTTP {response.status_code}: {detail}"
    return f"Devin API request failed with HTTP {response.status_code}: {payload}"
