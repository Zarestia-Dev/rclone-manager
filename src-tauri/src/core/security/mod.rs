pub mod commands;
pub mod credential_manager;
pub mod password_validation;

pub use commands::*;
pub use credential_manager::*;
pub use password_validation::*;

use std::sync::{Arc, Mutex};

/// Global password validator state for the application
pub type PasswordValidatorState = Arc<Mutex<PasswordValidator>>;

/// Initialize the password validator state for the application
pub fn init_password_validator() -> PasswordValidatorState {
    Arc::new(Mutex::new(PasswordValidator::new()))
}
