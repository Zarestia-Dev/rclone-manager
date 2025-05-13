use log::LevelFilter;
use log::SetLoggerError;
use std::sync::atomic::{AtomicUsize, Ordering};

static LOG_LEVEL: AtomicUsize = AtomicUsize::new(LevelFilter::Info as usize);

struct DynamicLogger;

impl log::Log for DynamicLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= current_log_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            println!(
                "[{} [{}] {}]: {}",
                chrono::Local::now().format("%Y/%m/%d %H:%M:%S"),
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn current_log_level() -> LevelFilter {
    match LOG_LEVEL.load(Ordering::Relaxed) {
        x if x == LevelFilter::Off as usize => LevelFilter::Off,
        x if x == LevelFilter::Error as usize => LevelFilter::Error,
        x if x == LevelFilter::Warn as usize => LevelFilter::Warn,
        x if x == LevelFilter::Info as usize => LevelFilter::Info,
        x if x == LevelFilter::Debug as usize => LevelFilter::Debug,
        x if x == LevelFilter::Trace as usize => LevelFilter::Trace,
        _ => LevelFilter::Info,
    }
}

pub fn init_logging(enable_debug: bool) -> Result<(), SetLoggerError> {
    //Init only once
    let level = if enable_debug {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    LOG_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(level);
    log::set_logger(&DynamicLogger)?;
    Ok(())
}

pub fn update_log_level(enable_debug: bool) {
    let level = if enable_debug {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    LOG_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(level);
}
