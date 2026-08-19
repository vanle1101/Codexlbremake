from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, Response

from app.core.audit.service import AuditService
from app.core.auth.dependencies import (
    require_dashboard_write_access,
    set_dashboard_error_format,
    validate_dashboard_session,
)
from app.core.auth.refresh import RefreshError
from app.core.clients.usage import UsageFetchError
from app.core.exceptions import (
    DashboardBadRequestError,
    DashboardConflictError,
    DashboardNotFoundError,
    DashboardUpstreamError,
)
from app.core.middleware.multipart_content_encoding import raise_for_unsupported_multipart_content_encoding
from app.core.multipart import ACCOUNT_IMPORT_MULTIPART_POLICY, bounded_multipart_form, read_bounded_upload
from app.core.multipart_fields import required_upload
from app.core.upstream_proxy import UpstreamProxyRouteError
from app.dependencies import AccountsContext, OauthContext, get_accounts_context, get_oauth_context, get_proxy_service_for_app
from app.modules.accounts.auto_login import get_auto_login_service
from app.modules.accounts.repository import AccountIdentityConflictError
from app.modules.accounts.schemas import (
    AccountAliasRequest,
    AccountAliasResponse,
    AccountAuthExportResponse,
    AccountDeleteResponse,
    AccountExportResponse,
    AccountImportResponse,
    AccountLimitWarmupUpdateRequest,
    AccountLimitWarmupUpdateResponse,
    AccountOpenCodeAuthExportResponse,
    AccountPauseResponse,
    AccountProbeRequest,
    AccountProbeResponse,
    AccountReactivateResponse,
    AccountRoutingPolicyUpdateRequest,
    AccountRoutingPolicyUpdateResponse,
    AccountsResponse,
    AccountTrendsResponse,
    AccountUpdateRequest,
    AccountUpdateResponse,
    AccountUsageResetConsumeRequest,
    AccountUsageResetConsumeResponse,
    AccountUsageResetCreditsResponse,
    AccountAutoReauthResponse,
    AccountSaveCredentialsRequest,
    AutoLoginStartRequest,
    AutoLoginStateResponse,
    CodexActiveAccountResponse,
    CodexSubagentsStateResponse,
    CodexSubagentsToggleRequest,
    DeleteAllAccountsRequest,
    DeleteAllAccountsResponse,
    SwitchToCodexResponse,
)
from app.modules.accounts.service import (
    AccountNotProbableError,
    AccountStateTransitionError,
    AccountUsageResetConsumeUnavailableError,
    AccountUsageResetCreditsUnavailableError,
    InvalidAuthJsonError,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/accounts",
    tags=["dashboard"],
    dependencies=[Depends(validate_dashboard_session), Depends(set_dashboard_error_format)],
)

_ACCOUNT_IMPORT_OPENAPI_EXTRA = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "title": "Body_import_account_api_accounts_import_post",
                    "required": ["auth_json"],
                    "properties": {
                        "auth_json": {
                            "type": "string",
                            "contentMediaType": "application/octet-stream",
                            "title": "Auth Json",
                        }
                    },
                }
            }
        },
    },
    "responses": {
        "422": {
            "description": "Validation Error",
            "content": {
                "application/json": {
                    "schema": {"$ref": "#/components/schemas/HTTPValidationError"},
                }
            },
        }
    },
}


