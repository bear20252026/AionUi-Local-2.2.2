//! Black-box integration tests for the admin console routes
//! (`/api/admin/*`) and API-key masking on the regular provider routes.
//!
//! CurrentUser is injected via request extensions (same pattern as
//! `provider_routes.rs`) — no auth middleware in this suite.

use std::sync::Arc;

use aionui_realtime::BroadcastEventBus;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use aionui_auth::CurrentUser;
use aionui_db::{
    SqliteClientPreferenceRepository, SqliteFeedbackDiagnosticsRepository, SqliteProviderRepository,
    SqliteSettingsRepository, SqliteUserRepository, UserStatus, UserType, init_database_memory,
};
use aionui_system::{
    ClientPrefService, FeedbackDiagnosticsService, ModelFetchService, ProtocolDetectionService, ProviderService,
    RuntimePrepareService, SettingsService, SystemRouterState, VersionCheckService, system_routes,
};

const TEST_ENCRYPTION_KEY: [u8; 32] = [0x42; 32];
const ADMIN_ID: &str = "system_default_user";
const GUEST_ID: &str = "user_guest";
const MASK: &str = "********";

fn build_state(db: &aionui_db::Database) -> SystemRouterState {
    let provider_repo = Arc::new(SqliteProviderRepository::new(db.pool().clone()));
    let http_client = reqwest::Client::new();
    SystemRouterState {
        settings_service: SettingsService::new(Arc::new(SqliteSettingsRepository::new(db.pool().clone()))),
        client_pref_service: ClientPrefService::new(Arc::new(SqliteClientPreferenceRepository::new(db.pool().clone()))),
        provider_service: ProviderService::new(provider_repo.clone(), TEST_ENCRYPTION_KEY),
        model_fetch_service: ModelFetchService::new(provider_repo, TEST_ENCRYPTION_KEY, http_client.clone()),
        protocol_detection_service: ProtocolDetectionService::new(http_client.clone()),
        version_check_service: VersionCheckService::new(http_client, "0.1.0".to_owned()),
        runtime_prepare_service: RuntimePrepareService::new(Arc::new(BroadcastEventBus::new(16))),
        feedback_diagnostics_service: FeedbackDiagnosticsService::new(Arc::new(
            SqliteFeedbackDiagnosticsRepository::new(db.pool().clone()),
        )),
        user_repo: Arc::new(SqliteUserRepository::new(db.pool().clone())),
    }
}

async fn setup() -> axum::Router {
    setup_with_pool().await.0
}

