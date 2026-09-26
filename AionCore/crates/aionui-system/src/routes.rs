#![allow(clippy::disallowed_types)]

use std::sync::Arc;

use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Json, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};

use aionui_api_types::{
    AdminUserResponse, ApiResponse, ClientPreferencesResponse, CreateProviderRequest, CurrentUserResponse,
    DetectProtocolRequest, EnsureNodeRuntimeRequest, EnsureNodeRuntimeResponse, FeedbackDiagnosticsQuery,
    FeedbackDiagnosticsResponse, FetchModelsAnonymousRequest, FetchModelsRequest, FetchModelsResponse,
    ProtocolDetectionResponse, ProviderResponse, SystemInfoResponse, SystemSettingsResponse, UpdateCheckRequest,
    UpdateCheckResult, UpdateClientPreferencesRequest, UpdateProviderRequest, UpdateSettingsRequest,
};
use aionui_auth::CurrentUser;
use aionui_common::ApiError;
use aionui_db::IUserRepository;

use crate::client_pref::ClientPrefService;
use crate::diagnostics::FeedbackDiagnosticsService;
use crate::error::SystemError;
use crate::model_fetcher::ModelFetchService;
use crate::protocol::ProtocolDetectionService;
use crate::provider::ProviderService;
use crate::runtime_prepare::RuntimePrepareService;
use crate::settings::SettingsService;
use crate::version::VersionCheckService;

/// Shared state for system route handlers.
#[derive(Clone)]
pub struct SystemRouterState {
    pub settings_service: SettingsService,
    pub client_pref_service: ClientPrefService,
    pub provider_service: ProviderService,
    pub model_fetch_service: ModelFetchService,
    pub protocol_detection_service: ProtocolDetectionService,
    pub version_check_service: VersionCheckService,
    pub runtime_prepare_service: RuntimePrepareService,
    pub feedback_diagnostics_service: FeedbackDiagnosticsService,
    /// User repository for the admin console (`/api/admin/*`).
    pub user_repo: Arc<dyn IUserRepository>,
}

impl From<SystemError> for ApiError {
    fn from(error: SystemError) -> Self {
        match error {
            SystemError::NotFound(reason) => ApiError::NotFound(reason),
            SystemError::BadRequest(reason) => ApiError::BadRequest(reason),
            SystemError::Conflict(reason) => ApiError::Conflict(reason),
            SystemError::Internal(reason) => ApiError::Internal(reason),
            SystemError::BadGateway(reason) => ApiError::BadGateway(reason),
            SystemError::Timeout(reason) => ApiError::Timeout(reason),
            SystemError::UnprocessableEntity(reason) => ApiError::UnprocessableEntity(reason),
        }
    }
}

