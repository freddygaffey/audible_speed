#!/usr/bin/env python3
"""Audible OAuth (PKCE) helper using mkb79/audible (https://github.com/mkb79/Audible).

  python3 audible_auth.py login <marketplace>
    # marketplace: us, uk, de, ... (Audible country_code)
    # stdout: {"loginUrl": "...", "state": {...}}

  python3 audible_auth.py complete <maplanding_url>
    # stdin: JSON state from login
    # stdout: access/refresh + MAC DMS fields for API signing (see pythonBridge.ts)
    #     or: {"error": "..."}
"""
from __future__ import annotations

import base64
import json
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

import httpx
from audible.localization import Locale
from audible.login import create_code_verifier, create_s256_code_challenge, build_device_serial


def _expires_in_from_access_token(access_token: str) -> int | None:
    """Decode JWT `exp` without verification (Amazon bearer tokens are JWT-shaped)."""
    try:
        parts = access_token.split(".")
        if len(parts) < 2:
            return None
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
        exp = int(payload.get("exp") or 0)
        return max(0, exp - int(time.time()))
    except Exception:
        return None


def _compute_expires_in(reg: dict[str, Any]) -> int:
    """
    TTL from register()'s `expires` can be wrong: audible uses naive
    `datetime.utcnow().timestamp()` which is interpreted as *local* time, skewing
    expiry by the machine TZ offset (often forcing expiresIn ~= 1s).
    Prefer JWT exp when the library value looks broken.
    """
    expires_ts = float(reg["expires"])
    from_library = int(expires_ts - time.time())
    if from_library >= 300:
        return from_library

    from_jwt = _expires_in_from_access_token(reg["access_token"])
    if from_jwt is not None and from_jwt >= 60:
        return from_jwt

    if 60 <= from_library < 300:
        return from_library

    # Sensible fallback: Audible access tokens are typically ~60 minutes
    return 3600


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj), flush=True)


def _pem_or_str(v: Any) -> str:
    if isinstance(v, bytes):
        return v.decode("utf-8")
    return str(v)


ANDROID_DEVICE_TYPE = "A10KISP2GWF0E4"
ANDROID_DEVICE_NAME = "ranchu/Google/sdk_gphone64_x86_64"
ANDROID_DEVICE_MODEL = "sdk_gphone64_x86_64"
ANDROID_OS_VERSION = (
    "google/sdk_gphone64_x86_64/emu64xa:14/UPB5.230623.003/10615560:userdebug/dev-keys"
)
ANDROID_SOFTWARE_VERSION = "130050002"
ANDROID_APP_VERSION = "3.56.2"
ANDROID_APP_NAME = "com.audible.application"


def _build_android_client_id(serial: str) -> str:
    return f"{serial}#{ANDROID_DEVICE_TYPE}".encode("utf-8").hex()


def _build_android_oauth_url(locale: Locale, code_verifier: bytes, serial: str) -> str:
    cc = locale.country_code
    domain = locale.domain
    challenge = create_s256_code_challenge(code_verifier).decode("ascii")
    client_id_hex = _build_android_client_id(serial)

    params = {
        "openid.pape.max_auth_age": "0",
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "accountStatusPolicy": "P1",
        "marketPlaceId": locale.market_place_id,
        "pageId": f"amzn_audible_android_aui_v2_dark_us{cc}",
        "openid.return_to": f"https://www.audible.{domain}/ap/maplanding",
        "openid.assoc_handle": f"amzn_audible_android_aui_{cc}",
        "openid.oa2.response_type": "code",
        "openid.mode": "checkid_setup",
        "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
        "openid.oa2.code_challenge_method": "S256",
        "openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
        "openid.oa2.code_challenge": challenge,
        "openid.oa2.scope": "device_auth_access",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.oa2.client_id": f"device:{client_id_hex}",
        "disableLoginPrepopulate": "1",
        "openid.ns": "http://specs.openid.net/auth/2.0",
    }
    return f"https://www.amazon.{domain}/ap/signin?{urlencode(params)}"


