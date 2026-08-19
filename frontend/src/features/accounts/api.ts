import { del, get, patch, post, put } from "@/lib/api-client";

import {
  AccountActionResponseSchema,
  AccountAliasRequestSchema,
  AccountAliasResponseSchema,
  AccountAuthExportResponseSchema,
  AccountImportResponseSchema,
  AccountLimitWarmupUpdateRequestSchema,
  AccountLimitWarmupUpdateResponseSchema,
  AccountUpdateRequestSchema,
  AccountsResponseSchema,
  AccountRoutingPolicyUpdateRequestSchema,
  AccountRoutingPolicyUpdateResponseSchema,
  AccountUsageResetConsumeRequestSchema,
  AccountUsageResetConsumeResponseSchema,
  AccountUsageResetCreditsResponseSchema,
  AccountTrendsResponseSchema,
  AccountProbeRequestSchema,
  AccountProbeResponseSchema,
  AccountAutoReauthResponseSchema,
  AutoLoginStartRequestSchema,
  AutoLoginStateResponseSchema,
  ConsumeRateLimitResetCreditResponseSchema,
  ManualOauthCallbackRequestSchema,
  ManualOauthCallbackResponseSchema,
  OauthCompleteRequestSchema,
  OauthCompleteResponseSchema,
  OauthStartRequestSchema,
  OauthStartResponseSchema,
  OauthStatusResponseSchema,
  RateLimitResetCreditsSnapshotSchema,
  RuntimeConnectAddressResponseSchema,
  SwitchToCodexResponseSchema,
  CodexActiveAccountResponseSchema,
  DeleteAllAccountsRequestSchema,
  DeleteAllAccountsResponseSchema,
} from "@/features/accounts/schemas";
import type {
  AccountRoutingPolicy,
  AccountUsageResetConsumeRequest,
} from "@/features/accounts/schemas";

const ACCOUNTS_BASE_PATH = "/api/accounts";
const OAUTH_BASE_PATH = "/api/oauth";

export function listAccounts() {
  return get(ACCOUNTS_BASE_PATH, AccountsResponseSchema);
}

export function importAccount(file: File) {
  const formData = new FormData();
  formData.append("auth_json", file);
  return post(`${ACCOUNTS_BASE_PATH}/import`, AccountImportResponseSchema, {
    body: formData,
  });
}

export function pauseAccount(accountId: string) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/pause`,
    AccountActionResponseSchema,
  );
}

export function reactivateAccount(accountId: string) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/reactivate`,
    AccountActionResponseSchema,
  );
}

export function setAccountAlias(accountId: string, alias: string | null) {
  const validated = AccountAliasRequestSchema.parse({ alias });
  return put(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/alias`,
    AccountAliasResponseSchema,
    { body: validated },
  );
}

export function updateAccount(accountId: string, payload: unknown) {
  const validated = AccountUpdateRequestSchema.parse(payload);
  return patch(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}`,
    AccountActionResponseSchema,
    { body: validated },
  );
}

export function updateAccountLimitWarmup(accountId: string, enabled: boolean) {
  const payload = AccountLimitWarmupUpdateRequestSchema.parse({ enabled });
  return put(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/limit-warmup`,
    AccountLimitWarmupUpdateResponseSchema,
    { body: payload },
  );
}

export function updateAccountRoutingPolicy(
  accountId: string,
  routingPolicy: AccountRoutingPolicy,
) {
  const payload = AccountRoutingPolicyUpdateRequestSchema.parse({ routingPolicy });
  return put(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/routing-policy`,
    AccountRoutingPolicyUpdateResponseSchema,
    { body: payload },
  );
}

export function getAccountTrends(accountId: string) {
  return get(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/trends`,
    AccountTrendsResponseSchema,
  );
}

export function getAccountUsageResetCredits(accountId: string) {
  return get(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/usage-reset-credits`,
    AccountUsageResetCreditsResponseSchema,
  );
}

export function consumeAccountUsageResetCredit(
  accountId: string,
  payload?: AccountUsageResetConsumeRequest,
) {
  const validated = payload === undefined ? undefined : AccountUsageResetConsumeRequestSchema.parse(payload);
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/usage-reset-credits/consume`,
    AccountUsageResetConsumeResponseSchema,
    validated ? { body: validated } : undefined,
  );
}

export function probeAccount(accountId: string, payload?: unknown) {
  const validated = payload === undefined ? undefined : AccountProbeRequestSchema.parse(payload);
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/probe`,
    AccountProbeResponseSchema,
    validated ? { body: validated } : undefined,
  );
}

export function exportAccountAuth(accountId: string) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/export/auth`,
    AccountAuthExportResponseSchema,
  );
}

export function getRateLimitResetCredits(accountId: string) {
  return get(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/rate-limit-reset-credits`,
    RateLimitResetCreditsSnapshotSchema.nullable(),
  );
}