/// Build the system router (settings + client prefs + providers + system).
///
/// All routes require authentication (applied by the caller).
///
/// Endpoints:
/// - `GET  /api/settings`                    — get all backend settings
/// - `PATCH /api/settings`                   — partial update backend settings
/// - `GET  /api/settings/client`             — get client preferences
/// - `PUT  /api/settings/client`             — batch update client preferences
/// - `GET  /api/providers`                   — list all providers
/// - `POST /api/providers`                   — create a provider
/// - `PUT  /api/providers/:id`               — update a provider
/// - `DELETE /api/providers/:id`             — delete a provider
/// - `POST /api/providers/:id/models`        — fetch models from remote API
/// - `POST /api/providers/fetch-models`      — fetch models anonymously (pre-create preview)
/// - `POST /api/providers/detect-protocol`   — detect API protocol
/// - `GET  /api/system/current-user`         — the identity the auth middleware injected
/// - `GET  /api/system/info`                 — system directory & platform info
/// - `POST /api/system/check-update`         — check GitHub for new versions
/// - `POST /api/system/ensure-node-runtime`  — prepare managed Node runtime
/// - `GET  /api/system/diagnostics/feedback-report` — collect sanitized feedback diagnostics
pub fn system_routes(state: SystemRouterState) -> Router {
    Router::new()
        .route("/api/settings", get(get_settings).patch(update_settings))
        .route(
            "/api/settings/client",
            get(get_client_preferences).put(update_client_preferences),
        )
        .route("/api/providers", get(list_providers).post(create_provider))
        // Literal-segment routes must register BEFORE the `/{id}` routes so
        // axum matches the literals instead of treating "detect-protocol" /
        // "fetch-models" as a provider id.
        .route("/api/providers/detect-protocol", post(detect_protocol))
        .route("/api/providers/fetch-models", post(fetch_models_anonymous))
        .route("/api/providers/{id}", delete(delete_provider).put(update_provider))
        .route("/api/providers/{id}/models", post(fetch_models))
        // Admin console (multi-user WebUI): manage users' providers on their
        // behalf. Gated to the seed admin inside every handler; the router
        // itself is behind the authenticated layer like the rest of this file.
        .route("/api/admin/users", get(list_admin_users))
        .route(
            "/api/admin/users/{user_id}/providers",
            get(admin_list_providers).post(admin_create_provider),
        )
        .route(
            "/api/admin/users/{user_id}/providers/{provider_id}",
            put(admin_update_provider).delete(admin_delete_provider),
        )
        .route("/api/system/current-user", get(get_current_user))
        .route("/api/system/info", get(get_system_info))
        .route("/api/system/check-update", post(check_update))
        .route("/api/system/ensure-node-runtime", post(ensure_node_runtime))
        .route("/api/system/diagnostics/feedback-report", get(get_feedback_diagnostics))
        .with_state(state)
}

/// Backwards-compatible alias — delegates to `system_routes`.
pub fn settings_routes(state: SystemRouterState) -> Router {
    system_routes(state)
}

// ===========================================================================
// Settings handlers
// ===========================================================================

async fn get_settings(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<ApiResponse<SystemSettingsResponse>>, ApiError> {
    let settings = state
        .settings_service
        .get_settings(&user.id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(settings)))
}

async fn get_feedback_diagnostics(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<FeedbackDiagnosticsQuery>,
) -> Result<Json<ApiResponse<FeedbackDiagnosticsResponse>>, ApiError> {
    let diagnostics = state
        .feedback_diagnostics_service
        .collect(&user.id, query)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(diagnostics)))
}

async fn update_settings(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    body: Result<Json<UpdateSettingsRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<SystemSettingsResponse>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let settings = state
        .settings_service
        .update_settings(&user.id, req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(settings)))
}

// ===========================================================================
// Client preferences handlers
// ===========================================================================

#[derive(Debug, serde::Deserialize, Default)]
struct ClientPrefQuery {
    keys: Option<String>,
}

async fn get_client_preferences(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<ClientPrefQuery>,
) -> Result<Json<ApiResponse<ClientPreferencesResponse>>, ApiError> {
    let keys_filter: Option<Vec<String>> = query.keys.map(|k| {
        k.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    let key_refs: Option<Vec<&str>> = keys_filter.as_ref().map(|v| v.iter().map(|s| s.as_str()).collect());

    let prefs = state
        .client_pref_service
        .get_preferences(&user.id, key_refs.as_deref())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(prefs)))
}

async fn update_client_preferences(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    body: Result<Json<UpdateClientPreferencesRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    state
        .client_pref_service
        .update_preferences(&user.id, req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::success()))
}

// ===========================================================================
// Provider handlers
// ===========================================================================

/// The fixed seed account (aionui-db seeds `id = system_default_user`): the
/// admin console identity. The id never changes even if the username is
/// renamed, so gating and masking both key off it.
const ADMIN_USER_ID: &str = "system_default_user";

/// Stand-in returned to non-admin callers instead of a real API key, and
/// recognized on update as "keep the stored key" (clients may echo a masked
/// value straight back when saving an untouched form).
const MASKED_API_KEY: &str = "********";

