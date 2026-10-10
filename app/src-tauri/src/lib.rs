#[cfg(test)]
mod command_types;
mod commands;
mod config;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager};

use commands::AppState;

/// The menu item that opens the setup screen, and the event it sends the UI.
const CHANGE_CLIENT_ID: &str = "change-client-id";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_path = config::path(&app.path().app_data_dir()?);
            app.manage(AppState::new(config_path)?);

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
            commands::open_spotify_dashboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
