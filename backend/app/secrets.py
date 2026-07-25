"""gitEssay backend — LLM API key storage.

The API key is stored in the OS keychain when one is available (macOS
Keychain, Windows Credential Manager, Linux Secret Service / KWallet via the
`keyring` library, which auto-selects the platform backend). On headless
systems where no keychain backend exists (Docker containers, minimal Linux
servers without dbus/gnome-keyring) it degrades to the legacy SQLite column
and logs a warning — functionality is preserved cross-platform, at the DB
file's own protection level.

Set GITESSAY_DISABLE_KEYRING=1 to force the DB fallback (used by tests so
they never touch the developer's real keychain).
"""
import logging
import os

log = logging.getLogger(__name__)

_SERVICE = "gitEssay"
_USERNAME = "llm-api-key"

_keyring = None
_checked = False


def _backend():
    """Return the keyring module if a real OS keychain backend is usable,
    else None. Resolved once per process (backend availability doesn't change
    at runtime)."""
    global _keyring, _checked
    if _checked:
        return _keyring
    _checked = True
    if os.environ.get("GITESSAY_DISABLE_KEYRING", "").lower() in ("1", "true", "yes"):
        log.info("keychain disabled via GITESSAY_DISABLE_KEYRING — API key stored in DB")
        return None
    try:
        import keyring
        from keyring.backends import fail

        backend = keyring.get_keyring()
        if isinstance(backend, fail.Keyring):
            raise RuntimeError(f"no viable keychain backend ({backend!r})")
        _keyring = keyring
        log.info("OS keychain available (%s) — API key stored there", type(backend).__name__)
    except Exception as e:  # noqa: BLE001 — headless/docker: no dbus, no keychain
        log.warning(
            "OS keychain unavailable (%s) — API key will be stored in the SQLite DB",
            e,
        )
        _keyring = None
    return _keyring


def get_api_key(legacy: str = "") -> str:
    """Resolve the effective API key: the keychain value wins; `legacy` (the
    DB column) is the fallback for pre-migration rows and keychain-less
    environments."""
    kr = _backend()
    if kr is not None:
        try:
            value = kr.get_password(_SERVICE, _USERNAME)
            if value:
                return value
        except Exception:  # noqa: BLE001 — keychain hiccup must not break the app
            log.warning("keychain read failed — falling back to DB value", exc_info=True)
    return legacy or ""


def set_api_key(value: str) -> str:
    """Store `value` in the OS keychain when available. Returns what the
    caller should persist in the DB column: "" when the keychain holds the
    key, otherwise the value itself (fallback storage)."""
    value = value or ""
    kr = _backend()
    if kr is not None:
        try:
            if value:
                kr.set_password(_SERVICE, _USERNAME, value)
            else:
                try:
                    kr.delete_password(_SERVICE, _USERNAME)
                except kr.errors.PasswordDeleteError:
                    pass  # nothing stored — clearing an unset key is a no-op
            return ""
        except Exception:  # noqa: BLE001
            log.warning("keychain write failed — storing key in DB instead", exc_info=True)
    return value
