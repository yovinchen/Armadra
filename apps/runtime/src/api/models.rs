//! `/api/models/catalog` — where the prices and context windows come from,
//! and when they were read (用户实测反馈 F10).
//!
//! Two routes, both about the catalog as a whole rather than one model. The
//! settings page shows the source and the timestamp beside the cost panel, so
//! "whose prices are these?" has an answer on screen instead of in a comment.

use axum::{Json, extract::State};
use serde::Serialize;

use crate::{
    AppState,
    models::catalog::{self, Catalog, CatalogModel, CatalogSource},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDocument {
    source: CatalogSource,
    /// RFC 3339, or absent when nothing has ever been fetched.
    #[serde(skip_serializing_if = "Option::is_none")]
    fetched_at: Option<String>,
    url: String,
    /// Whole hours since `fetchedAt`, so the page can say "updated 3 hours
    /// ago" without agreeing with the Runtime about the current time.
    #[serde(skip_serializing_if = "Option::is_none")]
    age_hours: Option<i64>,
    /// Model ids this Runtime can price right now, across all three sources.
    /// Larger than `models.len()` — the built-in rows are in it too.
    priced_models: usize,
    /// Why the last refresh did not land, when one was asked for and failed.
    /// The rest of the document still describes what is in memory, because a
    /// failed fetch changes nothing about the prices already in use.
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_error: Option<String>,
    models: Vec<CatalogModel>,
}

impl CatalogDocument {
    fn of(catalog: &Catalog) -> Self {
        Self {
            source: catalog.source,
            fetched_at: catalog.fetched_at.clone(),
            url: catalog.url.clone(),
            age_hours: catalog.age().map(|age| age.num_hours()),
            priced_models: crate::usage::cost::pricing::PriceTable::load().len(),
            refresh_error: None,
            models: catalog.models.clone(),
        }
    }
}

/// `GET /api/models/catalog` — what is in memory. Never fetches.
pub async fn model_catalog(State(_): State<AppState>) -> Json<CatalogDocument> {
    Json(CatalogDocument::of(&catalog::current()))
}

/// `POST /api/models/catalog/refresh` — fetch models.dev now.
///
/// The only route that reaches the network for this, and the reason the
/// refresh lives in the Runtime at all: the page has no business talking to
/// models.dev, and a browser install could not reach it under the Runtime's
/// own CORS rules anyway.
pub async fn refresh_model_catalog(State(_): State<AppState>) -> Json<CatalogDocument> {
    let path = catalog::cache_path(&crate::paths::data_dir());
    match catalog::refresh(&path).await {
        Ok(catalog) => Json(CatalogDocument::of(&catalog)),
        // A refresh that could not reach models.dev is not a failed request:
        // the catalog already in memory still answers, and the page needs to
        // show *that* alongside the reason the update did not land. An error
        // status would replace a working document with nothing.
        Err(reason) => Json(CatalogDocument {
            refresh_error: Some(reason),
            ..CatalogDocument::of(&catalog::current())
        }),
    }
}
