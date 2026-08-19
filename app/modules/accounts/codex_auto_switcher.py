from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from app.db.models import Account, AccountStatus, UsageHistory
from app.db.session import get_background_session, detach_session_objects
from app.modules.accounts.repository import AccountsRepository
from app.modules.accounts.service import AccountsService
from app.modules.usage.repository import UsageRepository

logger = logging.getLogger(__name__)

_DEFAULT_SWITCH_THRESHOLD_PERCENT = 98.0  # Chuyển khi còn 2% hạn mức (đã dùng 98%)


class CodexDesktopAutoSwitcher:
    def __init__(self, threshold_percent: float = _DEFAULT_SWITCH_THRESHOLD_PERCENT) -> None:
        self.threshold_percent = threshold_percent
        self.enabled = True
        self._running_task: asyncio.Task[None] | None = None
        self._last_switch_time: float = 0.0
        self._last_switch_info: dict[str, Any] | None = None

    async def check_and_auto_rotate(self) -> dict[str, Any] | None:
        """
        Kiểm tra tài khoản đang hoạt động trong app Codex Desktop.
        Nếu hạn mức đã dùng >= threshold_percent (còn <= 2% dung lượng),
        tự động xoay sang tài khoản khả dụng có nhiều hạn mức nhất.
        """
        if not self.enabled:
            return None

        # Không xoay quá nhanh (ít nhất 20s giữa các lần đổi để app ổn định)
        if time.time() - self._last_switch_time < 20:
            return None

        codex_home = Path.home() / ".codex"
        projection_file = codex_home / ".cockpit_codex_auth.json"
        auth_file = codex_home / "auth.json"

        active_account_id: str | None = None
        active_email: str | None = None

        if projection_file.exists():
            try:
                data = json.loads(projection_file.read_text(encoding="utf-8"))
                active_account_id = data.get("account_id")
                active_email = data.get("email")
            except Exception:
                pass

        if not active_email and auth_file.exists():
            try:
                data = json.loads(auth_file.read_text(encoding="utf-8"))
                tokens = data.get("tokens") or {}
                id_token = tokens.get("id_token") or tokens.get("access_token")
                active_account_id = tokens.get("account_id")
                if id_token:
                    parts = id_token.split(".")
                    if len(parts) >= 2:
                        import base64
                        padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
                        claims = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
                        active_email = claims.get("email") or (claims.get("https://api.openai.com/profile") or {}).get("email")
            except Exception:
                pass

        if not active_email and not active_account_id:
            return None

        async with get_background_session() as session:
            try:
                accounts_repo = AccountsRepository(session)
                usage_repo = UsageRepository(session)
                accounts_service = AccountsService(repo=accounts_repo, usage_repo=usage_repo)

                # 1. Tìm tài khoản đang active
                active_account: Account | None = None
                if active_account_id:
                    active_account = await accounts_repo.get_by_id(active_account_id)
                if not active_account and active_email:
                    active_account = await accounts_repo.get_by_email(active_email)

                if not active_account:
                    return None

                # 2. Kiểm tra mức sử dụng hiện tại
                latest_usage: UsageHistory | None = await usage_repo.latest_entry_for_account(active_account.id)
                used_percent = float(latest_usage.used_percent) if latest_usage and latest_usage.used_percent is not None else 0.0

                is_exhausted = (
                    active_account.status in (AccountStatus.QUOTA_EXCEEDED, AccountStatus.RATE_LIMITED, AccountStatus.DEACTIVATED, AccountStatus.REAUTH_REQUIRED, AccountStatus.PAUSED)
                    or used_percent >= self.threshold_percent
                )

                if not is_exhausted:
                    return None

                logger.info(
                    f"[Codex Auto-Rotate] ⚠️ Tài khoản {active_account.email} đã dùng {used_percent:.1f}% hạn mức "
                    f"(Ngưỡng kích hoạt: {self.threshold_percent}% - Còn <= 2%). Bắt đầu tìm tài khoản thay thế..."
                )

                # 3. Tìm các tài khoản ACTIVE còn nhiều hạn mức nhất
                all_accounts = await accounts_repo.list_accounts()
                candidates = [
                    a for a in all_accounts
                    if a.id != active_account.id
                    and a.status == AccountStatus.ACTIVE
                    and a.tokens_enc
                ]

                if not candidates:
                    logger.warning("[Codex Auto-Rotate] ❌ Không còn tài khoản ACTIVE nào khả dụng để đổi!")
                    return None

                # 4. Đánh giá mức sử dụng của từng ứng viên
                best_candidate: Account | None = None
                best_used_pct = 999.0

                for candidate in candidates:
                    u = await usage_repo.latest_entry_for_account(candidate.id)
                    pct = float(u.used_percent) if u and u.used_percent is not None else 0.0
                    if pct < best_used_pct and pct < self.threshold_percent:
                        best_used_pct = pct
                        best_candidate = candidate

                if not best_candidate:
                    # Nếu tất cả đều trên threshold, chọn acc có % thấp nhất
                    candidates_with_pct = []
                    for candidate in candidates:
                        u = await usage_repo.latest_entry_for_account(candidate.id)
                        pct = float(u.used_percent) if u and u.used_percent is not None else 0.0
                        candidates_with_pct.append((candidate, pct))
                    candidates_with_pct.sort(key=lambda x: x[1])
                    best_candidate, best_used_pct = candidates_with_pct[0]

                # 5. Thực hiện hoán đổi sang tài khoản mới
                logger.info(
                    f"[Codex Auto-Rotate] 🚀 Tiến hành đổi sang tài khoản mới: {best_candidate.email} "
                    f"(Đã dùng: {best_used_pct:.1f}%, Khả dụng: {100 - best_used_pct:.1f}%)..."
                )

                res = await accounts_service.switch_to_codex(best_candidate.id)
                self._last_switch_time = time.time()
                self._last_switch_info = {
                    "from_email": active_account.email,
                    "from_usage_percent": used_percent,
                    "to_email": best_candidate.email,
                    "to_usage_percent": best_used_pct,
                    "switched_at": int(self._last_switch_time),
                    "message": res.message,
                }

                logger.info(
                    f"[Codex Auto-Rotate] ✅ Hoàn tất đổi tài khoản! "
                    f"Từ {active_account.email} ({used_percent:.1f}%) -> {best_candidate.email} ({best_used_pct:.1f}%)"
                )
                return self._last_switch_info

            finally:
                detach_session_objects(session)

    async def _background_loop(self) -> None:
        logger.info(f"[Codex Auto-Rotate Daemon] Đã khởi động! Ngưỡng đổi: {self.threshold_percent}% (Còn 2%).")
        while self.enabled:
            try:
                await self.check_and_auto_rotate()
            except Exception as e:
                logger.debug(f"[Codex Auto-Rotate Daemon] Lỗi kiểm tra: {e}")
            await asyncio.sleep(20)

    def start(self) -> None:
        if self._running_task is None or self._running_task.done():
            self._running_task = asyncio.create_task(self._background_loop())

    def stop(self) -> None:
        self.enabled = False
        if self._running_task and not self._running_task.done():
            self._running_task.cancel()


# Singleton instance
_auto_switcher_instance: CodexDesktopAutoSwitcher | None = None


def get_codex_auto_switcher() -> CodexDesktopAutoSwitcher:
    global _auto_switcher_instance
    if _auto_switcher_instance is None:
        _auto_switcher_instance = CodexDesktopAutoSwitcher(threshold_percent=_DEFAULT_SWITCH_THRESHOLD_PERCENT)
    return _auto_switcher_instance
