use parking_lot::Mutex;
use tokio::sync::Notify;

const AUTO_DRIVES: u32 = ((1 << 26) - 1) & !0b111;

/// The Windows drive letter in a drive-only mount target, as its bit in GetLogicalDrives.
pub(crate) fn drive_bit(path: &str) -> Option<u32> {
    match path.trim().as_bytes() {
        [letter, b':'] | [letter, b':', b'/' | b'\\'] if letter.is_ascii_alphabetic() => {
            Some(1 << (letter.to_ascii_uppercase() - b'A'))
        }
        _ => None,
    }
}

#[derive(Default)]
pub(crate) struct DriveReservations {
    pending: Mutex<u32>,
    changed: Notify,
}

impl DriveReservations {
    pub(crate) async fn reserve(
        &self,
        requested: Option<u32>,
        fixed_profiles: u32,
        occupied: impl Fn() -> Result<u32, String>,
    ) -> Result<DriveReservation<'_>, String> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            // Register before checking pending claims, including releases before the first await.
            changed.as_mut().enable();
            {
                let mut pending = self.pending.lock();
                let occupied = occupied()?;
                let available = if let Some(bit) = requested {
                    if (occupied | *pending) & bit != 0 {
                        return Err(crate::localized_error!(
                            "backendErrors.mount.driveLetterInUse"
                        ));
                    }
                    bit
                } else {
                    AUTO_DRIVES & !(occupied | fixed_profiles)
                };
                if available == 0 {
                    return Err(crate::localized_error!(
                        "backendErrors.mount.noFreeDriveLetter"
                    ));
                }
                let available_now = available & !*pending;
                if available_now != 0 {
                    let bit = 1 << (u32::BITS - 1 - available_now.leading_zeros());
                    *pending |= bit;
                    return Ok(DriveReservation {
                        reservations: self,
                        bit,
                    });
                }
            }
            changed.await;
        }
    }
}

pub(crate) struct DriveReservation<'a> {
    reservations: &'a DriveReservations,
    bit: u32,
}

impl DriveReservation<'_> {
    pub(crate) fn letter(&self) -> String {
        let letter = b'A' + self.bit.trailing_zeros() as u8;
        format!("{}:", char::from(letter))
    }
}

impl Drop for DriveReservation<'_> {
    fn drop(&mut self) {
        *self.reservations.pending.lock() &= !self.bit;
        self.reservations.changed.notify_waiters();
    }
}

#[cfg(windows)]
pub(crate) static MOUNT_DRIVES: DriveReservations = DriveReservations {
    pending: Mutex::new(0),
    changed: Notify::const_new(),
};

#[cfg(windows)]
pub(crate) fn occupied_system_drives() -> std::io::Result<u32> {
    // SAFETY: GetLogicalDrives takes no arguments and returns a bit mask.
    let occupied = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    if occupied == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(occupied)
}

/// Drive letters already occupied by Windows or being claimed by an app mount.
#[cfg(windows)]
pub fn occupied_or_pending_drives() -> std::io::Result<u32> {
    let pending = MOUNT_DRIVES.pending.lock();
    Ok(occupied_system_drives()? | *pending)
}
