use std::{env, fs, path::Path};

fn collect_assets(root: &Path, directory: &Path, assets: &mut Vec<(String, String)>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(directory).expect("Cannot read frontend directory") {
        let entry = entry.expect("Cannot read frontend entry");
        let path = entry.path();
        let kind = entry.file_type().expect("Cannot inspect frontend entry");
        if kind.is_dir() {
            collect_assets(root, &path, assets);
        } else if kind.is_file() {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            assets.push((name, path.to_str().unwrap().to_owned()));
        } else {
            panic!("Unsupported frontend entry: {}", path.display());
        }
    }
}

fn main() {
    #[cfg(windows)]
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let icon = "../desktop/icons/icon.ico";
        println!("cargo:rerun-if-changed={icon}");
        tauri_winres::WindowsResource::new()
            .set_icon(icon)
            .set("ProductName", "RClone Manager Server")
            .set("FileDescription", "RClone Manager Server")
            .set("OriginalFilename", "rclone-manager-server.exe")
            .compile_for(&["rclone-manager-server"])
            .expect("Cannot embed Windows server icon");
    }

    if env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some() {
        return;
    }

    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../dist/rclone-manager/browser");
    println!("cargo:rerun-if-changed={}", root.display());
    assert!(
        root.join("index.html").is_file(),
        "Build the frontend with npm run build before compiling a release server"
    );
    let root = root
        .canonicalize()
        .expect("Cannot resolve frontend directory");
    let mut assets = Vec::new();
    collect_assets(&root, &root, &mut assets);
    assets.sort();
    let mut source = String::from("static ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in assets {
        source.push_str(&format!("({name:?}, include_bytes!({path:?})),\n"));
    }
    source.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("frontend.rs"),
        source,
    )
    .expect("Cannot write frontend asset index");
}
