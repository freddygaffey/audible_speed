#!/usr/bin/env python3
# pylint: disable=import-error,broad-exception-caught
from __future__ import annotations

import base64
import binascii
import json
import sys
from datetime import datetime
from typing import Any

import httpx
from Crypto.Hash import SHA256
from Crypto.PublicKey import RSA
from Crypto.Signature import pkcs1_15
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

MARKETPLACE_DOMAIN = {
    "us": "api.audible.com",
    "uk": "api.audible.co.uk",
    "de": "api.audible.de",
    "fr": "api.audible.fr",
    "ca": "api.audible.ca",
    "au": "api.audible.com.au",
    "jp": "api.audible.co.jp",
    "it": "api.audible.it",
    "es": "api.audible.es",
}

API_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0"


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj), flush=True)


def _utc_adp_timestamp() -> str:
    now = datetime.utcnow()
    if now.microsecond == 0:
        return now.strftime("%Y-%m-%dT%H:%M:%SZ")
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond:06d}Z"


def _parse_private_key(raw: str) -> RSA.RsaKey:
    s = raw.strip()
    if "BEGIN " in s:
        return RSA.import_key(s)
    try:
        der = base64.b64decode(s)
        return RSA.import_key(der)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Invalid private key material: {e}") from e


def _adp_signature(
    method: str,
    path_with_query: str,
    body_utf8: str,
    adp_token: str,
    private_key_raw: str,
) -> str:
    date = _utc_adp_timestamp()
    canonical = f"{method}\n{path_with_query}\n{date}\n{body_utf8}\n{adp_token}"
    digest = SHA256.new(canonical.encode("utf-8"))
    sig = pkcs1_15.new(_parse_private_key(private_key_raw)).sign(digest)
    return f"{base64.b64encode(sig).decode('ascii')}:{date}"


def _request_widevine_license(
    asin: str,
    marketplace: str,
    access_token: str,
    adp_token: str,
    private_key_raw: str,
    license_challenge_b64: str,
) -> tuple[str, str | None]:
    domain = MARKETPLACE_DOMAIN.get(marketplace, MARKETPLACE_DOMAIN["us"])
    path = f"/1.0/content/{asin}/drmlicense"
    body_obj = {
        "consumption_type": "Download",
        "drm_type": "Widevine",
        "tenant_id": "Audible",
        "licenseChallenge": license_challenge_b64,
    }
    body_utf8 = json.dumps(body_obj, separators=(",", ":"))
    sig_with_date = _adp_signature("POST", path, body_utf8, adp_token, private_key_raw)
    headers = {
        "Accept": "application/json",
        "Accept-Charset": "utf-8",
        "User-Agent": API_UA,
        "Authorization": f"Bearer {access_token}",
        "client-id": "0",
        "Content-Type": "application/json",
        "x-adp-token": adp_token,
        "x-adp-alg": "SHA256withRSA:1.0",
        "x-adp-signature": sig_with_date,
    }
    with httpx.Client(timeout=30) as client:
        resp = client.post(f"https://{domain}{path}", headers=headers, content=body_utf8)
        cookie_header = "; ".join([f"{k}={v}" for k, v in client.cookies.items()]) or None
    if resp.status_code != 200:
        raise ValueError(f"Widevine drmlicense failed: HTTP {resp.status_code} {resp.text[:500]}")
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("Widevine drmlicense response is not a JSON object")
    if "message" in data and data.get("message"):
        raise ValueError(f"Widevine drmlicense message: {data.get('message')} reason={data.get('reason')}")
    license_b64 = data.get("license")
    if not isinstance(license_b64, str) or len(license_b64) == 0:
        raise ValueError("Widevine drmlicense response missing 'license'")
    return license_b64, cookie_header


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        _emit({"error": "Missing JSON input"})
        sys.exit(2)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        _emit({"error": f"Invalid JSON input: {e}"})
        sys.exit(2)

    try:
        asin = str(payload["asin"])
        marketplace = str(payload["marketplace"])
        access_token = str(payload["accessToken"])
        adp_token = str(payload["adpToken"])
        private_key = str(payload["devicePrivateKey"])
        pssh_b64 = str(payload["psshBase64"])
        cdm_blob_b64 = str(payload["cdmBlobBase64"])
    except KeyError as e:
        _emit({"error": f"Missing field: {e.args[0]}"})
        sys.exit(2)

    try:
        cdm_blob = base64.b64decode(cdm_blob_b64)
        device = Device.loads(cdm_blob)
        cdm = Cdm.from_device(device)
        session_id = cdm.open()
        try:
            challenge = cdm.get_license_challenge(session_id, PSSH(pssh_b64), license_type="OFFLINE")
            license_b64, cookie_header = _request_widevine_license(
                asin=asin,
                marketplace=marketplace,
                access_token=access_token,
                adp_token=adp_token,
                private_key_raw=private_key,
                license_challenge_b64=base64.b64encode(challenge).decode("ascii"),
            )
            cdm.parse_license(session_id, license_b64)
            keys = []
            for k in cdm.get_keys(session_id):
                if k.type not in ("CONTENT", "OEM_CONTENT"):
                    continue
                keys.append(
                    {
                        "kid": k.kid.hex,
                        "keyHex": k.key.hex(),
                    }
                )
            if not keys:
                raise ValueError("No content keys returned from parsed Widevine license")
            _emit({"keys": keys, "cookieHeader": cookie_header})
        finally:
            cdm.close(session_id)
    except Exception as e:  # noqa: BLE001
        _emit({"error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