fn require_admin(user: &CurrentUser) -> Result<(), ApiError> {
    if user.id == ADMIN_USER_ID {
        Ok(())
    } else {
        Err(ApiError::Forbidden("Administrator access required".into()))
    }
}

/// Replace the decrypted key with the mask — non-admin requesters (e.g. a
/// guest using an admin-provisioned provider) must be able to USE the key but
/// never read it.
fn mask_provider_key(mut provider: ProviderResponse) -> ProviderResponse {
    provider.api_key = MASKED_API_KEY.to_string();
    provider
}

fn maybe_mask_for(user: &CurrentUser, provider: ProviderResponse) -> ProviderResponse {
    if user.id == ADMIN_USER_ID {
        provider
    } else {
        mask_provider_key(provider)
    }
}

/// Map a repository error through `SystemError` into the shared API error.
fn db_err(error: aionui_db::DbError) -> ApiError {
    ApiError::from(SystemError::from(error))
}

async fn list_providers(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<ApiResponse<Vec<ProviderResponse>>>, ApiError> {
    let providers = state.provider_service.list(&user.id).await.map_err(ApiError::from)?;
    let providers = if user.id == ADMIN_USER_ID {
        providers
    } else {
        providers.into_iter().map(mask_provider_key).collect()
    };
    Ok(Json(ApiResponse::ok(providers)))
}

async fn create_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    body: Result<Json<CreateProviderRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ApiResponse<ProviderResponse>>), ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let provider = state
        .provider_service
        .create(&user.id, req)
        .await
        .map_err(ApiError::from)?;
    Ok((
        StatusCode::CREATED,
        Json(ApiResponse::ok(maybe_mask_for(&user, provider))),
    ))
}

async fn update_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Result<Json<UpdateProviderRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<ProviderResponse>>, ApiError> {
    let Json(mut req) = body.map_err(ApiError::from)?;
    // A masked key echoed back by an unchanged edit form means "no change".
    if req.api_key.as_deref() == Some(MASKED_API_KEY) {
        req.api_key = None;
    }
    let provider = state
        .provider_service
        .update(&user.id, &id, req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(maybe_mask_for(&user, provider))))
}

async fn delete_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    state
        .provider_service
        .delete(&user.id, &id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::success()))
}

async fn fetch_models(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Result<Json<FetchModelsRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<FetchModelsResponse>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let result = state
        .model_fetch_service
        .fetch_models(&user.id, &id, &req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(result)))
}

async fn fetch_models_anonymous(
    State(state): State<SystemRouterState>,
    body: Result<Json<FetchModelsAnonymousRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<FetchModelsResponse>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let result = state
        .model_fetch_service
        .fetch_models_anonymous(&req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(result)))
}

async fn detect_protocol(
    State(state): State<SystemRouterState>,
    body: Result<Json<DetectProtocolRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<ProtocolDetectionResponse>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let result = state
        .protocol_detection_service
        .detect_protocol(&req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(result)))
}

// ===========================================================================
// Admin console handlers (`/api/admin/*`, admin identity only)
// ===========================================================================

/// Ensure the target user of an admin operation exists (404 otherwise).
async fn ensure_user_exists(state: &SystemRouterState, user_id: &str) -> Result<(), ApiError> {
    let user = state.user_repo.find_by_id(user_id).await.map_err(db_err)?;
    if user.is_none() {
        return Err(ApiError::NotFound("User not found".into()));
    }
    Ok(())
}

