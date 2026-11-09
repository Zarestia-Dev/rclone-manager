//! Cron expression checks and next-run times shared by the scheduler, the cache and the commands.

use chrono::{Local, Utc};
use tokio_cron_scheduler::JobBuilder;

pub fn validate_enabled_cron(enabled: bool, expression: Option<&str>) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let expression = expression
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| crate::localized_error!("backendErrors.automation.cronRequired"))?;
    validate_cron_expression(expression)
}

pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    if cron_expr.split_whitespace().count() == 6 {
        return Err(crate::localized_error!(
            "backendErrors.automation.cronFieldCount"
        ));
    }
    croner::parser::CronParser::new().parse(cron_expr).map_err(
        |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
    )?;

    let cron_6_field = format!("0 {cron_expr}");
    JobBuilder::new()
        .with_cron_job_type()
        .with_schedule(&cron_6_field)
        .map_err(
            |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
        )?;

    Ok(())
}

/// Calculate the next UTC fire time for a 5-field cron expression.
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::parser::CronParser::new().parse(cron_expr).map_err(
        |e| crate::localized_error!("backendErrors.automation.invalidCron", "error" => e),
    )?;

    let next_local = cron.find_next_occurrence(&Local::now(), false).map_err(
        |e| crate::localized_error!("backendErrors.automation.executionFailed", "error" => e),
    )?;

    Ok(next_local.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    #[test]
    fn enabled_cron_requires_a_valid_expression() {
        for expression in [None, Some(""), Some("   "), Some("invalid")] {
            assert!(validate_enabled_cron(true, expression).is_err());
        }
        assert!(validate_enabled_cron(false, None).is_ok());
        assert!(validate_enabled_cron(false, Some("invalid")).is_ok());
        assert!(validate_enabled_cron(true, Some("0 2 * * *")).is_ok());
    }

    // -----------------------------------------------------------------------
    // validate_cron_expression
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_valid_expressions() {
        assert!(validate_cron_expression("* * * * *").is_ok());
        assert!(validate_cron_expression("0 9 * * 1-5").is_ok());
        assert!(validate_cron_expression("*/15 * * * *").is_ok());
        assert!(validate_cron_expression("0 0 1 * *").is_ok());
        assert!(validate_cron_expression("30 6 * * 1,3,5").is_ok());
    }

    #[test]
    fn test_validate_cron_invalid_expressions() {
        assert!(validate_cron_expression("invalid").is_err());
        // 6 fields from the user is rejected (we add the seconds field ourselves)
        assert!(validate_cron_expression("* * * * * *").is_err());
        // Minute 60 is out of range
        assert!(validate_cron_expression("60 * * * *").is_err());
        // Empty string
        assert!(validate_cron_expression("").is_err());
    }

    // -----------------------------------------------------------------------
    // get_next_run
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_next_run_is_in_the_future() {
        let now = Utc::now();
        let next = get_next_run("* * * * *").unwrap();
        assert!(next > now, "next run must be after now");
    }

    #[test]
    fn test_get_next_run_specific_date() {
        // Jan 1st midnight — local time
        let next = get_next_run("0 0 1 1 *").unwrap();
        let local = next.with_timezone(&Local);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.hour(), 0);
        assert_eq!(local.day(), 1);
        assert_eq!(local.month(), 1);
    }

    #[test]
    fn test_get_next_run_invalid_expression_returns_err() {
        assert!(get_next_run("not-valid").is_err());
        assert!(get_next_run("").is_err());
    }

    // -----------------------------------------------------------------------
    // validate_cron_expression — boundary values
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_boundary_minutes() {
        // Minute 0 and 59 are valid
        assert!(validate_cron_expression("0 * * * *").is_ok());
        assert!(validate_cron_expression("59 * * * *").is_ok());
        // Minute 60 is invalid
        assert!(validate_cron_expression("60 * * * *").is_err());
    }

    #[test]
    fn test_validate_cron_step_values() {
        assert!(validate_cron_expression("*/5 * * * *").is_ok());
        assert!(validate_cron_expression("*/30 * * * *").is_ok());
    }

    #[test]
    fn test_validate_cron_ranges() {
        assert!(validate_cron_expression("0 9-17 * * *").is_ok());
        assert!(validate_cron_expression("0 0 * * 1-5").is_ok());
    }
}