@router.get("", response_model=AccountsResponse)
async def list_accounts(
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountsResponse:
    accounts = await context.service.list_accounts()
    return AccountsResponse(accounts=accounts)


@router.post("/auto-login/start", response_model=AutoLoginStateResponse)
async def start_auto_login(
    payload: AutoLoginStartRequest,
    _write_access=Depends(require_dashboard_write_access),
    oauth_context: OauthContext = Depends(get_oauth_context),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.start(
        accounts=payload.accounts,
        oauth_service=oauth_context.service,
        delay_seconds=payload.delay_seconds,
        concurrency=payload.concurrency,
        headless=payload.headless,
    )


@router.get("/auto-login/status", response_model=AutoLoginStateResponse)
async def get_auto_login_status() -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.get_state()


@router.post("/auto-login/pause", response_model=AutoLoginStateResponse)
async def pause_auto_login(
    _write_access=Depends(require_dashboard_write_access),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.pause()


@router.post("/auto-login/resume", response_model=AutoLoginStateResponse)
async def resume_auto_login(
    _write_access=Depends(require_dashboard_write_access),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.resume()


@router.post("/auto-login/cancel", response_model=AutoLoginStateResponse)
async def cancel_auto_login(
    _write_access=Depends(require_dashboard_write_access),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.cancel()


@router.post("/auto-login/append", response_model=AutoLoginStateResponse)
async def append_auto_login(
    payload: AutoLoginStartRequest,
    _write_access=Depends(require_dashboard_write_access),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.append(accounts=payload.accounts)


@router.post("/auto-login/retry-failed", response_model=AutoLoginStateResponse)
async def retry_failed_auto_login(
    oauth_context: OauthContext = Depends(get_oauth_context),
    _write_access=Depends(require_dashboard_write_access),
) -> AutoLoginStateResponse:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.retry_failed(oauth_service=oauth_context.service)


@router.post("/auto-reauth-all-401")
async def auto_reauth_all_401_endpoint(
    oauth_context: OauthContext = Depends(get_oauth_context),
    _write_access=Depends(require_dashboard_write_access),
) -> dict:
    auto_login_service = get_auto_login_service()
    return await auto_login_service.auto_reauth_all_401(
        oauth_service=oauth_context.service,
        concurrency=2,
    )


@router.get("/{account_id}/trends", response_model=AccountTrendsResponse)
async def get_account_trends(
    account_id: str,
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountTrendsResponse:
    result = await context.service.get_account_trends(account_id)
    if not result:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return result


@router.get("/{account_id}/usage-reset-credits", response_model=AccountUsageResetCreditsResponse)
async def get_account_usage_reset_credits(
    account_id: str,
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountUsageResetCreditsResponse:
    try:
        result = await context.service.get_usage_reset_credits(account_id)
    except AccountUsageResetCreditsUnavailableError as exc:
        raise DashboardConflictError(str(exc), code="account_usage_reset_credits_unavailable") from exc
    except UpstreamProxyRouteError as exc:
        raise DashboardUpstreamError(
            f"Unable to resolve upstream proxy route for usage reset credits: {exc.reason}",
            code="upstream_proxy_unavailable",
        ) from exc
    except UsageFetchError as exc:
        raise DashboardUpstreamError(
            f"Usage reset credits fetch failed: {exc.message}",
            code="usage_reset_credits_fetch_failed",
        ) from exc
    if not result:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return result


@router.post("/{account_id}/usage-reset-credits/consume", response_model=AccountUsageResetConsumeResponse)
async def consume_account_usage_reset_credit(
    request: Request,
    account_id: str,
    payload: AccountUsageResetConsumeRequest | None = None,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountUsageResetConsumeResponse:
    try:
        result = await context.service.consume_usage_reset_credit(
            account_id,
            redeem_request_id=payload.redeem_request_id if payload is not None else None,
        )
    except AccountUsageResetConsumeUnavailableError as exc:
        raise DashboardConflictError(str(exc), code="account_usage_reset_consume_unavailable") from exc
    except UpstreamProxyRouteError as exc:
        raise DashboardUpstreamError(
            f"Unable to resolve upstream proxy route for usage reset: {exc.reason}",
            code="upstream_proxy_unavailable",
        ) from exc
    except UsageFetchError as exc:
        raise DashboardUpstreamError(
            f"Usage reset consume failed: {exc.message}",
            code="usage_reset_consume_failed",
        ) from exc
    if result is None:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    AuditService.log_async(
        "account_usage_reset_consumed",
        actor_ip=request.client.host if request.client else None,
        details={
            "account_id": result.account_id,
            "code": result.code,
            "windows_reset": result.windows_reset,
            "usage_written": result.usage_written,
        },
    )
    return result


@router.post("/{account_id}/export", response_model=AccountExportResponse, deprecated=True)
async def export_account(
    request: Request,
    response: Response,
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountExportResponse:
    result = await context.service.export_account(account_id)
    if not result:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    AuditService.log_async(
        "account_exported",
        actor_ip=request.client.host if request.client else None,
        details={"account_id": result.account_id},
    )
    return result


@router.post("/{account_id}/export/auth", response_model=AccountAuthExportResponse)
async def export_account_auth(
    request: Request,
    response: Response,
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountAuthExportResponse:
    result = await context.service.export_auth(account_id)
    if not result:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    AuditService.log_async(
        "account_auth_exported",
        actor_ip=request.client.host if request.client else None,
        details={"account_id": account_id},
    )
    return result


@router.get("/export-all-json")
async def export_all_accounts_json(
    request: Request,
    response: Response,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
):
    accounts = await context.service.export_all_bulk_json()
    response.headers["Content-Disposition"] = "attachment; filename=codex_lb_accounts_backup.json"
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
    AuditService.log_async(
        "all_accounts_exported",
        actor_ip=request.client.host if request.client else None,
        details={"count": len(accounts)},
    )
    return accounts


@router.post("/{account_id}/export/opencode-auth", response_model=AccountOpenCodeAuthExportResponse, deprecated=True)
async def export_account_opencode_auth(
    request: Request,
    response: Response,
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountOpenCodeAuthExportResponse:
    result = await context.service.export_opencode_auth(account_id)
    if not result:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    AuditService.log_async(
        "account_auth_exported",
        actor_ip=request.client.host if request.client else None,
        details={"account_id": account_id},
    )
    return result


@router.post("/{account_id}/switch-to-codex", response_model=SwitchToCodexResponse)
async def switch_account_to_codex(
    request: Request,
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> SwitchToCodexResponse:
    result = await context.service.switch_to_codex(account_id)
    AuditService.log_async(
        "account_switched_to_codex",
        actor_ip=request.client.host if request.client else None,
        details={"account_id": account_id, "email": result.email},
    )
    return result


@router.get("/codex-active", response_model=CodexActiveAccountResponse)
def get_current_active_codex_account(
    context: AccountsContext = Depends(get_accounts_context),
) -> CodexActiveAccountResponse:
    return context.service.get_active_codex_account()


@router.post("/launch-codex-cli")
def launch_codex_cli():
    import os
    import subprocess

    # Launch official ChatGPT Windows App
    try:
        subprocess.Popen(
            'explorer.exe shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App',
            shell=True,
        )
    except Exception:
        pass

    codex_exe = r"C:\Users\acer\AppData\Local\OpenAI\Codex\bin\e305f1c75d8da435\codex.exe"
    if not os.path.exists(codex_exe):
        codex_exe = "codex"

    try:
        subprocess.Popen(
            f'start cmd.exe /k title Codex CLI ^&^& "{codex_exe}"',
            shell=True,
        )
        return {"status": "ok", "message": "Đã mở ứng dụng ChatGPT & Codex thành công!"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/codex-auto-rotate/status")
def get_codex_auto_rotate_status():
    from app.modules.accounts.codex_auto_switcher import get_codex_auto_switcher
    switcher = get_codex_auto_switcher()
    return {
        "enabled": switcher.enabled,
        "threshold_percent": switcher.threshold_percent,
        "remaining_trigger_percent": round(100.0 - switcher.threshold_percent, 1),
        "last_switch_info": switcher._last_switch_info,
    }


@router.post("/codex-auto-rotate/check")
async def trigger_codex_auto_rotate_check():
    from app.modules.accounts.codex_auto_switcher import get_codex_auto_switcher
    switcher = get_codex_auto_switcher()
    res = await switcher.check_and_auto_rotate()
    return {"status": "ok", "rotated": bool(res), "detail": res}


@router.get("/codex-subagents", response_model=CodexSubagentsStateResponse)
def get_codex_subagents_state() -> CodexSubagentsStateResponse:
    from pathlib import Path
    config_path = Path.home() / ".codex" / "config.toml"
    if not config_path.exists():
        return CodexSubagentsStateResponse(enabled=False)
    try:
        content = config_path.read_text(encoding="utf-8")
        import tomllib
        data = tomllib.loads(content)
        enabled = data.get("features", {}).get("multi_agent", False)
        return CodexSubagentsStateResponse(enabled=bool(enabled))
    except Exception as e:
        logger.warning(f"Error reading codex subagents config: {e}")
        return CodexSubagentsStateResponse(enabled=False)


@router.post("/codex-subagents/toggle", response_model=CodexSubagentsStateResponse)
def toggle_codex_subagents(payload: CodexSubagentsToggleRequest) -> CodexSubagentsStateResponse:
    import re
    from pathlib import Path
    config_path = Path.home() / ".codex" / "config.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    target_state = payload.enabled
    try:
        content = ""
        if config_path.exists():
            content = config_path.read_text(encoding="utf-8")
        
        if "[features]" in content:
            if re.search(r"multi_agent\s*=\s*(true|false)", content, re.IGNORECASE):
                new_content = re.sub(
                    r"multi_agent\s*=\s*(true|false)",
                    f"multi_agent = {'true' if target_state else 'false'}",
                    content,
                    flags=re.IGNORECASE,
                )
            else:
                new_content = content.replace("[features]", f"[features]\nmulti_agent = {'true' if target_state else 'false'}")
        else:
            new_content = f"""model = "gpt-5.6-luna"
model_provider = "openai-custom"

[features]
multi_agent = {'true' if target_state else 'false'}

[model_providers.openai-custom]
name = "OpenAI Custom (Codex-LB)"
base_url = "http://localhost:2455/v1"
api_key = "codex-lb"
"""
        config_path.write_text(new_content, encoding="utf-8")
        msg = "Đã BẬT Subagents (đa luồng) cho Codex!" if target_state else "Đã TẮT Subagents (chế độ đơn) cho Codex!"
        return CodexSubagentsStateResponse(enabled=target_state, message=msg)
    except Exception as e:
        logger.error(f"Error writing codex subagents config: {e}")
        return CodexSubagentsStateResponse(enabled=False, message=str(e))


@router.post(
    "/import",
    response_model=AccountImportResponse,
    openapi_extra=_ACCOUNT_IMPORT_OPENAPI_EXTRA,
)
async def import_account(
    request: Request,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountImportResponse:
    raise_for_unsupported_multipart_content_encoding(request)
    async with bounded_multipart_form(
        request,
        ACCOUNT_IMPORT_MULTIPART_POLICY,
        typed_upload_fields=("auth_json", "file"),
    ) as form:
        upload_item = form.get("auth_json") or form.get("file")
        if upload_item is None:
            upload_item = required_upload(form, "auth_json")
        raw = await read_bounded_upload(
            upload_item,
            max_bytes=ACCOUNT_IMPORT_MULTIPART_POLICY.max_file_bytes,
            param="auth_json",
        )
    try:
        response = await context.service.import_account(raw)
        AuditService.log_async(
            "account_created",
            actor_ip=request.client.host if request.client else None,
            details={"account_id": response.account_id},
        )
        return response
    except InvalidAuthJsonError as exc:
        raise DashboardBadRequestError("Invalid auth.json payload", code="invalid_auth_json") from exc
    except AccountIdentityConflictError as exc:
        raise DashboardConflictError(str(exc), code="duplicate_identity_conflict") from exc


@router.post("/{account_id}/reactivate", response_model=AccountReactivateResponse)
async def reactivate_account(
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountReactivateResponse:
    try:
        success = await context.service.reactivate_account(account_id)
    except AccountStateTransitionError as exc:
        raise DashboardConflictError(str(exc), code="account_state_transition_invalid") from exc
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return AccountReactivateResponse(status="reactivated")


@router.patch("/{account_id}", response_model=AccountUpdateResponse)
async def update_account(
    account_id: str,
    payload: AccountUpdateRequest,
    request: Request,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountUpdateResponse:
    changed_fields = [field for field, value in payload.model_dump(exclude_unset=True).items() if value is not None]
    if not changed_fields:
        raise DashboardBadRequestError("No supported account fields to update", code="empty_account_update")
    success = await context.service.update_account(
        account_id,
        security_work_authorized=payload.security_work_authorized,
    )
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    AuditService.log_async(
        "account_updated",
        actor_ip=request.client.host if request.client else None,
        details={
            "account_id": account_id,
            "changed_fields": changed_fields,
        },
    )
    return AccountUpdateResponse(status="updated")


@router.post("/{account_id}/probe", response_model=AccountProbeResponse)
async def probe_account(
    request: Request,
    account_id: str,
    body: AccountProbeRequest | None = None,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountProbeResponse:
    requested_model = body.model if body is not None else None
    try:
        result = await context.service.probe_account(account_id, model=requested_model)
    except AccountNotProbableError as exc:
        raise DashboardConflictError(str(exc), code="account_not_probable") from exc
    except RefreshError as exc:
        raise DashboardConflictError(
            f"Probe could not refresh account credentials: {exc.message}",
            code="account_probe_refresh_failed",
        ) from exc
    if result is None:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    probe_succeeded = 200 <= result.probe_status_code < 300
    if not probe_succeeded or result.usage_refresh_ready_for_probe_settlement():
        try:
            await get_proxy_service_for_app(request.app).record_account_probe_result(
                account_id=result.account_id,
                http_status=result.probe_status_code,
            )
        except Exception:
            logger.exception(
                "Force Probe advisory settlement failed account_id=%s probe_status_code=%s",
                result.account_id,
                result.probe_status_code,
            )
    else:
        logger.warning(
            "Force Probe success skipped advisory settlement before successful usage refresh fetch "
            "account_id=%s probe_status_code=%s",
            result.account_id,
            result.probe_status_code,
        )
    AuditService.log_async(
        "account_probed",
        actor_ip=request.client.host if request.client else None,
        details={
            "account_id": result.account_id,
            "probe_status_code": result.probe_status_code,
            "model": requested_model,
        },
    )
    return result


@router.post("/{account_id}/pause", response_model=AccountPauseResponse)
async def pause_account(
    account_id: str,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountPauseResponse:
    try:
        success = await context.service.pause_account(account_id)
    except AccountStateTransitionError as exc:
        raise DashboardConflictError(str(exc), code="account_state_transition_invalid") from exc
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return AccountPauseResponse(status="paused")


@router.put("/{account_id}/alias", response_model=AccountAliasResponse)
async def set_account_alias(
    account_id: str,
    payload: AccountAliasRequest,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountAliasResponse:
    success = await context.service.set_account_alias(account_id, payload.alias)
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    normalized = payload.alias.strip() if isinstance(payload.alias, str) else None
    if normalized == "":
        normalized = None
    return AccountAliasResponse(account_id=account_id, alias=normalized)


@router.put("/{account_id}/limit-warmup", response_model=AccountLimitWarmupUpdateResponse)
async def update_account_limit_warmup(
    account_id: str,
    payload: AccountLimitWarmupUpdateRequest,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountLimitWarmupUpdateResponse:
    success = await context.service.set_limit_warmup_enabled(account_id, payload.enabled)
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return AccountLimitWarmupUpdateResponse(
        status="enabled" if payload.enabled else "disabled",
        enabled=payload.enabled,
    )


@router.put("/{account_id}/routing-policy", response_model=AccountRoutingPolicyUpdateResponse)
async def update_account_routing_policy(
    account_id: str,
    payload: AccountRoutingPolicyUpdateRequest,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountRoutingPolicyUpdateResponse:
    success = await context.service.set_routing_policy(account_id, payload.routing_policy)
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    return AccountRoutingPolicyUpdateResponse(account_id=account_id, routing_policy=payload.routing_policy)


@router.delete("/{account_id}", response_model=AccountDeleteResponse)
async def delete_account(
    request: Request,
    account_id: str,
    delete_history: bool = False,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> AccountDeleteResponse:
    success = await context.service.delete_account(account_id, delete_history=delete_history)
    if not success:
        raise DashboardNotFoundError("Account not found", code="account_not_found")
    AuditService.log_async(
        "account_deleted",
        actor_ip=request.client.host if request.client else None,
        details={"account_id": account_id, "delete_history": delete_history},
    )
    return AccountDeleteResponse(status="deleted")


@router.post("/delete-all", response_model=DeleteAllAccountsResponse)
async def delete_all_accounts_endpoint(
    request: Request,
    payload: DeleteAllAccountsRequest | None = None,
    _write_access=Depends(require_dashboard_write_access),
    context: AccountsContext = Depends(get_accounts_context),
) -> DeleteAllAccountsResponse:
    delete_history = payload.delete_history if payload else False
    clear_vault = payload.clear_vault if payload else False
    account_ids = payload.account_ids if payload else None

    count = await context.service.delete_all_accounts(
        delete_history=delete_history,
        account_ids=account_ids,
    )
    if clear_vault:
        auto_login_service = get_auto_login_service()
        auto_login_service.clear_vault()

    AuditService.log_async(
        "all_accounts_deleted",
        actor_ip=request.client.host if request.client else None,
        details={"deleted_count": count, "delete_history": delete_history, "clear_vault": clear_vault},
    )
    return DeleteAllAccountsResponse(deleted_count=count, status="deleted")


@router.post("/{account_id}/auto-reauth", response_model=AccountAutoReauthResponse)
async def auto_reauth_account_endpoint(
    account_id: str,
    context: AccountsContext = Depends(get_accounts_context),
    oauth_context: OauthContext = Depends(get_oauth_context),
    _write_access=Depends(require_dashboard_write_access),
) -> AccountAutoReauthResponse:
    return await context.service.auto_reauth_account(
        account_id=account_id,
        oauth_service=oauth_context.service,
    )


@router.post("/{account_id}/save-credentials")
async def save_account_credentials_endpoint(
    account_id: str,
    payload: AccountSaveCredentialsRequest,
    _write_access=Depends(require_dashboard_write_access),
) -> dict[str, str]:
    auto_login_service = get_auto_login_service()
    auto_login_service.save_credential(
        email=payload.email,
        password=payload.password,
        two_factor_secret=payload.two_factor_secret,
    )
    return {"status": "saved", "email": payload.email}


@router.get("/{account_id}/has-credentials")
async def has_account_credentials_endpoint(
    account_id: str,
    context: AccountsContext = Depends(get_accounts_context),
) -> dict[str, bool]:
    account = await context.service.get_account_detail(account_id)
    if not account:
        return {"has_credentials": False}
    auto_login_service = get_auto_login_service()
    return {"has_credentials": auto_login_service.has_credential(account.email)}
