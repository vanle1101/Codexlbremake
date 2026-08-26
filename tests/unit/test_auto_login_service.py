from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.modules.accounts.auto_login import AutoLoginService
from app.modules.accounts.schemas import AutoLoginAccountItem
from app.modules.oauth.schemas import OauthStartResponse


@pytest.mark.asyncio
async def test_auto_login_service_lifecycle() -> None:
    service = AutoLoginService()
    state = await service.get_state()
    assert state.status == "idle"
    assert state.queue == []

    mock_oauth_service = MagicMock()
    mock_oauth_service.start_oauth = AsyncMock(
        return_value=OauthStartResponse(
            flow_id="test-flow",
            method="browser",
            authorization_url="https://auth.openai.com/oauth/authorize?test=1",
            callback_url="http://localhost:1455/auth/callback",
        )
    )
    mock_oauth_service.oauth_status = AsyncMock(return_value=MagicMock(status="success"))

    accounts = [
        AutoLoginAccountItem(
            email="test1@example.com",
            password="pass1",
            two_factor_secret="JBSWY3DPEHPK3PXP",
        )
    ]

    with patch("playwright.async_api.async_playwright") as mock_playwright:
        mock_p_ctx = MagicMock()
        mock_browser = MagicMock()
        mock_context = MagicMock()
        mock_page = MagicMock()

        # url is a string property
        mock_page.url = "http://localhost:1455/auth/callback?code=123&state=abc"
        mock_page.goto = AsyncMock()
        mock_locator = MagicMock()
        mock_element = MagicMock()
        mock_element.wait_for = AsyncMock()
        mock_element.fill = AsyncMock()
        mock_element.click = AsyncMock()
        mock_element.is_visible = AsyncMock(return_value=True)
        mock_element.inner_text = AsyncMock(return_value="")
        mock_element.scroll_into_view_if_needed = AsyncMock()
        mock_element.evaluate = AsyncMock()
        mock_locator.first = mock_element
        mock_locator.count = AsyncMock(return_value=0)
        mock_locator.inner_text = AsyncMock(return_value="")
        mock_page.locator.return_value = mock_locator
        mock_page.keyboard = MagicMock()
        mock_page.keyboard.press = AsyncMock()
        mock_page.frames = []

        mock_context.new_page = AsyncMock(return_value=mock_page)
        mock_context.add_init_script = AsyncMock()
        mock_context.close = AsyncMock()
        mock_browser.new_context = AsyncMock(return_value=mock_context)
        mock_browser.close = AsyncMock()
        mock_p_ctx.chromium.launch = AsyncMock(return_value=mock_browser)
        mock_playwright.return_value.__aenter__ = AsyncMock(return_value=mock_p_ctx)
        mock_playwright.return_value.__aexit__ = AsyncMock()

        started_state = await service.start(
            accounts=accounts,
            oauth_service=mock_oauth_service,
            delay_seconds=1,
            headless=True,
        )
        assert started_state.status == "running"
        assert len(started_state.queue) == 1

        # Wait for worker task to complete
        if service._task:
            await service._task

        final_state = await service.get_state()
        assert final_state.status == "finished"
        assert final_state.queue[0].status == "SUCCESS"


@pytest.mark.asyncio
async def test_auto_login_service_pause_resume_cancel() -> None:
    service = AutoLoginService()
    service._status = "running"

    paused = await service.pause()
    assert paused.status == "paused"

    resumed = await service.resume()
    assert resumed.status == "running"

    cancelled = await service.cancel()
    assert cancelled.status == "idle"
