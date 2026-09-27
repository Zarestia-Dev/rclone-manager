use crate::utils::context::Manager;
use crate::{core, utils};
use clap::Parser;

pub fn run() {
    let cli_args = core::cli::CliArgs::parse();
    if let Err(error) = cli_args.validate() {
        eprintln!("Invalid CLI arguments: {error}");
        std::process::exit(1);
    }
    let app = utils::context::AppHandle::default();
    app.manage(cli_args.clone());
    if let Err(error) = super::setup::setup_context(&app, cli_args) {
        eprintln!("Failed to initialize application: {error}");
        std::process::exit(1);
    }
    let code = utils::block_on(app.wait_for_exit());
    std::process::exit(code);
}
