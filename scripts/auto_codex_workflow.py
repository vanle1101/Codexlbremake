"""
Auto Codex Setup & Account Rotation Workflow
============================================
100% Local - Chạy hoàn toàn trên máy local, KHÔNG cần VPS, KHÔNG cần API key.

Quy trình tự động:
1. Đọc và lọc danh sách tài khoản GPT (email, pass, 2fa).
2. Tự động đăng nhập vào proxy codex-lb nội bộ (SQLite store.db).
3. Làm mới token và cập nhật vào ~/.codex/auth.json cho Codex.
4. Cấu hình ~/.codex/config.toml trỏ về proxy local (http://127.0.0.1:2455).
5. Đưa lệnh `codex` vào PATH nếu chưa có.
6. Khởi động dịch vụ codex-lb ngầm trên máy.
7. Mở giao diện Codex (cửa sổ tương tác & app Desktop) để sử dụng ngay.
"""

from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import httpx
import pyotp
from playwright.async_api import async_playwright

from app.core.clients.http import close_http_client, init_http_client
from app.core.crypto import TokenEncryptor
from app.db.session import get_background_session
from app.dependencies import _accounts_repo_context
from app.modules.accounts.repository import AccountsRepository
from app.modules.oauth.schemas import OauthStartRequest
from app.modules.oauth.service import OauthService


def parse_accounts(text: str) -> list[dict[str, str]]:
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()

    lines = text.strip().splitlines()
    for raw_line in lines:
        line = raw_line.strip()
        if not line or "@" not in line:
            continue

        # Support delimiters: tab, multiple spaces, comma, pipe
        parts = re.split(r"\t+|\s{2,}|[,|]", line)
        if len(parts) < 3:
            parts = line.split()

        if len(parts) >= 3 and "@" in parts[0]:
            email = parts[0].strip()
            password = parts[1].strip()
            totp = parts[2].strip().replace(" ", "").upper()
            email_lower = email.lower()

            if email_lower not in seen:
                seen.add(email_lower)
                accounts.append({
                    "email": email,
                    "password": password,
                    "two_factor_secret": totp
                })

    return accounts


async def solve_turnstile(page: Any) -> bool:
    try:
        frames = page.frames if hasattr(page, "frames") else []
        for frame in frames:
            f_url = getattr(frame, "url", "")
            if any(k in f_url.lower() for k in ["cloudflare", "turnstile", "challenges"]):
                for sel in ['input[type="checkbox"]', 'div[role="checkbox"]', "span.ctp-label", "#challenge-stage"]:
                    loc = frame.locator(sel).first
                    if await loc.count() > 0 and await loc.is_visible():
                        await loc.click(timeout=1500)
                        await asyncio.sleep(0.5)
                        return True

        for sel in [
            'iframe[src*="turnstile"]',
            'iframe[src*="challenges"]',
            '#challenge-stage input[type="checkbox"]',
            'div[role="checkbox"]',
            "span.ctp-label"
        ]:
            loc = page.locator(sel).first
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(timeout=1500)
                await asyncio.sleep(0.5)
                return True
    except Exception:
        pass
    return False


from app.modules.accounts.auto_login import AutoLoginService
from app.modules.accounts.schemas import AutoLoginAccountItem


async def login_single_account(
    account: dict[str, str],
    p: Any,
    svc: AutoLoginService,
    oauth_service: OauthService,
) -> bool:
    email = account["email"]
    password = account["password"]
    totp_secret = account["two_factor_secret"]

    print(f"\n🔐 Đang tiến hành đăng nhập tài khoản: {email}")
    acc_item = AutoLoginAccountItem(email=email, password=password, two_factor_secret=totp_secret)
    svc.save_credential(email, password, totp_secret)
    try:
        ok, ws, err = await svc._login_attempt(p, acc_item, oauth_service, workspace_index=0, worker_id=1)
        if ok:
            print(f"✅ Đăng nhập THÀNH CÔNG: {email}")
            return True
        else:
            print(f"⚠️ Đăng nhập thất bại ({email}): {err}")
            return False
    except Exception as e:
        print(f"❌ Lỗi khi đăng nhập {email}: {e}")
        return False



