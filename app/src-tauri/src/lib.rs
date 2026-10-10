#[cfg(test)]
mod command_types;
mod commands;
mod config;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager};

use commands::AppState;
use deadwax_core::collection::Collection;
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

/// Opens this build's collection. A development build's mirrors every add
/// and remove to the dev list, shared by every checkout.
fn open_collection(app_data: &std::path::Path) -> Result<Collection, String> {
    let database = location::database_path(&build(), app_data);
    let collection = Collection::open(&database).map_err(|e| {
        format!(
            "Couldn't open the collection at {}: {e}",
            database.display()
        )
    })?;
    #[cfg(debug_assertions)]
    let collection = {
        use deadwax_core::dev_list::{self, DevList};
        collection.with_dev_list(DevList::new(dev_list::path(app_data)))
    };
    Ok(collection)
}

/// The Develop menu, in development builds only. Its items tell the UI,
/// which does the work so it can show progress and errors.
#[cfg(debug_assertions)]
fn develop_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Submenu<R>> {
    use commands::dev::{RESET_COLLECTION, RESTORE_FROM_DEV_LIST};
    let reset = MenuItem::with_id(
        handle,
        RESET_COLLECTION,
        "Reset collection",
        true,
        None::<&str>,
    )?;
    let restore = MenuItem::with_id(
        handle,
        RESTORE_FROM_DEV_LIST,
        "Restore from dev list",
        true,
        None::<&str>,
    )?;
    Submenu::with_items(handle, "Develop", true, &[&reset, &restore])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let collection = open_collection(&app_data)?;
            app.manage(AppState::new(config::path(&app_data), collection)?);

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
            #[cfg(debug_assertions)]
            menu.append(&develop_menu(handle)?)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            #[cfg(debug_assertions)]
            let forwarded = [
                CHANGE_CLIENT_ID,
                commands::dev::RESET_COLLECTION,
                commands::dev::RESTORE_FROM_DEV_LIST,
            ];
            #[cfg(not(debug_assertions))]
            let forwarded = [CHANGE_CLIENT_ID];
            if forwarded.contains(&id) {
                let _ = app.emit(id, ());
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
            #[cfg(debug_assertions)]
            commands::dev::dev_list_missing,
            #[cfg(debug_assertions)]
            commands::dev::reset_collection,
            #[cfg(debug_assertions)]
            commands::dev::restore_from_dev_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