/// Same as [`setup`] but also hands back the pool so tests can assert on
/// raw rows (e.g. `session_generation` bumps).
async fn setup_with_pool() -> (axum::Router, sqlx::SqlitePool) {
    let db = init_database_memory().await.unwrap();
    // `init_database_memory` already seeds `system_default_user` (username `admin`),
    // so only the second account has to be inserted here.
    sqlx::query(
        "INSERT INTO users (id, user_type, username, password_hash, status, session_generation, created_at, updated_at) \
         VALUES (?, 'local', ?, '', 'active', 0, 1, 1)",
    )
    .bind(GUEST_ID)
    .bind("guest")
    .execute(db.pool())
    .await
    .unwrap();
    (system_routes(build_state(&db)), db.pool().clone())
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn request_for_user(user_id: &str, method: &str, uri: &str, body: Option<serde_json::Value>) -> Request<Body> {
    let builder = Request::builder().method(method).uri(uri);
    let builder = match &body {
        Some(_) => builder.header("content-type", "application/json"),
        None => builder,
    };
    let body = match body {
        Some(value) => Body::from(serde_json::to_vec(&value).unwrap()),
        None => Body::empty(),
    };
    let mut req = builder.body(body).unwrap();
    req.extensions_mut().insert(CurrentUser {
        id: user_id.to_owned(),
        username: user_id.to_owned(),
        user_type: UserType::Local,
        status: UserStatus::Active,
    });
    req
}

fn sample_provider(name: &str) -> serde_json::Value {
    json!({
        "platform": "openai",
        "name": name,
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-real-secret-key-123"
    })
}

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_users_requires_admin_identity() {
    let app = setup().await;
    let resp = app
        .oneshot(request_for_user(GUEST_ID, "GET", "/api/admin/users", None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let json = body_json(resp).await;
    assert_eq!(json["code"], "FORBIDDEN");
}

#[tokio::test]
async fn admin_cannot_provision_for_others() {
    let app = setup().await;
    let resp = app
        .oneshot(request_for_user(
            GUEST_ID,
            "POST",
            "/api/admin/users/system_default_user/providers",
            Some(sample_provider("evil")),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_lists_users_with_primary_flag() {
    let app = setup().await;
    let resp = app
        .oneshot(request_for_user(ADMIN_ID, "GET", "/api/admin/users", None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    let users = json["data"].as_array().unwrap();
    assert_eq!(users.len(), 2);

    let primary = users.iter().find(|u| u["id"] == ADMIN_ID).unwrap();
    assert_eq!(primary["username"], "admin");
    assert_eq!(primary["is_primary"], true);

    let guest = users.iter().find(|u| u["id"] == GUEST_ID).unwrap();
    assert_eq!(guest["username"], "guest");
    assert_eq!(guest["is_primary"], false);

    // Secrets must never appear in the listing.
    let raw = json.to_string();
    assert!(!raw.contains("password_hash"));
    assert!(!raw.contains("jwt_secret"));
}

#[tokio::test]
async fn admin_provision_for_missing_user_is_404() {
    let app = setup().await;
    let resp = app
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users/nope/providers",
            Some(sample_provider("x")),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Provisioning + masking round-trip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_provisions_guest_provider_and_guest_sees_masked_key() {
    let app = setup().await;

    // 1. Admin provisions a provider (with the real key) for the guest.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            &format!("/api/admin/users/{GUEST_ID}/providers"),
            Some(sample_provider("Guest LLM")),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let created = body_json(resp).await;
    assert_eq!(created["data"]["api_key"], "sk-real-secret-key-123");
    let provider_id = created["data"]["id"].as_str().unwrap().to_string();

    // 2. Admin reads it back in plaintext via the admin route.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "GET",
            &format!("/api/admin/users/{GUEST_ID}/providers"),
            None,
        ))
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["data"][0]["api_key"], "sk-real-secret-key-123");

    // 3. The guest's own provider list masks the key.
    let resp = app
        .clone()
        .oneshot(request_for_user(GUEST_ID, "GET", "/api/providers", None))
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["data"].as_array().unwrap().len(), 1);
    assert_eq!(json["data"][0]["api_key"], MASK);

    // 4. Guest echoing the mask back on update must keep the stored key.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "PUT",
            &format!("/api/providers/{provider_id}"),
            Some(json!({ "enabled": false, "api_key": MASK })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "GET",
            &format!("/api/admin/users/{GUEST_ID}/providers"),
            None,
        ))
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["data"][0]["enabled"], false);
    assert_eq!(
        json["data"][0]["api_key"], "sk-real-secret-key-123",
        "echoing the masked value must not clobber the stored key"
    );

    // 5. Admin deletes the provider for the guest.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "DELETE",
            &format!("/api/admin/users/{GUEST_ID}/providers/{provider_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .oneshot(request_for_user(GUEST_ID, "GET", "/api/providers", None))
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["data"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn admin_own_provider_list_stays_plaintext() {
    let app = setup().await;
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/providers",
            Some(sample_provider("Mine")),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let resp = app
        .oneshot(request_for_user(ADMIN_ID, "GET", "/api/providers", None))
        .await
        .unwrap();
    let json = body_json(resp).await;
    assert_eq!(json["data"][0]["api_key"], "sk-real-secret-key-123");
}

#[tokio::test]
async fn guest_cannot_see_own_key_in_plaintext() {
    let app = setup().await;
    // The guest configures their own provider — still masked on read.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "POST",
            "/api/providers",
            Some(sample_provider("Self")),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    assert_eq!(body_json(resp).await["data"]["api_key"], MASK);

    let resp = app
        .oneshot(request_for_user(GUEST_ID, "GET", "/api/providers", None))
        .await
        .unwrap();
    assert_eq!(body_json(resp).await["data"][0]["api_key"], MASK);
}

// ---------------------------------------------------------------------------
// POST /api/admin/users — create a local account
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_creates_local_user_via_console() {
    let app = setup().await;
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "bob", "password": "Str0ngPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let json = body_json(resp).await;
    assert_eq!(json["data"]["username"], "bob");
    assert_eq!(json["data"]["user_type"], "local");
    assert_eq!(json["data"]["status"], "active");
    assert_eq!(json["data"]["is_primary"], false);

    // The new account shows up in the listing with no secret material.
    let resp = app
        .oneshot(request_for_user(ADMIN_ID, "GET", "/api/admin/users", None))
        .await
        .unwrap();
    let json = body_json(resp).await;
    let users = json["data"].as_array().unwrap();
    assert_eq!(users.len(), 3);
    assert!(users.iter().any(|u| u["username"] == "bob"));
    assert!(!json.to_string().contains("password_hash"));
}

#[tokio::test]
async fn admin_create_user_rejects_duplicate_weak_and_strangers() {
    let app = setup().await;

    // Only the admin may create accounts.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "bob", "password": "Str0ngPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Password rules come from the shared account service (8+ chars).
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "carol", "password": "short" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Username rules: 3+ chars, [a-zA-Z0-9_-].
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "ab", "password": "Str0ngPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // A taken username (incl. the seed `admin`) is a conflict, not a clobber.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "bob", "password": "Str0ngPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let resp = app
        .oneshot(request_for_user(
            ADMIN_ID,
            "POST",
            "/api/admin/users",
            Some(json!({ "username": "bob", "password": "OtherPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

// ---------------------------------------------------------------------------
// PUT /api/admin/users/{id}/password — reset + revoke sessions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_resets_password_and_revokes_sessions() {
    let (app, pool) = setup_with_pool().await;
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            &format!("/api/admin/users/{GUEST_ID}/password"),
            Some(json!({ "password": "FreshPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["data"]["username"], "guest");

    // The password change must bump session_generation so old logins die.
    let generation: i64 = sqlx::query_scalar("SELECT session_generation FROM users WHERE id = ?")
        .bind(GUEST_ID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(generation, 1);

    // Guards: wrong admin (403), missing user (404), weak password (400).
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "PUT",
            &format!("/api/admin/users/{ADMIN_ID}/password"),
            Some(json!({ "password": "EvilPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            "/api/admin/users/nope/password",
            Some(json!({ "password": "FreshPass!23" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let resp = app
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            &format!("/api/admin/users/{GUEST_ID}/password"),
            Some(json!({ "password": "short" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// PUT /api/admin/users/{id}/status — disable / enable
// ---------------------------------------------------------------------------

#[tokio::test]
async fn admin_disables_and_reenables_guest() {
    let app = setup().await;
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            &format!("/api/admin/users/{GUEST_ID}/status"),
            Some(json!({ "status": "disabled" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["data"]["status"], "disabled");

    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            &format!("/api/admin/users/{GUEST_ID}/status"),
            Some(json!({ "status": "active" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["data"]["status"], "active");
}

#[tokio::test]
async fn admin_cannot_disable_primary_or_let_others_manage() {
    let (app, pool) = setup_with_pool().await;

    // Lockout protection: the primary admin cannot disable itself.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            &format!("/api/admin/users/{ADMIN_ID}/status"),
            Some(json!({ "status": "disabled" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let status: String = sqlx::query_scalar("SELECT status FROM users WHERE id = ?")
        .bind(ADMIN_ID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "active");

    // Non-admins can neither disable others nor re-enable themselves.
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "PUT",
            &format!("/api/admin/users/{ADMIN_ID}/status"),
            Some(json!({ "status": "disabled" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let resp = app
        .clone()
        .oneshot(request_for_user(
            GUEST_ID,
            "PUT",
            &format!("/api/admin/users/{GUEST_ID}/status"),
            Some(json!({ "status": "active" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Unknown target → 404.
    let resp = app
        .oneshot(request_for_user(
            ADMIN_ID,
            "PUT",
            "/api/admin/users/nope/status",
            Some(json!({ "status": "disabled" })),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