def setup_codex_auth_json() -> str | None:
    """Nạp token tài khoản active vào ~/.codex/auth.json để Codex Desktop/CLI dùng ngay."""
    import sqlite3
    db_path = os.path.expanduser("~/.codex-lb/store.db")
    if not os.path.exists(db_path):
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT email, chatgpt_account_id, access_token_encrypted, refresh_token_encrypted, id_token_encrypted FROM accounts WHERE status = 'active'")
    rows = cur.fetchall()

    te = TokenEncryptor()
    with httpx.Client(timeout=15) as client:
        for email, account_id, enc_acc, enc_ref, enc_id in rows:
            try:
                acc_tok = te.decrypt(enc_acc)
                ref_tok = te.decrypt(enc_ref)
                id_tok = te.decrypt(enc_id)
            except Exception:
                continue

            token_url = "https://auth.openai.com/oauth/token"
            payload = {
                "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
                "grant_type": "refresh_token",
                "refresh_token": ref_tok,
                "redirect_uri": "http://localhost:1455/auth/callback"
            }
            try:
                r = client.post(token_url, json=payload)
                if r.status_code == 200:
                    data = r.json()
                    codex_dir = Path.home() / ".codex"
                    codex_dir.mkdir(parents=True, exist_ok=True)
                    auth_file = codex_dir / "auth.json"

                    fresh_auth = {
                        "auth_mode": "chatgpt",
                        "OPENAI_API_KEY": None,
                        "last_refresh": datetime.now(timezone.utc).isoformat(),
                        "tokens": {
                            "id_token": data.get("id_token", id_tok),
                            "access_token": data["access_token"],
                            "refresh_token": data["refresh_token"],
                            "account_id": account_id
                        }
                    }
                    auth_file.write_text(json.dumps(fresh_auth, indent=2), encoding="utf-8")
                    print(f"🔑 Đã cấu hình xác thực Codex bằng tài khoản: {email}")
                    return email
            except Exception:
                continue
    return None


def setup_codex_config_toml() -> None:
    """Cấu hình ~/.codex/config.toml trỏ thẳng vào proxy local (KHÔNG CẦN API KEY)."""
    codex_dir = Path.home() / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    config_file = codex_dir / "config.toml"

    config_content = (
        'model = "gpt-6-astra"\n'
        'model_reasoning_effort = "xhigh"\n'
        'model_provider = "codex-lb"\n\n'
        '[model_providers.codex-lb]\n'
        'name = "openai"\n'
        'base_url = "http://127.0.0.1:2455/backend-api/codex"\n'
        'wire_api = "responses"\n'
        'supports_websockets = true\n'
        'requires_openai_auth = true\n'
    )

    if config_file.exists():
        existing = config_file.read_text(encoding="utf-8")
        if "base_url" in existing and "127.0.0.1:2455" in existing:
            print("⚙️ File ~/.codex/config.toml đã cấu hình chuẩn.")
            return

    config_file.write_text(config_content, encoding="utf-8")
    print("⚙️ Đã cấu hình ~/.codex/config.toml trỏ vào http://127.0.0.1:2455/backend-api/codex (Không cần API key).")


def setup_codex_path() -> None:
    """Đảm bảo lệnh `codex` có thể gõ trực tiếp trong Terminal/PowerShell."""
    if sys.platform != "win32":
        return

    # Check if codex is already found
    if shutil.which("codex"):
        return

    # Search for installed codex.exe in OpenAI Codex app directory
    search_dirs = [
        os.path.expandvars(r"%LOCALAPPDATA%\OpenAI\Codex\bin"),
        os.path.expandvars(r"%PROGRAMFILES%\WindowsApps"),
    ]
    codex_exe = None
    for base in search_dirs:
        for f in glob.glob(f"{base}/**/codex.exe", recursive=True):
            if os.path.isfile(f):
                codex_exe = f
                break
        if codex_exe:
            break

    if not codex_exe:
        return

    # Create wrapper in ~/.local/bin
    local_bin = Path.home() / ".local" / "bin"
    local_bin.mkdir(parents=True, exist_ok=True)
    cmd_wrapper = local_bin / "codex.cmd"
    cmd_wrapper.write_text(f'@echo off\n"{codex_exe}" %*\n', encoding="utf-8")

    # Add to User PATH if not present
    user_path = os.environ.get("PATH", "")
    if str(local_bin) not in user_path:
        os.environ["PATH"] = f"{local_bin};" + user_path
        subprocess.run(
            ["powershell", "-Command", f'[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";{local_bin}", "User")'],
            capture_output=True,
            text=True
        )
    print(f"🚀 Đã gắn lệnh `codex` vào PATH ({cmd_wrapper})")