export function consumeRateLimitResetCredit(
  accountId: string,
  payload?: AccountUsageResetConsumeRequest,
) {
  const validated = payload === undefined ? undefined : AccountUsageResetConsumeRequestSchema.parse(payload);
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/rate-limit-reset-credits/consume`,
    ConsumeRateLimitResetCreditResponseSchema,
    validated ? { body: validated } : undefined,
  );
}

export function deleteAccount(accountId: string, deleteHistory = false) {
  const qs = deleteHistory ? "?delete_history=true" : "";
  return del(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}${qs}`,
    AccountActionResponseSchema,
  );
}

export function deleteAllAccounts(deleteHistory = false, clearVault = false, accountIds?: string[]) {
  const payload = DeleteAllAccountsRequestSchema.parse({
    delete_history: deleteHistory,
    clear_vault: clearVault,
    account_ids: accountIds,
  });
  return post(
    `${ACCOUNTS_BASE_PATH}/delete-all`,
    DeleteAllAccountsResponseSchema,
    { body: payload },
  );
}

export function startOauth(payload: unknown) {
  const validated = OauthStartRequestSchema.parse(payload);
  return post(`${OAUTH_BASE_PATH}/start`, OauthStartResponseSchema, {
    body: validated,
  });
}

export function getOauthStatus(flowId?: string) {
  const query = flowId ? `?flowId=${encodeURIComponent(flowId)}` : "";
  return get(`${OAUTH_BASE_PATH}/status${query}`, OauthStatusResponseSchema);
}

export function completeOauth(payload?: unknown) {
  const validated = OauthCompleteRequestSchema.parse(payload ?? {});
  return post(`${OAUTH_BASE_PATH}/complete`, OauthCompleteResponseSchema, {
    body: validated,
  });
}

export function submitManualOauthCallback(payload: unknown) {
  const validated = ManualOauthCallbackRequestSchema.parse(payload);
  return post(`${OAUTH_BASE_PATH}/manual-callback`, ManualOauthCallbackResponseSchema, {
    body: validated,
  });
}

export function getRuntimeConnectAddress() {
  return get("/api/settings/runtime/connect-address", RuntimeConnectAddressResponseSchema);
}

export function startAutoLogin(payload: unknown) {
  const validated = AutoLoginStartRequestSchema.parse(payload);
  return post(`${ACCOUNTS_BASE_PATH}/auto-login/start`, AutoLoginStateResponseSchema, {
    body: validated,
  });
}

export function getAutoLoginStatus() {
  return get(`${ACCOUNTS_BASE_PATH}/auto-login/status`, AutoLoginStateResponseSchema);
}

export function pauseAutoLogin() {
  return post(`${ACCOUNTS_BASE_PATH}/auto-login/pause`, AutoLoginStateResponseSchema);
}

export function resumeAutoLogin() {
  return post(`${ACCOUNTS_BASE_PATH}/auto-login/resume`, AutoLoginStateResponseSchema);
}

export function cancelAutoLogin() {
  return post(`${ACCOUNTS_BASE_PATH}/auto-login/cancel`, AutoLoginStateResponseSchema);
}

export function appendAutoLogin(payload: unknown) {
  const validated = AutoLoginStartRequestSchema.parse(payload);
  return post(`${ACCOUNTS_BASE_PATH}/auto-login/append`, AutoLoginStateResponseSchema, {
    body: validated,
  });
}

export function switchToCodex(accountId: string) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/switch-to-codex`,
    SwitchToCodexResponseSchema,
  );
}

export function getCodexActiveAccount() {
  return get(`${ACCOUNTS_BASE_PATH}/codex-active`, CodexActiveAccountResponseSchema);
}

export function launchCodexCli() {
  return post(`${ACCOUNTS_BASE_PATH}/launch-codex-cli`, null);
}

export function autoReauthAccount(accountId: string) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/auto-reauth`,
    AccountAutoReauthResponseSchema,
  );
}

export function saveAccountCredentials(accountId: string, payload: { email: string; password: string; two_factor_secret?: string | null }) {
  return post(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/save-credentials`,
    null,
    { body: payload },
  );
}

export function hasAccountCredentials(accountId: string) {
  return get<{ has_credentials?: boolean }>(
    `${ACCOUNTS_BASE_PATH}/${encodeURIComponent(accountId)}/has-credentials`,
  );
}

export function autoReauthAll401() {
  return post<{ total_401: number; reauthed: number; failed: number; no_credentials: number; message: string }>(
    `${ACCOUNTS_BASE_PATH}/auto-reauth-all-401`,
    null,
  );
}
