import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, List

import pyotp

from app.core.crypto import TokenEncryptor
from app.modules.accounts.schemas import (
    AutoLoginAccountItem,
    AutoLoginLogItem,
    AutoLoginStateResponse,
)
from app.modules.oauth.schemas import OauthStartRequest

if TYPE_CHECKING:
    from app.modules.oauth.service import OauthService

logger = logging.getLogger(__name__)


def normalize_email_key(email: str) -> str:
    return email.strip().lower()


async def _solve_turnstile(page: Any) -> bool:
    try:
        cf_selectors = [
            '#challenge-stage input[type="checkbox"]',
            'span.ctp-label',
            'div[role="checkbox"]',
            '.cb-lb',
            '#turnstile-wrapper input[type="checkbox"]',
            '[data-testid="turnstile-checkbox"]',
            'div.cf-turnstile',
            'iframe[src*="cloudflare"]',
            'iframe[src*="turnstile"]',
            'iframe[src*="challenges"]',
        ]
        for sel in cf_selectors:
            loc = page.locator(sel).first
            if await loc.count() > 0 and await loc.is_visible():
                box = await loc.bounding_box()
                if box and box.get("width", 0) > 0 and box.get("height", 0) > 0:
                    try:
                        await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                        await asyncio.sleep(0.08)
                        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                        await asyncio.sleep(0.4)
                        return True
                    except Exception:
                        pass
                await loc.click(timeout=2000)
                await asyncio.sleep(0.4)
                return True

        frames = page.frames if hasattr(page, "frames") and isinstance(page.frames, (list, tuple)) else []
        for frame in frames:
            frame_url = getattr(frame, "url", "")
            if isinstance(frame_url, str) and any(k in frame_url.lower() for k in ["cloudflare", "turnstile", "challenges"]):
                for iframe_sel in [
                    'input[type="checkbox"]',
                    'div[role="checkbox"]',
                    'span.ctp-label',
                    '.ctp-checkbox-label',
                    'span.mark',
                    '#challenge-stage',
                    'body',
                ]:
                    try:
                        box = frame.locator(iframe_sel).first
                        if await box.count() > 0 and await box.is_visible():
                            bbox = await box.bounding_box()
                            if bbox and bbox.get("width", 0) > 0:
                                try:
                                    await page.mouse.click(bbox["x"] + bbox["width"] / 2, bbox["y"] + bbox["height"] / 2)
                                    await asyncio.sleep(0.4)
                                    return True
                                except Exception:
                                    pass
                            await box.click(timeout=2000)
                            await asyncio.sleep(0.4)
                            return True
                    except Exception:
                        pass
    except Exception:
        pass
    return False


