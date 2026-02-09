//! i18n handlers

use axum::{extract::Query, response::Json};
use serde::Deserialize;

use crate::server::state::{ApiResponse, AppError};

#[derive(Deserialize)]
pub struct I18nQuery {
    pub lang: String,
}

pub async fn get_i18n_handler(
    Query(query): Query<I18nQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    let value = crate::utils::i18n::get_language_map(&query.lang)
        .ok_or_else(|| AppError::NotFound(format!("Translations not found for: {}", query.lang)))?;

    Ok(Json(ApiResponse::success(value)))
}