def ensure_proxy_daemon_running() -> None:
    """Đảm bảo proxy local 127.0.0.1:2455 đang chạy."""
    try:
        r = httpx.get("http://127.0.0.1:2455/health", timeout=2.0)
        if r.status_code == 200:
            print("🟢 Proxy local (http://127.0.0.1:2455) ĐANG CHẠY.")
            return
    except Exception:
        pass

    print("🟡 Đang khởi động proxy local (codex-lb)...")
    python_exe = sys.executable
    if sys.platform == "win32":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            [python_exe, "-m", "app.cli", "--host", "0.0.0.0", "--port", "2455"],
            creationflags=flags,
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        subprocess.Popen(
            [python_exe, "-m", "app.cli", "--host", "0.0.0.0", "--port", "2455"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    for _ in range(15):
        time.sleep(1)
        try:
            r = httpx.get("http://127.0.0.1:2455/health", timeout=2.0)
            if r.status_code == 200:
                print("🟢 Proxy local đã khởi động thành công!")
                return
        except Exception:
            pass
    print("⚠️ Proxy đã được gửi lệnh chạy ngầm.")


def launch_codex_ui() -> None:
    """Mở cửa sổ Codex CLI và Desktop app cho người dùng."""
    if sys.platform == "win32":
        # Launch interactive terminal window with codex
        try:
            subprocess.run(
                ["powershell", "-Command", "Start-Process powershell -ArgumentList '-NoExit', '-Command', 'codex'"],
                capture_output=True,
                text=True
            )
        except Exception:
            pass

        # Also launch Desktop App if available
        try:
            subprocess.run(
                ["powershell", "-Command", "Start-Process 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'"],
                capture_output=True,
                text=True
            )
        except Exception:
            pass
    else:
        try:
            subprocess.Popen(["codex"])
        except Exception:
            pass


async def main_async(accounts_text: str) -> None:
    accounts = parse_accounts(accounts_text)
    if not accounts:
        print("❌ Không tìm thấy tài khoản hợp lệ nào trong dữ liệu cung cấp.")
        print("Định dạng yêu cầu: email [tab/cách] password [tab/cách] 2fa_secret")
        return

    print(f"📋 Đã tìm thấy {len(accounts)} tài khoản duy nhất cần xử lý.")

    await init_http_client()
    try:
        success_count = 0
        async with async_playwright() as p:
            async with get_background_session() as session:
                accounts_repo = AccountsRepository(session)
                oauth_service = OauthService(accounts_repo, repo_factory=_accounts_repo_context)
                svc = AutoLoginService()
                svc._headless = True

                for acc in accounts:
                    ok = await login_single_account(acc, p, svc, oauth_service)
                    if ok:
                        success_count += 1
                        # Nếu đã có ít nhất 1 tài khoản active, có thể thiết lập ngay
                        setup_codex_auth_json()

        print(f"\n✨ Kết quả: Đăng nhập thành công {success_count}/{len(accounts)} tài khoản.")
    finally:
        await close_http_client()

    # Cấu hình Codex
    active_email = setup_codex_auth_json()
    setup_codex_config_toml()
    setup_codex_path()
    ensure_proxy_daemon_running()
    launch_codex_ui()

    print("\n" + "=" * 50)
    print("🎉 HOÀN TẤT CÀI ĐẶT & KHỞI CHẠY CODEX (100% LOCAL)")
    print(f"👉 Tài khoản Codex đang dùng: {active_email or 'Tự động luân chuyển'}")
    print("👉 Proxy: http://127.0.0.1:2455 (KHÔNG CẦN API KEY)")
    print("👉 Đã bật cửa sổ giao diện Codex trên màn hình!")
    print("=" * 50)


def main():
    parser = argparse.ArgumentParser(description="Auto Codex Setup & Account Rotation")
    parser.add_argument("--file", "-f", help="Đường dẫn file chứa danh sách tài khoản")
    parser.add_argument("--text", "-t", help="Chuỗi danh sách tài khoản")
    args = parser.parse_args()

    content = ""
    if args.file and os.path.exists(args.file):
        content = Path(args.file).read_text(encoding="utf-8")
    elif args.text:
        content = args.text
    else:
        # Read from stdin if available
        if not sys.stdin.isatty():
            content = sys.stdin.read()

    if not content.strip():
        print("Nhập danh sách tài khoản (bấm Ctrl+Z rồi Enter khi xong):")
        try:
            content = sys.stdin.read()
        except Exception:
            pass

    asyncio.run(main_async(content))


if __name__ == "__main__":
    main()