class AutoLoginService:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._status = "idle"
        self._current_index = 0
        self._queue: list[AutoLoginAccountItem] = []
        self._logs: list[AutoLoginLogItem] = []
        self._vault: dict[str, AutoLoginAccountItem] = {}
        self._task: asyncio.Task[None] | None = None
        self._should_stop = False
        self._should_pause = False
        self._delay_seconds = 2
        self._concurrency = 3
        self._headless = True
        self._load_vault()

    def _get_vault_file(self) -> Path:
        return Path("data/vault_credentials.enc")

    def _save_vault(self) -> None:
        try:
            encryptor = TokenEncryptor()
            vault_file = self._get_vault_file()
            vault_file.parent.mkdir(parents=True, exist_ok=True)
            data = {
                email: {
                    "email": acc.email,
                    "password": acc.password,
                    "two_factor_secret": acc.two_factor_secret,
                }
                for email, acc in self._vault.items()
            }
            raw = json.dumps(data)
            encrypted = encryptor.encrypt(raw)
            vault_file.write_bytes(encrypted)
        except Exception as exc:
            logger.warning("Failed to save credentials vault: %s", exc)

    def _load_vault(self) -> None:
        try:
            vault_file = self._get_vault_file()
            if not vault_file.exists():
                return
            encryptor = TokenEncryptor()
            encrypted = vault_file.read_bytes()
            raw = encryptor.decrypt(encrypted)
            data = json.loads(raw)
            for email, item in data.items():
                norm_key = normalize_email_key(email)
                self._vault[norm_key] = AutoLoginAccountItem(
                    email=item["email"],
                    password=item["password"],
                    two_factor_secret=item.get("two_factor_secret"),
                    status="PENDING",
                )
        except Exception as exc:
            logger.warning("Failed to load credentials vault: %s", exc)

    def has_credential(self, email: str) -> bool:
        norm_key = normalize_email_key(email)
        return norm_key in self._vault

    def save_credential(self, email: str, password: str, two_factor_secret: str | None = None) -> None:
        norm_key = normalize_email_key(email)
        self._vault[norm_key] = AutoLoginAccountItem(
            email=email.strip(),
            password=password.strip(),
            two_factor_secret=two_factor_secret.strip() if two_factor_secret else None,
            status="PENDING",
        )
        self._save_vault()

    def clear_vault(self) -> None:
        self._vault = {}
        self._save_vault()

    def _log(self, message: str, level: str = "info") -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_item = AutoLoginLogItem(timestamp=timestamp, message=message, level=level)
        self._logs.append(log_item)
        if len(self._logs) > 300:
            self._logs.pop(0)
        logger.info("[AutoLogin] %s", message)

    async def start(
        self,
        accounts: list[AutoLoginAccountItem],
        oauth_service: OauthService,
        delay_seconds: int = 2,
        concurrency: int = 3,
        headless: bool = True,
    ) -> AutoLoginStateResponse:
        async with self._lock:
            if self._task and not self._task.done():
                self._should_stop = True
                self._task.cancel()
                try:
                    await self._task
                except (asyncio.CancelledError, Exception):
                    pass

            # 1. Lọc trùng tài khoản (Deduplication)
            unique_map: dict[str, AutoLoginAccountItem] = {}
            for acc in accounts:
                key = normalize_email_key(acc.email)
                unique_map[key] = acc.model_copy()

            unique_accounts = list(unique_map.values())
            duplicates_removed = len(accounts) - len(unique_accounts)

            self._status = "running"
            self._current_index = 0
            self._queue = [acc.model_copy() for acc in unique_accounts]
            for acc in unique_accounts:
                key = normalize_email_key(acc.email)
                self._vault[key] = acc.model_copy()
            self._save_vault()
            self._logs = []
            self._should_stop = False
            self._should_pause = False
            self._delay_seconds = delay_seconds
            self._concurrency = max(1, min(concurrency, 50))
            self._headless = headless

            if duplicates_removed > 0:
                self._log(
                    f"🔍 Đã lọc danh sách: còn {len(self._queue)} tài khoản duy nhất (đã loại bỏ {duplicates_removed} tài khoản trùng lặp)."
                )
            self._log(
                f"🚀 Khởi động batch đăng nhập ngầm cho {len(self._queue)} tài khoản với {self._concurrency} luồng song song (Headless: {self._headless})."
            )
            self._task = asyncio.create_task(self._run_batch(oauth_service))
            return self.get_state_locked()

    async def pause(self) -> AutoLoginStateResponse:
        async with self._lock:
            self._should_pause = True
            self._status = "paused"
            self._log("⏸️ Đã tạm dừng batch đăng nhập.")
            return self.get_state_locked()

    async def resume(self) -> AutoLoginStateResponse:
        async with self._lock:
            self._should_pause = False
            self._status = "running"
            self._log("▶️ Tiếp tục batch đăng nhập.")
            return self.get_state_locked()

    async def cancel(self) -> AutoLoginStateResponse:
        async with self._lock:
            self._should_stop = True
            if self._task and not self._task.done():
                self._task.cancel()
            self._status = "idle"
            self._log("⏹️ Đã dừng tiến trình đăng nhập.")
            return self.get_state_locked()

    async def append(self, accounts: list[AutoLoginAccountItem]) -> AutoLoginStateResponse:
        async with self._lock:
            existing_keys = {normalize_email_key(a.email) for a in self._queue}
            added = 0
            for a in accounts:
                key = normalize_email_key(a.email)
                if key not in existing_keys:
                    item = a.model_copy()
                    item.status = "PENDING"
                    self._queue.append(item)
                    self._vault[key] = a.model_copy()
                    existing_keys.add(key)
                    added += 1
                else:
                    self._vault[key] = a.model_copy()

            if added > 0:
                self._log(f"📥 Đã nối thêm {added} tài khoản mới vào hàng đợi (Tổng cộng: {len(self._queue)} tài khoản).")
            else:
                self._log("ℹ️ Tất cả tài khoản trong danh sách nối thêm đều đã tồn tại trong hàng đợi (đã lọc trùng).")
            return self.get_state_locked()

    async def retry_failed(self, oauth_service: OauthService) -> AutoLoginStateResponse:
        async with self._lock:
            if self._status == "running":
                return self.get_state_locked()

            failed_indices = [i for i, a in enumerate(self._queue) if a.status == "FAILED"]
            if not failed_indices:
                self._log("ℹ️ Không có tài khoản nào ở trạng thái lỗi để chạy lại.")
                return self.get_state_locked()

            for i in failed_indices:
                self._queue[i].status = "PENDING"
                self._queue[i].error = None

            self._status = "running"
            self._should_stop = False
            self._should_pause = False
            self._log(f"🔄 Bắt đầu chạy lại {len(failed_indices)} tài khoản bị lỗi...")
            self._task = asyncio.create_task(self._run_batch(oauth_service))
            return self.get_state_locked()

    def get_state_locked(self) -> AutoLoginStateResponse:
        return AutoLoginStateResponse(
            status=self._status,
            current_index=self._current_index,
            queue=self._queue,
            logs=self._logs,
            concurrency=self._concurrency,
            delay_seconds=self._delay_seconds,
        )

    async def get_state(self) -> AutoLoginStateResponse:
        async with self._lock:
            return self.get_state_locked()

    async def _login_attempt(
        self,
        p,
        acc: AutoLoginAccountItem,
        oauth_service: OauthService,
        workspace_index: int = 0,
        worker_id: int = 1,
    ) -> tuple[bool, int, str | None]:
        auth_resp = await oauth_service.start_oauth(OauthStartRequest(force_method="browser"))
        if not auth_resp.authorization_url:
            return False, 1, "Codex-LB không tạo được authorization_url"

        browser = None
        context = None
        try:
            try:
                browser = await p.chromium.launch(
                    headless=self._headless,
                    channel="chrome",
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                    ],
                )
            except Exception:
                browser = await p.chromium.launch(
                    headless=self._headless,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                    ],
                )

            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/133.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                window.chrome = { runtime: {} };
            """)
            page = await context.new_page()

            async def _do_web_session_fallback() -> bool:
                self._log(f"[Luồng {worker_id}] ⚠️ Đang tự động chuyển sang Web Session login cho {acc.email}...")
                try:
                    await page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=25000)
                    await asyncio.sleep(1.5)

                    email_inp_web = page.locator('input[name="username"], input#username, input[type="email"], input[name="email"]').first
                    try:
                        await email_inp_web.wait_for(state="visible", timeout=10000)
                        await email_inp_web.fill(acc.email)
                        await asyncio.sleep(0.3)
                        await page.locator('button[type="submit"]').first.click()
                        await asyncio.sleep(1.5)
                    except Exception:
                        pass

                    pass_inp_web = page.locator('input[name="password"], input#password, input[type="password"]').first
                    try:
                        await pass_inp_web.wait_for(state="visible", timeout=8000)
                        await pass_inp_web.fill(acc.password)
                        await asyncio.sleep(0.3)
                        await page.locator('button[type="submit"]').first.click()
                        await asyncio.sleep(1.5)
                    except Exception:
                        pass

                    otp_inp_web = page.locator('input[name="code"], input#code, input[inputmode="numeric"]').first
                    try:
                        await otp_inp_web.wait_for(state="visible", timeout=6000)
                        if acc.two_factor_secret:
                            clean_sec = acc.two_factor_secret.replace(" ", "")
                            try:
                                code = pyotp.TOTP(clean_sec).now()
                                self._log(f"[Luồng {worker_id}] Điền OTP Web: {code}...")
                                await otp_inp_web.fill(code)
                                await asyncio.sleep(0.2)
                                await page.keyboard.press("Enter")
                            except Exception as totp_err:
                                logger.warning(f"Lỗi tạo OTP Web: {totp_err}")
                    except Exception:
                        pass

                    # Wait for landing on chatgpt.com
                    for _ in range(15):
                        await asyncio.sleep(1)
                        if "chatgpt.com" in page.url and "auth" not in page.url:
                            break

                    # Extract Web Session with retry loop
                    for _ in range(10):
                        session_resp = await context.request.get("https://chatgpt.com/api/auth/session")
                        if session_resp.status == 200:
                            session_text = await session_resp.text()
                            try:
                                session_json = json.loads(session_text)
                                if session_json.get("accessToken"):
                                    from app.db.session import get_background_session
                                    from app.modules.accounts.repository import AccountsRepository
                                    from app.modules.accounts.service import AccountsService
                                    from app.modules.usage.repository import UsageRepository

                                    async with get_background_session() as db_session:
                                        accounts_repo = AccountsRepository(db_session)
                                        usage_repo = UsageRepository(db_session)
                                        service = AccountsService(repo=accounts_repo, usage_repo=usage_repo)
                                        await service.import_account(session_text.encode("utf-8"))
                                    self._log(f"🎉 [Luồng {worker_id}] Đã tự động nạp Web Session thành công cho {acc.email}!", level="success")
                                    return True
                            except Exception:
                                pass
                        await asyncio.sleep(1)
                except Exception as fallback_err:
                    logger.warning(f"Web session fallback error for {acc.email}: {fallback_err}")
                return False

            target_url = auth_resp.authorization_url or "https://chatgpt.com/auth/login"
            self._log(f"[Luồng {worker_id}] Đang mở Web Auth ChatGPT ({acc.email})...")
            await page.goto(target_url, wait_until="domcontentloaded", timeout=35000)
            await asyncio.sleep(1.5)

            # Step A: Email
            self._log(f"[Luồng {worker_id}] Đang điền email {acc.email}...")
            email_input = page.locator(
                'input[name="username"], input#username, input[type="email"], input[name="email"]'
            ).first
            try:
                await email_input.wait_for(state="visible", timeout=6000)
            except Exception:
                login_btn = page.locator('button:has-text("Log in"), a:has-text("Log in"), [data-testid="login-button"]').first
                try:
                    if await login_btn.is_visible():
                        await login_btn.click(timeout=2000)
                        await asyncio.sleep(1)
                except Exception:
                    pass
                await email_input.wait_for(state="visible", timeout=15000)

            await email_input.fill(acc.email)
            await asyncio.sleep(0.3)

            continue_btn = page.locator('button[type="submit"]').first
            await continue_btn.click()
            await asyncio.sleep(1.5)

            # Step B: Password (with self-healing re-click & turnstile resolution)
            self._log(f"[Luồng {worker_id}] Đang điền mật khẩu cho {acc.email}...")
            pass_input = page.locator(
                'input[name="password"], input#password, input[type="password"]'
            ).first

            password_ready = False
            for retry_i in range(15):
                if self._should_stop:
                    break
                try:
                    if await pass_input.is_visible():
                        password_ready = True
                        break
                except Exception:
                    pass

                # Check if Cloudflare Turnstile checkbox popped up
                try:
                    cf_box = page.locator(
                        '#challenge-stage input[type="checkbox"], span.ctp-label, div[role="checkbox"], .cb-lb'
                    ).first
                    if await cf_box.is_visible():
                        self._log(f"[Luồng {worker_id}] Phát hiện Cloudflare, đang click xác nhận...")
                        await cf_box.click(timeout=1500)
                except Exception:
                    pass

                # Check if account is deactivated or deleted
                try:
                    page_body = await page.locator("body").inner_text()
                    if "deactivated" in page_body.lower() or "deleted or deactivated" in page_body.lower() or "account_deactivated" in page_body:
                        raise ValueError("Tài khoản đã bị OpenAI vô hiệu hoá / xoá (account_deactivated)")
                except ValueError:
                    raise
                except Exception:
                    pass

                # If still stuck on email input after 3s, re-click submit
                if retry_i in (2, 5, 9):
                    try:
                        btn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Tiếp tục")').first
                        if await btn.is_visible():
                            await btn.click(timeout=1500)
                    except Exception:
                        pass

                await asyncio.sleep(1.5)

            if not password_ready:
                try:
                    await pass_input.wait_for(state="visible", timeout=3000)
                except Exception:
                    if await _do_web_session_fallback():
                        await context.close()
                        await browser.close()
                        return True, 1, None
                    raise ValueError("Không tìm thấy ô nhập mật khẩu (Timeout)")

            await pass_input.fill(acc.password)
            await asyncio.sleep(0.3)

            submit_btn = page.locator('button[type="submit"]').first
            await submit_btn.click()
            await asyncio.sleep(2)

            # Step C: Loop wait for 2FA / Turnstile / Workspace / Callback
            success = False
            otp_filled = False
            total_workspaces = 1
            workspace_clicked = False

            for _ in range(80):
                if self._should_stop:
                    break

                current_url = page.url
                if "/auth/callback" in current_url and ("code=" in current_url or "state=" in current_url):
                    self._log(f"[Luồng {worker_id}] Đã nhận Callback OAuth cho {acc.email}")
                    success = True
                    break

                # Check Landing on ChatGPT Web
                if "chatgpt.com" in current_url and "auth.openai.com" not in current_url and "login" not in current_url:
                    self._log(f"[Luồng {worker_id}] Đã đăng nhập vào Web ChatGPT ({acc.email}). Đang trích xuất Session...")
                    try:
                        session_resp = await context.request.get("https://chatgpt.com/api/auth/session")
                        if session_resp.status == 200:
                            session_text = await session_resp.text()
                            session_json = json.loads(session_text)
                            if session_json.get("accessToken"):
                                from app.db.session import get_background_session
                                from app.modules.accounts.repository import AccountsRepository
                                from app.modules.accounts.service import AccountsService
                                from app.modules.usage.repository import UsageRepository

                                async with get_background_session() as db_session:
                                    accounts_repo = AccountsRepository(db_session)
                                    usage_repo = UsageRepository(db_session)
                                    service = AccountsService(repo=accounts_repo, usage_repo=usage_repo)
                                    await service.import_account(session_text.encode("utf-8"))
                                self._log(f"🎉 [Luồng {worker_id}] Đã tự động nạp Session Web thành công cho {acc.email}!", level="success")
                                success = True
                                break
                    except Exception as sess_err:
                        logger.warning(f"Lỗi trích xuất session cho {acc.email}: {sess_err}")

                # Check Workspace Selection
                if not workspace_clicked and (
                    "/workspace" in current_url or await page.locator('text="Choose a workspace"').count() > 0
                ):
                    try:
                        await asyncio.sleep(0.5)
                        ws_items = page.locator(
                            'div[role="button"], button:not(:has-text("Terms")):not(:has-text("Privacy")), div.cursor-pointer, a[href*="workspace"]'
                        )
                        ws_count = await ws_items.count()
                        if ws_count > 0:
                            total_workspaces = ws_count
                            click_idx = min(workspace_index, ws_count - 1)
                            target_ws = ws_items.nth(click_idx)
                            raw_text = await target_ws.inner_text()
                            ws_name = raw_text.split("\n")[0].strip() if raw_text else f"Workspace #{click_idx + 1}"
                            self._log(f"[Luồng {worker_id}] Phát hiện {ws_count} Workspace! Chọn [{click_idx + 1}/{ws_count}]: '{ws_name}'...")
                            await target_ws.click()
                            workspace_clicked = True
                    except Exception:
                        pass

                # Check 2FA
                if not otp_filled and acc.two_factor_secret:
                    try:
                        otp_input = page.locator(
                            'input[name="code"], input#code, input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="mfa_code"]'
                        ).first
                        if await otp_input.is_visible():
                            self._log(f"[Luồng {worker_id}] Đang điền mã 2FA cho {acc.email}...")
                            clean_secret = acc.two_factor_secret.strip().replace(" ", "")
                            try:
                                totp = pyotp.TOTP(clean_secret)
                                code = totp.now()
                                await otp_input.fill(code)
                                await asyncio.sleep(0.15)
                                await page.keyboard.press("Enter")
                                await asyncio.sleep(0.15)
                                btn = page.locator(
                                    'button[type="submit"], button[name="action"][value="default"], button:has-text("Continue"), button:has-text("Tiếp tục"), button:has-text("Verify"), button:has-text("Xác nhận")'
                                ).first
                                if await btn.is_visible():
                                    await btn.click()
                                otp_filled = True
                            except Exception as totp_err:
                                logger.warning(f"Lỗi tính toán OTP: {totp_err}")
                        else:
                            digit_inputs = await page.locator('input[maxlength="1"], input[data-index]').all()
                            if len(digit_inputs) == 6:
                                self._log(f"[Luồng {worker_id}] Đang điền 6 số 2FA cho {acc.email}...")
                                clean_secret = acc.two_factor_secret.strip().replace(" ", "")
                                try:
                                    totp = pyotp.TOTP(clean_secret)
                                    code = totp.now()
                                    for i, digit in enumerate(code):
                                        await digit_inputs[i].fill(digit)
                                        await asyncio.sleep(0.02)
                                    await page.keyboard.press("Enter")
                                    otp_filled = True
                                except Exception as totp_err:
                                    logger.warning(f"Lỗi tính toán 6 số OTP: {totp_err}")
                    except Exception:
                        pass

                # Check Consent / Authorize
                try:
                    consent_btn = page.locator(
                        'button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Uỷ quyền"), button:has-text("Accept"), button:has-text("Grant"), button[name="action"][value="accept"], button[data-testid="consent-grant-button"]'
                    ).first
                    if await consent_btn.is_visible():
                        self._log(f"[Luồng {worker_id}] Tự động bấm Authorize/Uỷ quyền...")
                        await consent_btn.click()
                except Exception:
                    pass

                # Check Cloudflare Turnstile
                try:
                    await _solve_turnstile(page)
                except Exception:
                    pass

                # Check Phone number required -> Auto Fallback to Web Session Login!
                if "/add-phone" in current_url or await page.locator('text="Phone number required"').count() > 0:
                    if await _do_web_session_fallback():
                        await context.close()
                        await browser.close()
                        return True, 1, None
                    raise ValueError("OpenAI bắt buộc thêm Số Điện Thoại (Phone number required / SMS)")

                # Check account deactivated or deleted error
                try:
                    page_body = await page.locator("body").inner_text()
                    if "deactivated" in page_body.lower() or "deleted or deactivated" in page_body.lower() or "account_deactivated" in page_body:
                        raise ValueError("Tài khoản đã bị OpenAI xoá/vô hiệu hoá (account_deactivated)")
                    if "wrong password" in page_body.lower() or "incorrect password" in page_body.lower():
                        raise ValueError("Mật khẩu không chính xác")
                except ValueError:
                    raise
                except Exception:
                    pass

                # Check invalid 2FA error
                if await page.locator('text="Invalid code"').count() > 0 or await page.locator('text="Mã không hợp lệ"').count() > 0:
                    raise ValueError("Mã 2FA không hợp lệ hoặc secret sai")

                # Check errors
                try:
                    err_el = page.locator(
                        '.error-message, [data-error-code], #error-element-password, [role="alert"]'
                    ).first
                    if await err_el.is_visible():
                        text = await err_el.inner_text()
                        if text.strip():
                            raise ValueError(text.strip())
                except ValueError:
                    raise
                except Exception:
                    pass

                await asyncio.sleep(1)

            if not success:
                if await _do_web_session_fallback():
                    success = True
                else:
                    raise ValueError("Quá thời gian xác thực OAuth (Timeout)")

            await context.close()
            await browser.close()

            return success, total_workspaces, None

        except Exception as e:
            if context:
                try:
                    await context.close()
                except Exception:
                    pass
            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass
            return False, 1, str(e)

    async def _run_batch(self, oauth_service: OauthService) -> None:
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async with self._lock:
                self._status = "finished"
                self._log("Lỗi: Thư viện playwright chưa được cài đặt trong môi trường Python.", level="error")
            return

        async with async_playwright() as p:
            work_queue: asyncio.Queue[int] = asyncio.Queue()
            for idx, acc in enumerate(self._queue):
                if acc.status != "SUCCESS":
                    work_queue.put_nowait(idx)

            concurrency = min(self._concurrency, max(1, work_queue.qsize()))

            async def worker(worker_id: int) -> None:
                # Stagger initial worker launch by 2.0s per thread so they don't hit OpenAI Auth simultaneously
                if worker_id > 1:
                    await asyncio.sleep((worker_id - 1) * 2.0)

                while not work_queue.empty():
                    if self._should_stop:
                        break

                    while self._should_pause:
                        await asyncio.sleep(1)
                        if self._should_stop:
                            break

                    try:
                        idx = work_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break

                    acc = self._queue[idx]
                    async with self._lock:
                        acc.status = "PROCESSING"
                        self._current_index = max(self._current_index, idx + 1)
                    self._log(f"[Luồng {worker_id}] [{idx + 1}/{len(self._queue)}] Bắt đầu đăng nhập: {acc.email}")

                    # Step 1: Login Workspace 0
                    success, total_workspaces, err_msg = await self._login_attempt(
                        p, acc, oauth_service, workspace_index=0, worker_id=worker_id
                    )

                    if success:
                        if total_workspaces > 1:
                            self._log(
                                f"✅ [Luồng {worker_id}] Đã nạp thành công Workspace 1/{total_workspaces} cho {acc.email}",
                                level="success",
                            )
                            for ws_idx in range(1, total_workspaces):
                                if self._should_stop:
                                    break
                                while self._should_pause:
                                    await asyncio.sleep(1)

                                ws_success, _, ws_err = await self._login_attempt(
                                    p, acc, oauth_service, workspace_index=ws_idx, worker_id=worker_id
                                )
                                if ws_success:
                                    self._log(
                                        f"✅ [Luồng {worker_id}] Đã nạp Workspace {ws_idx + 1}/{total_workspaces} cho {acc.email}",
                                        level="success",
                                    )

                        async with self._lock:
                            acc.status = "SUCCESS"
                            acc.error = None
                        self._log(f"✅ [Luồng {worker_id}] Hoàn tất tài khoản: {acc.email}", level="success")
                    else:
                        async with self._lock:
                            if err_msg and ("Số Điện Thoại" in err_msg or "Phone number required" in err_msg):
                                acc.status = "PHONE_REQUIRED"
                                acc.error = "OpenAI bắt buộc thêm Số Điện Thoại (Chờ xử lý qua Web Session)"
                                self._log(f"📱 [Luồng {worker_id}] Dính cờ SĐT: {acc.email} -> Chuyển vào tab 'Dính SĐT'", level="warning")
                            elif err_msg and ("deactivated" in err_msg.lower() or "vô hiệu hoá" in err_msg.lower() or "xoá" in err_msg.lower()):
                                acc.status = "DEACTIVATED"
                                acc.error = "Tài khoản đã bị OpenAI vô hiệu hoá / xoá (account_deactivated)"
                                self._log(f"🚫 [Luồng {worker_id}] Bị khoá: {acc.email} -> Tài khoản đã bị OpenAI vô hiệu hoá (Deactivated)", level="error")
                            else:
                                acc.status = "FAILED"
                                acc.error = err_msg or "Quá thời gian xác thực OAuth (Timeout)"
                                self._log(f"❌ [Luồng {worker_id}] Thất bại {acc.email}: {acc.error}", level="error")

                    async with self._lock:
                        self._current_index += 1

                    work_queue.task_done()

                    if self._delay_seconds > 0 and not self._should_stop and not work_queue.empty():
                        await asyncio.sleep(self._delay_seconds)

            workers = [asyncio.create_task(worker(i + 1)) for i in range(concurrency)]
            await asyncio.gather(*workers)

            # Auto Retry Round 2 for failed accounts if any and not cancelled
            if not self._should_stop:
                failed_indices = [i for i, a in enumerate(self._queue) if a.status == "FAILED"]
                if failed_indices:
                    self._log(
                        f"🔄 [Vòng 2] Đã hoàn thành vòng 1! Bắt đầu tự động chạy lại {len(failed_indices)} tài khoản bị lỗi...",
                        level="info",
                    )
                    for i in failed_indices:
                        self._queue[i].status = "PENDING"
                        self._queue[i].error = None
                        work_queue.put_nowait(i)

                    retry_concurrency = min(self._concurrency, max(1, work_queue.qsize()))
                    retry_workers = [asyncio.create_task(worker(i + 1)) for i in range(retry_concurrency)]
                    await asyncio.gather(*retry_workers)

        async with self._lock:
            self._status = "finished"
            success_count = sum(1 for a in self._queue if a.status == "SUCCESS")
            phone_count = sum(1 for a in self._queue if a.status == "PHONE_REQUIRED")
            fail_count = sum(1 for a in self._queue if a.status == "FAILED")
            self._log(
                f"🎉 Đã hoàn thành toàn bộ tiến trình! (Thành công: {success_count} | Dính SĐT: {phone_count} | Thất bại khác: {fail_count} | Tổng: {len(self._queue)})",
                level="success",
            )

    def get_credential(self, email: str) -> dict[str, str | None] | None:
        """Get stored credentials from vault for a given email."""
        norm_key = normalize_email_key(email)
        acc = self._vault.get(norm_key)
        if acc:
            return {
                "email": acc.email,
                "password": acc.password,
                "two_factor_secret": acc.two_factor_secret,
            }
        return None

    def get_all_credentials(self) -> list[AutoLoginAccountItem]:
        """Get all stored credentials in vault."""
        return list(self._vault.values())

    async def relogin_single_account(
        self,
        email: str,
        oauth_service: OauthService,
        headless: bool = True,
    ) -> tuple[bool, str | None]:
        """Automatically perform a background login attempt for a single account from vault."""
        norm_key = normalize_email_key(email)
        acc = self._vault.get(norm_key)
        if not acc:
            return False, f"Chưa có mật khẩu lưu trong Vault cho tài khoản {email}."

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return False, "Playwright chưa được cài đặt trong môi trường Python."

        self._log(f"🔄 [401 Auto-Recovery] Bắt đầu tự động đăng nhập lại cho {acc.email}...")
        try:
            async with async_playwright() as p:
                success, _, err_msg = await self._login_attempt(
                    p,
                    acc,
                    oauth_service,
                    workspace_index=0,
                    worker_id=1,
                )
                if success:
                    self._log(f"🎉 [401 Auto-Recovery] Tự động đăng nhập lại thành công cho {acc.email}!", level="success")
                    return True, None
                else:
                    err = err_msg or "Xác thực OAuth thất bại hoặc quá thời gian."
                    self._log(f"❌ [401 Auto-Recovery] Thất bại cho {acc.email}: {err}", level="error")
                    return False, err
        except Exception as e:
            self._log(f"❌ [401 Auto-Recovery] Lỗi ngoại lệ: {e}", level="error")
            return False, str(e)

    async def auto_reauth_all_401(
        self,
        oauth_service: OauthService,
        concurrency: int = 2,
    ) -> dict[str, Any]:
        """Scan DB for all accounts requiring reauth/401, match with Vault, and relogin them concurrently."""
        from app.db.session import get_background_session
        from app.db.models import Account, AccountStatus
        from sqlalchemy import select

        async with get_background_session() as db_session:
            stmt = select(Account.id, Account.email).where(
                Account.status.in_([AccountStatus.REAUTH_REQUIRED, AccountStatus.DEACTIVATED])
            )
            result = await db_session.execute(stmt)
            accounts_401_data = [(str(row[0]), str(row[1])) for row in result.all()]

        if not accounts_401_data:
            return {
                "total_401": 0,
                "reauthed": 0,
                "failed": 0,
                "no_credentials": 0,
                "message": "Không có tài khoản nào đang ở trạng thái lỗi 401.",
            }

        eligible_emails: list[str] = []
        no_credentials_count = 0
        now = time.time()

        for acc_id, email in accounts_401_data:
            norm_key = normalize_email_key(email)
            if norm_key not in self._vault:
                no_credentials_count += 1
                continue

            last_attempt = getattr(self, "_reauth_cooldowns", {}).get(norm_key, 0)
            if now - last_attempt < 300:  # 5 min cooldown for recent failure
                continue
            eligible_emails.append(email)

        if not hasattr(self, "_reauth_cooldowns"):
            self._reauth_cooldowns = {}

        if not eligible_emails:
            return {
                "total_401": len(accounts_401_data),
                "reauthed": 0,
                "failed": 0,
                "no_credentials": no_credentials_count,
                "message": f"Tìm thấy {len(accounts_401_data)} tài khoản 401 nhưng {no_credentials_count} tài khoản chưa lưu mật khẩu trong Vault.",
            }

        self._log(
            f"⚡ [Auto-Reauth Batch] Bắt đầu tự động đăng nhập lại cho {len(eligible_emails)} tài khoản 401 có mật khẩu lưu trong Vault...",
            level="info",
        )

        reauthed_count = 0
        failed_count = 0
        semaphore = asyncio.Semaphore(max(1, min(concurrency, 4)))

        async def attempt_one(target_email: str):
            nonlocal reauthed_count, failed_count
            norm_key = normalize_email_key(target_email)
            self._reauth_cooldowns[norm_key] = time.time()
            async with semaphore:
                success, _ = await self.relogin_single_account(
                    email=target_email,
                    oauth_service=oauth_service,
                    headless=True,
                )
                if success:
                    reauthed_count += 1
                    self._reauth_cooldowns.pop(norm_key, None)
                else:
                    failed_count += 1

        tasks = [asyncio.create_task(attempt_one(em)) for em in eligible_emails]
        await asyncio.gather(*tasks)

        msg = f"Đã khôi phục thành công {reauthed_count}/{len(eligible_emails)} tài khoản 401!"
        self._log(f"🎉 [Auto-Reauth Batch] {msg} (Thất bại: {failed_count})", level="success" if reauthed_count > 0 else "warning")

        return {
            "total_401": len(accounts_401_data),
            "reauthed": reauthed_count,
            "failed": failed_count,
            "no_credentials": no_credentials_count,
            "message": msg,
        }


_AUTO_LOGIN_SINGLETON = AutoLoginService()


def get_auto_login_service() -> AutoLoginService:
    return _AUTO_LOGIN_SINGLETON