/// `GET /api/admin/users` — list all local accounts for the admin console.
async fn list_admin_users(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<ApiResponse<Vec<AdminUserResponse>>>, ApiError> {
    require_admin(&user)?;
    let primary = state.user_repo.get_primary_webui_user().await.map_err(db_err)?;
    let primary_id = primary.map(|u| u.id);
    let users = state.user_repo.list_users().await.map_err(db_err)?;
    let items = users
        .into_iter()
        .map(|u| AdminUserResponse {
            is_primary: Some(u.id.clone()) == primary_id,
            id: u.id,
            username: u.username.unwrap_or_default(),
            user_type: u.user_type.as_str().to_owned(),
            status: u.status.as_str().to_owned(),
            created_at: u.created_at,
            last_login: u.last_login,
        })
        .collect();
    Ok(Json(ApiResponse::ok(items)))
}

/// `GET /api/admin/users/{user_id}/providers` — providers of a target user,
/// plaintext keys visible (the admin manages them).
async fn admin_list_providers(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path(user_id): Path<String>,
) -> Result<Json<ApiResponse<Vec<ProviderResponse>>>, ApiError> {
    require_admin(&user)?;
    ensure_user_exists(&state, &user_id).await?;
    let providers = state.provider_service.list(&user_id).await.map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(providers)))
}

/// `POST /api/admin/users/{user_id}/providers` — provision a provider (with
/// its API key) for another user.
async fn admin_create_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path(user_id): Path<String>,
    body: Result<Json<CreateProviderRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<ApiResponse<ProviderResponse>>), ApiError> {
    require_admin(&user)?;
    ensure_user_exists(&state, &user_id).await?;
    let Json(req) = body.map_err(ApiError::from)?;
    let provider = state
        .provider_service
        .create(&user_id, req)
        .await
        .map_err(ApiError::from)?;
    Ok((StatusCode::CREATED, Json(ApiResponse::ok(provider))))
}

/// `PUT /api/admin/users/{user_id}/providers/{provider_id}` — update a
/// target user's provider (e.g. rotate the key).
async fn admin_update_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path((user_id, provider_id)): Path<(String, String)>,
    body: Result<Json<UpdateProviderRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<ProviderResponse>>, ApiError> {
    require_admin(&user)?;
    ensure_user_exists(&state, &user_id).await?;
    let Json(req) = body.map_err(ApiError::from)?;
    let provider = state
        .provider_service
        .update(&user_id, &provider_id, req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(provider)))
}

/// `DELETE /api/admin/users/{user_id}/providers/{provider_id}`.
async fn admin_delete_provider(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    Path((user_id, provider_id)): Path<(String, String)>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    require_admin(&user)?;
    ensure_user_exists(&state, &user_id).await?;
    state
        .provider_service
        .delete(&user_id, &provider_id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::success()))
}

// ===========================================================================
// System info & version check handlers
// ===========================================================================

/// `GET /api/system/current-user` — echo the identity the auth middleware
/// injected for this request.
///
/// No repository lookup on purpose: the answer must be exactly what the
/// middleware decided, because callers use it to recognise their own id inside
/// broadcast payloads. Reading the user row instead would introduce a second
/// source that can disagree with request scoping.
///
/// Lives here rather than in `aionui-auth` because the auth router builds its
/// own `AuthState` that is never in `Local` identity mode, so a route there
/// would 401 in exactly the case this exists to serve.
async fn get_current_user(Extension(user): Extension<CurrentUser>) -> Json<ApiResponse<CurrentUserResponse>> {
    Json(ApiResponse::ok(CurrentUserResponse {
        id: user.id,
        username: user.username,
    }))
}

async fn get_system_info() -> Json<ApiResponse<SystemInfoResponse>> {
    let info = crate::sysinfo::get_system_info();
    Json(ApiResponse::ok(info))
}

async fn check_update(
    State(state): State<SystemRouterState>,
    body: Result<Json<UpdateCheckRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<UpdateCheckResult>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let result = state
        .version_check_service
        .check_update(&req)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ApiResponse::ok(result)))
}

async fn ensure_node_runtime(
    State(state): State<SystemRouterState>,
    Extension(user): Extension<CurrentUser>,
    body: Result<Json<EnsureNodeRuntimeRequest>, JsonRejection>,
) -> Result<Json<ApiResponse<EnsureNodeRuntimeResponse>>, ApiError> {
    let Json(req) = body.map_err(ApiError::from)?;
    let result = state
        .runtime_prepare_service
        .ensure_node_runtime_for_user(&user.id, req.scope)
        .await?;
    Ok(Json(ApiResponse::ok(result)))
}
