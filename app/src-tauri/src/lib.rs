#[cfg(test)]
mod command_types;
mod commands;
mod config;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager};

use commands::AppState;
use deadwax_core::location::{self, Build};

/// The menu item that opens the setup screen, and the event it sends the UI.
const CHANGE_CLIENT_ID: &str = "change-client-id";

/// What kind of build this is, for where the database lives. A development
/// build knows its checkout from where it was compiled: this crate is
/// `app/src-tauri` inside it.
fn build() -> Build {
    #[cfg(debug_assertions)]
    return Build::Development {
        checkout: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
    };
    #[cfg(not(debug_assertions))]
    Build::Release
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let database = location::database_path(&build(), &app_data);
            app.manage(AppState::new(config::path(&app_data), &database)?);

            let handle = app.handle();
            let menu = Menu::default(handle)?;
            let change = MenuItem::with_id(
                handle,
                CHANGE_CLIENT_ID,
                "Change Client ID…",
                true,
                None::<&str>,
            )?;
            menu.append(&Submenu::with_items(handle, "Spotify", true, &[&change])?)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == CHANGE_CLIENT_ID {
                let _ = app.emit(CHANGE_CLIENT_ID, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_session,
            commands::get_client_id,
            commands::set_client_id,
            commands::sign_in,
            commands::cancel_sign_in,
            commands::open_spotify_dashboard,
            commands::get_collection,
            commands::search_albums,
            commands::add_album,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
