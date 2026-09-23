from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import delete, select

from app.core.crypto import TokenEncryptor
from app.db.models import Account, AccountStatus, StickySession, UsageHistory
from app.db.session import detach_session_objects, get_background_session
from app.modules.accounts.repository import AccountsRepository
from app.modules.accounts.service import AccountsService
from app.modules.usage.repository import UsageRepository

logger = logging.getLogger(__name__)

_DEFAULT_SWITCH_THRESHOLD_PERCENT = 95.0  # Tự động chuyển khi đã dùng >= 95%


class CodexDesktopAutoSwitcher:
    def __init__(self, threshold_percent: float = _DEFAULT_SWITCH_THRESHOLD_PERCENT) -> None:
        self.threshold_percent = threshold_percent
        self.enabled = True
        self._running_task: asyncio.Task[None] | None = None
        self._last_switch_time: float = 0.0
        self._last_switch_info: dict[str, Any] | None = None

    async def _redeem_credit_for_account(
        self, client: httpx.AsyncClient, token: str, chatgpt_account_id: str | None, email: str
    ) -> bool:
        """Kích hoạt gói reset hạn mức miễn phí (Full reset 5h + Weekly) từ OpenAI."""
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        if chatgpt_account_id:
            headers["ChatGPT-Account-Id"] = chatgpt_account_id

        try:
            res = await client.get("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", headers=headers)
            if res.status_code == 200:
                data = res.json()
                credits = data.get("credits", [])
                avail = [c for c in credits if c.get("status") == "available"]
                if avail:
                    cid = avail[0]["id"]
                    body = {
                        "credit_id": cid,
                        "redeem_request_id": str(uuid.uuid4()),
                    }
                    c_res = await client.post(
                        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
                        json=body,
                        headers={**headers, "Content-Type": "application/json"},
                    )
                    if c_res.status_code == 200:
                        logger.info(f"[Codex Auto-Rotate] 🎉 Đã tự động kích hoạt Reset Credit cho {email}! Hạn mức về 0%.")
                        return True
        except Exception as err:
            logger.debug(f"[Codex Auto-Rotate] Lỗi khi kích hoạt reset credit cho {email}: {err}")
        return False

    async def check_and_auto_rotate(self) -> dict[str, Any] | None:
        """
        Kiểm tra tài khoản đang hoạt động trong app Codex Desktop.
        Nếu hết lượt GPT-6 Astra Ultra hoặc đã dùng >= threshold_percent:
        1. Tự động kích hoạt Reset Credit có sẵn để hồi 100% dung lượng ngay lập tức.
        2. Nếu hết Reset Credit, tự động quét kho và đổi sang tài khoản khả dụng tốt nhất.
        """
        if not self.enabled:
            return None

        # Giới hạn tần suất kiểm tra hoán đổi
        if time.time() - self._last_switch_time < 15:
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
                        padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
                        claims = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
                        active_email = claims.get("email") or (claims.get("https://api.openai.com/profile") or {}).get(
                            "email"
                        )
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

                if not active_account or not active_account.access_token_encrypted:
                    return None

                enc = TokenEncryptor()
                token = enc.decrypt(active_account.access_token_encrypted)
                headers = {
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                }
                if active_account.chatgpt_account_id:
                    headers["ChatGPT-Account-Id"] = active_account.chatgpt_account_id

                used_percent = 0.0
                is_exhausted = False
                reset_credits_count = 0

                async with httpx.AsyncClient(timeout=6.0, trust_env=False) as client:
                    try:
                        res = await client.get("https://chatgpt.com/backend-api/wham/usage", headers=headers)
                        if res.status_code == 200:
                            data = res.json()
                            rl = data.get("rate_limit") or {}
                            limit_reached = rl.get("limit_reached", False)
                            allowed = rl.get("allowed", True)
                            pw = rl.get("primary_window") or {}
                            used_percent = float(pw.get("used_percent", 0))

                            mu = data.get("model_usage") or {}
                            astra = mu.get("gpt-6-astra") or {}
                            astra_unavailable = (astra.get("available") is False)

                            reset_credits_count = (data.get("rate_limit_reset_credits") or {}).get(
                                "available_count", 0
                            )

                            if limit_reached or not allowed or used_percent >= self.threshold_percent or astra_unavailable:
                                is_exhausted = True
                        elif res.status_code in (401, 403, 429):
                            is_exhausted = True
                            used_percent = 100.0
                    except Exception as err:
                        logger.debug(f"[Codex Auto-Rotate] Live check error for {active_account.email}: {err}")
                        if active_account.status in (AccountStatus.RATE_LIMITED, AccountStatus.QUOTA_EXCEEDED):
                            is_exhausted = True
                            used_percent = 100.0

                    if not is_exhausted:
                        return None

                    # A. Thử tự động kích hoạt Reset Credit cho chính tài khoản đang active
                    if reset_credits_count > 0:
                        logger.info(
                            f"[Codex Auto-Rotate] ⚡ Tài khoản {active_account.email} chạm giới hạn nhưng có {reset_credits_count} lượt Reset Credit. Đang tự động kích hoạt..."
                        )
                        redeemed = await self._redeem_credit_for_account(
                            client, token, active_account.chatgpt_account_id, active_account.email
                        )
                        if redeemed:
                            active_account.status = AccountStatus.ACTIVE
                            active_account.deactivation_reason = None
                            # Xóa sticky session cũ để các luồng nhận ngay hạn mức mới
                            await session.execute(delete(StickySession).where(StickySession.account_id == active_account.id))
                            await session.commit()
                            self._last_switch_time = time.time()
                            return {"action": "redeemed_credit", "email": active_account.email}

                    logger.info(
                        f"[Codex Auto-Rotate] ⚠️ Tài khoản {active_account.email} đã hết lượt GPT-6 Astra Ultra "
                        f"(Đã dùng {used_percent:.1f}%). Bắt đầu tìm tài khoản thay thế trong kho..."
                    )

                    # Đánh dấu tài khoản cũ là RATE_LIMITED để load balancer bỏ qua
                    active_account.status = AccountStatus.RATE_LIMITED
                    await session.commit()

                    # B. Tìm ứng viên khả dụng từ kho
                    all_accounts = await accounts_repo.list_accounts()
                    candidates: list[Account] = []
                    for a in all_accounts:
                        if (
                            a.id != active_account.id
                            and a.access_token_encrypted
                            and a.plan_type == "plus"
                            and a.status not in (AccountStatus.DEACTIVATED, AccountStatus.REAUTH_REQUIRED, AccountStatus.PAUSED)
                        ):
                            candidates.append(a)

                    if not candidates:
                        logger.warning("[Codex Auto-Rotate] ❌ Không còn tài khoản nào khả dụng trong kho!")
                        return None

                    # Quét trực tiếp danh sách ứng viên
                    best_candidate: Account | None = None
                    best_used_pct = 999.0

                    for cand in candidates:
                        try:
                            c_tok = enc.decrypt(cand.access_token_encrypted)
                            c_headers = {
                                "Authorization": f"Bearer {c_tok}",
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            }
                            if cand.chatgpt_account_id:
                                c_headers["ChatGPT-Account-Id"] = cand.chatgpt_account_id

                            c_res = await client.get("https://chatgpt.com/backend-api/wham/usage", headers=c_headers)
                            if c_res.status_code == 200:
                                c_data = c_res.json()
                                c_rl = c_data.get("rate_limit") or {}
                                c_allowed = c_rl.get("allowed", True)
                                c_limit_reached = c_rl.get("limit_reached", False)
                                c_pw = c_rl.get("primary_window") or {}
                                c_used = float(c_pw.get("used_percent", 0))
                                c_mu = c_data.get("model_usage") or {}
                                c_astra = c_mu.get("gpt-6-astra") or {}
                                c_astra_avail = c_astra.get("available", True)
                                c_resets = (c_data.get("rate_limit_reset_credits") or {}).get("available_count", 0)

                                # Nếu ứng viên còn reset credit và astra bị khóa, kích hoạt luôn cho ứng viên
                                if (not c_astra_avail or c_limit_reached or not c_allowed) and c_resets > 0:
                                    redeemed = await self._redeem_credit_for_account(
                                        client, c_tok, cand.chatgpt_account_id, cand.email
                                    )
                                    if redeemed:
                                        c_astra_avail = True
                                        c_allowed = True
                                        c_limit_reached = False
                                        c_used = 0.0

                                if c_allowed and not c_limit_reached and c_astra_avail and c_used < self.threshold_percent:
                                    if c_used < best_used_pct:
                                        best_used_pct = c_used
                                        best_candidate = cand
                                        if c_used == 0.0:
                                            # Đã tìm được ứng viên hoàn hảo 0%
                                            break
                        except Exception:
                            continue

                    if not best_candidate:
                        logger.warning("[Codex Auto-Rotate] ❌ Không tìm thấy tài khoản nào còn lượt GPT-6 Astra Ultra!")
                        return None

                    # C. Thực hiện hoán đổi sang ứng viên tốt nhất
                    logger.info(
                        f"[Codex Auto-Rotate] 🚀 Tiến hành đổi sang tài khoản mới: {best_candidate.email} "
                        f"(Đã dùng: {best_used_pct:.1f}%, Khả dụng: {100 - best_used_pct:.1f}%)..."
                    )

                    best_candidate.status = AccountStatus.ACTIVE
                    best_candidate.deactivation_reason = None
                    await session.commit()

                    # Xóa toàn bộ sticky sessions cũ để các request không bị dính vào acc hết hạn
                    await session.execute(delete(StickySession))
                    await session.commit()

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
        logger.info(f"[Codex Auto-Rotate Daemon] Đã khởi động! Ngưỡng đổi: {self.threshold_percent}%.")
        while self.enabled:
            try:
                await self.check_and_auto_rotate()
            except Exception as e:
                logger.debug(f"[Codex Auto-Rotate Daemon] Lỗi kiểm tra: {e}")
            await asyncio.sleep(15)


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
