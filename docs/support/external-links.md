# External Links & Resources

While RClone Manager handles the interface, understanding the underlying tools and cloud providers can help you get the most out of your setup.

---

## Official Rclone Resources
RClone Manager is powered by **Rclone**. For deep dives into specific flags, backend limitations, or advanced filtering, the official documentation is the best source.

* **[Official Website](https://rclone.org/)** – Documentation for every flag and provider.
* **[Rclone Forum](https://forum.rclone.org/)** – Active community for CLI-level support and scripts.
* **[Rclone GitHub Repository](https://github.com/rclone/rclone)** – Source code for the core binary.

---

## Filesystem Drivers (Mounting)
These drivers are required to mount cloud storage as local disk drives.

* **Windows:** **[WinFsp](https://winfsp.dev/)** (Windows File System Proxy)
* **macOS:** **[macFUSE](https://osxfuse.github.io/)**
* **Linux:** **[libfuse](https://github.com/libfuse/libfuse)** (Usually installed via your package manager as `fuse3`)

---

## Provider Setup Guides
Some cloud providers require complex setup steps (like creating API keys) that cannot be fully automated. These official Rclone guides are essential:

* **[Google Drive](https://rclone.org/drive/#making-your-own-client-id)** – **Highly Recommended:** How to create your own Client ID to avoid slow speeds and rate limits.
* **[OneDrive](https://rclone.org/onedrive/)** – Setting up Microsoft Graph API access.
* **[Amazon S3](https://rclone.org/s3/)** – Configuration for AWS and compatible buckets (Wasabi, MinIO, etc.).
* **[Dropbox](https://rclone.org/dropbox/)** – App key and secret setup.
* **[Oracle Cloud Object Storage](https://rclone.org/oracleobjectstorage/)** – Complex setup involving API signing keys.

---

## Community & Social

* **[RClone Manager on GitHub](https://github.com/Zarestia-Dev/rclone-manager)** – Our main repository.
* **[Reddit: r/rclone](https://www.reddit.com/r/rclone/)** – General discussion about Rclone usage.
* **[Zarestia Dev Profile](https://github.com/Zarestia-Dev)** – Other projects by our team.

---

## Related Tools

* **[Nautilus (Files)](https://apps.gnome.org/Nautilus/)** – The file manager concept used in our UI design.
* **[Tauri](https://tauri.app/)** – The framework used to build RClone Manager.