use proc_macro::TokenStream;
use quote::quote;
use syn::{ItemFn, parse_macro_input};

/// Bridge attribute macro that attaches `#[tauri::command]` only for non-web-server targets (desktop/mobile),
/// leaving the function as an unwrapped, pure Rust function in headless/web-server mode.
#[proc_macro_attribute]
pub fn bridge(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);
    let output = quote! {
        #[cfg_attr(not(feature = "web-server"), tauri::command)]
        #input
    };
    output.into()
}