def _register_android(
    authorization_code: str,
    code_verifier: bytes,
    domain: str,
    serial: str,
) -> Dict[str, Any]:
    body = {
        "requested_token_type": [
            "bearer",
            "mac_dms",
            "website_cookies",
            "store_authentication_cookie",
        ],
        "cookies": {
            "website_cookies": [],
            "domain": f".amazon.{domain}",
        },
        "registration_data": {
            "domain": "Device",
            "app_version": ANDROID_APP_VERSION,
            "device_serial": serial,
            "device_type": ANDROID_DEVICE_TYPE,
            # Amazon rejects a fixed emulator name if it already exists on the account (DuplicateDeviceName).
            "device_name": f"{ANDROID_DEVICE_NAME}_{serial}",
            "os_version": ANDROID_OS_VERSION,
            "software_version": ANDROID_SOFTWARE_VERSION,
            "device_model": ANDROID_DEVICE_MODEL,
            "app_name": ANDROID_APP_NAME,
        },
        "auth_data": {
            "client_id": _build_android_client_id(serial),
            "authorization_code": authorization_code,
            "code_verifier": code_verifier.decode("ascii"),
            "code_algorithm": "SHA-256",
            "client_domain": "DeviceLegacy",
        },
        "requested_extensions": ["device_info", "customer_info"],
    }

    resp = httpx.post(f"https://api.amazon.{domain}/auth/register", json=body)
    try:
        resp_json = resp.json()
    except Exception:
        raise Exception(f"auth/register HTTP {resp.status_code}: {resp.text[:500]}") from None
    if resp.status_code != 200:
        raise Exception(json.dumps(resp_json)[:800])

    success = resp_json["response"]["success"]
    tokens = success["tokens"]
    extensions = success["extensions"]

    expires_s = int(tokens["bearer"]["expires_in"])
    expires = (datetime.utcnow() + timedelta(seconds=expires_s)).timestamp()

    website_cookies = {
        cookie["Name"]: cookie["Value"].replace(r'"', r"")
        for cookie in tokens["website_cookies"]
    }

    return {
        "adp_token": tokens["mac_dms"]["adp_token"],
        "device_private_key": tokens["mac_dms"]["device_private_key"],
        "access_token": tokens["bearer"]["access_token"],
        "refresh_token": tokens["bearer"]["refresh_token"],
        "expires": expires,
        "website_cookies": website_cookies,
        "store_authentication_cookie": tokens["store_authentication_cookie"],
        "device_info": extensions["device_info"],
        "customer_info": extensions["customer_info"],
    }


def cmd_login(marketplace: str) -> None:
    try:
        locale = Locale(country_code=marketplace)
    except Exception as e:  # noqa: BLE001
        _emit({"error": str(e)})
        return
    code_verifier = create_code_verifier()
    serial = build_device_serial()
    login_url = _build_android_oauth_url(locale, code_verifier, serial)
    # register() expects bytes; serialize as ASCII for JSON state
    state = {
        "code_verifier": code_verifier.decode("ascii"),
        "serial": serial,
        "domain": locale.domain,
        "with_username": False,
    }
    _emit({"loginUrl": login_url, "state": state})


def cmd_complete(maplanding_url: str, state_raw: str) -> None:
    try:
        state = json.loads(state_raw)
    except json.JSONDecodeError as e:
        _emit({"error": f"Invalid PKCE state JSON: {e}"})
        return

    try:
        code_verifier = state["code_verifier"].encode("ascii")
        serial = state["serial"]
        domain = state["domain"]
        with_username = bool(state.get("with_username", False))
    except (KeyError, TypeError, AttributeError) as e:
        _emit({"error": f"Invalid PKCE state fields: {e}"})
        return

    try:
        parsed = urlparse(maplanding_url.strip())
        qs = parse_qs(parsed.query)
        codes = qs.get("openid.oa2.authorization_code")
        if not codes:
            _emit({"error": "No openid.oa2.authorization_code in maplanding URL"})
            return
        authorization_code = codes[0]
    except Exception as e:  # noqa: BLE001
        _emit({"error": f"Failed to parse maplanding URL: {e}"})
        return

    try:
        reg = _register_android(
            authorization_code=authorization_code,
            code_verifier=code_verifier,
            domain=domain,
            serial=serial,
        )
    except Exception as e:  # noqa: BLE001
        _emit({"error": str(e)})
        return

    ci = reg.get("customer_info") or {}
    name = ci.get("name") or ci.get("customer_name") or "Audible User"
    email = ci.get("email") or ci.get("user_email") or ""

    expires_in = max(60, _compute_expires_in(reg))

    try:
        adp_token = reg["adp_token"]
        device_private_key = reg["device_private_key"]
    except KeyError as e:
        key = e.args[0] if e.args else "?"
        _emit({"error": f"Audible register response missing field: {key!r}"})
        return

    _emit(
        {
            "accessToken": reg["access_token"],
            "refreshToken": reg["refresh_token"],
            "expiresIn": expires_in,
            "username": name,
            "email": email,
            "adpToken": _pem_or_str(adp_token),
            "devicePrivateKey": _pem_or_str(device_private_key),
        }
    )


def main() -> None:
    if len(sys.argv) < 2:
        _emit({"error": "Usage: audible_auth.py login <marketplace> | complete <url>"})
        sys.exit(2)

    sub = sys.argv[1]
    if sub == "login":
        if len(sys.argv) < 3:
            _emit({"error": "Missing marketplace (e.g. us)"})
            sys.exit(2)
        cmd_login(sys.argv[2])
    elif sub == "complete":
        if len(sys.argv) < 3:
            _emit({"error": "Missing maplanding URL"})
            sys.exit(2)
        stdin_data = sys.stdin.read()
        cmd_complete(sys.argv[2], stdin_data)
    else:
        _emit({"error": f"Unknown subcommand: {sub}"})
        sys.exit(2)


if __name__ == "__main__":
    main()
