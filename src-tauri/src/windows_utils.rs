//! Windows-specific utilities: native error dialogs and WebView2 detection.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDOK, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_OKCANCEL,
};

/// Encode a Rust string as a null-terminated UTF-16 vector for Win32 APIs.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Show a native Windows MessageBox with an error icon.
pub fn show_error_dialog(title: &str, message: &str) {
    let wide_title = to_wide(title);
    let wide_msg = to_wide(message);
    unsafe {
        MessageBoxW(
            0 as HWND,
            wide_msg.as_ptr(),
            wide_title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// Show a native Windows MessageBox with a warning icon and OK/Cancel buttons.
/// Returns `true` if the user clicked OK.
pub fn show_warning_ok_cancel(title: &str, message: &str) -> bool {
    let wide_title = to_wide(title);
    let wide_msg = to_wide(message);
    let result = unsafe {
        MessageBoxW(
            0 as HWND,
            wide_msg.as_ptr(),
            wide_title.as_ptr(),
            MB_OKCANCEL | MB_ICONWARNING,
        )
    };
    result == IDOK
}

/// Check whether the WebView2 Runtime is installed by querying the registry.
///
/// Checks both per-machine and per-user install locations. Returns `true` if
/// a version string (the `pv` value) is found and is not empty, meaning at
/// least one WebView2 distribution is present.
pub fn is_webview2_installed() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const WEBVIEW2_GUID: &str = "{F3017226-FE2A-4295-8BEE-154267D3BAFE}";

    let sub_keys: &[(HKEY, &str)] = &[
        (
            HKEY_LOCAL_MACHINE,
            &format!(
                "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{}",
                WEBVIEW2_GUID
            ),
        ),
        (
            HKEY_LOCAL_MACHINE,
            &format!(
                "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{}",
                WEBVIEW2_GUID
            ),
        ),
        (
            HKEY_CURRENT_USER,
            &format!(
                "Software\\Microsoft\\EdgeUpdate\\Clients\\{}",
                WEBVIEW2_GUID
            ),
        ),
    ];

    for (root, sub_key) in sub_keys {
        if read_registry_string(*root, sub_key, "pv")
            .map(|v| !v.is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// Read a REG_SZ value from the Windows registry. Returns `None` on any failure.
fn read_registry_string(
    root: windows_sys::Win32::System::Registry::HKEY,
    sub_key: &str,
    value_name: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::*;

    let wide_sub_key = to_wide(sub_key);
    let wide_value = to_wide(value_name);

    let mut hkey: HKEY = std::ptr::null_mut();
    let status =
        unsafe { RegOpenKeyExW(root, wide_sub_key.as_ptr(), 0, KEY_READ, &mut hkey) };
    if status != 0 {
        return None;
    }

    let mut buf = [0u16; 256];
    let mut buf_len = (buf.len() * 2) as u32;
    let mut reg_type: u32 = 0;

    let status = unsafe {
        RegQueryValueExW(
            hkey,
            wide_value.as_ptr(),
            std::ptr::null(),
            &mut reg_type,
            buf.as_mut_ptr() as *mut u8,
            &mut buf_len,
        )
    };

    unsafe { RegCloseKey(hkey) };

    if status != 0 || reg_type != REG_SZ {
        return None;
    }

    let char_count = (buf_len as usize) / 2;
    let s = String::from_utf16_lossy(
        &buf[..char_count]
            .iter()
            .copied()
            .take_while(|&c| c != 0)
            .collect::<Vec<u16>>(),
    );
    Some(s)
}
