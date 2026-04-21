# Audible Auth — Findings & Implementation

Source: `rmcrackan/AudibleApi` (NuGet `AudibleApi` v10.1.5.1) used by Libation.
Implementation: `artifacts/api-server/src/lib/audibleAuth.ts`

---

## Why the login URL was returning 404

Three bugs in the original implementation, found by reading the C# source:

1. **Wrong `openid.return_to` domain** — must use `audible.{tld}` not `amazon.{tld}`
   - Correct: `https://www.audible.com.au/ap/maplanding`
   - Wrong:   `https://www.amazon.com.au/ap/maplanding`

2. **Wrong `openid.assoc_handle`** — Audible now uses Android handles, not iOS
   - Correct: `amzn_audible_android_aui_au`
   - Wrong:   `amzn_audible_ios_au`

3. **Missing required URL params**
   - `openid.ns.oa2=http://www.amazon.com/ap/ext/oauth/2`
   - `openid.oa2.scope=device_auth_access`
   - `marketPlaceId=AN7EY7DTAW63G` (per locale)
   - `disableLoginPrepopulate=1`
   - `openid.oa2.client_id=device:{hex(utf8(deviceSN + "#" + deviceType))}`

---

## Auth flow (implemented)

Server-side credential submission was abandoned — Amazon blocks server-side requests to `/ap/signin` with bot detection. The flow is now entirely browser-based (PKCE):

1. **`POST /audible/auth/login`** — server generates PKCE pair + device serial, returns:
   - `loginUrl` — the Amazon `/ap/signin` URL the user opens in their browser
   - `pendingId` — opaque token to resume the session server-side
   - `frcCookie`, `mapMdCookie`, `cookieDomain` — pre-login cookies the user must set

2. **User opens loginUrl in browser** — they must first run the provided JS snippet in the browser console to set `frc` and `map-md` cookies on `amazon.{domain}`. Amazon needs these to show the login page correctly.

3. **User completes Amazon sign-in** — Amazon redirects to `https://www.audible.{tld}/ap/maplanding?openid.oa2.authorization_code=...` (shows "Looking for something?" — that's expected). The user copies this URL.

4. **`POST /audible/auth/complete-url`** — user pastes the maplanding URL. Server extracts `openid.oa2.authorization_code`, exchanges it for tokens at `https://api.amazon.{tld}/auth/O2/token`.

---

## Correct login URL parameters (from RegistrationOptions.cs)

```
openid.pape.max_auth_age         = 0
openid.identity                  = http://specs.openid.net/auth/2.0/identifier_select
accountStatusPolicy              = P1
marketPlaceId                    = {locale.marketPlaceId}
pageId                           = amzn_audible_android_aui_v2_dark_us{cc}
openid.return_to                 = https://www.audible.{topDomain}/ap/maplanding
openid.assoc_handle              = amzn_audible_android_aui_{cc}
openid.oa2.response_type         = code
openid.mode                      = checkid_setup
openid.ns.pape                   = http://specs.openid.net/extensions/pape/1.0
openid.oa2.code_challenge_method = S256
openid.ns.oa2                    = http://www.amazon.com/ap/ext/oauth/2
openid.oa2.code_challenge        = {base64url(sha256(codeVerifier))}
openid.oa2.scope                 = device_auth_access
openid.claimed_id                = http://specs.openid.net/auth/2.0/identifier_select
openid.oa2.client_id             = device:{hex(utf8(deviceSN + "#" + deviceType))}
disableLoginPrepopulate          = 1
openid.ns                        = http://specs.openid.net/auth/2.0
```

Note: `openid.pape.preferred_auth_policies=MultiFactor` must NOT be present.

---

## Device constants (Android Audible app, Resources.cs)

```
DeviceType      = A10KISP2GWF0E4
OsVersion       = google/sdk_gphone64_x86_64/emu64xa:14/UPB5.230623.003/10615560:userdebug/dev-keys
DeviceName      = ranchu/Google/sdk_gphone64_x86_64
SoftwareVersion = 130050002
AppVersion      = 2090253826
AppVersionName  = 25.38.26
AppName         = com.audible.application
MapVersion      = MAPAndroidLib-1.3.40908.0
```

Server-side API calls use:
```
User-Agent: com.audible.playersdk.player/3.96.1 (Linux;Android 14) AndroidXMedia3/1.3.0
```

---

## Marketplace IDs (Localization.cs)

| code | topDomain | marketPlaceId      | language |
|------|-----------|--------------------|----------|
| us   | com       | AF2M0KC94RCEA      | en-US    |
| uk   | co.uk     | A2I9A3Q2GNFNGQ     | en-GB    |
| au   | com.au    | AN7EY7DTAW63G      | en-AU    |
| ca   | ca        | A2CQZ5RBY40XE      | en-CA    |
| de   | de        | AN7V1F1VY261K      | de-DE    |
| fr   | fr        | A2728XDNODOQ8T     | fr-FR    |
| jp   | co.jp     | A1QAP3MOU4173J     | ja-JP    |
| it   | it        | A2N7FU2W2BU2ZC     | it-IT    |
| es   | es        | ALMIKO4SZCSAR      | es-ES    |

---

## Pre-login cookies

Must be set on `.amazon.{topDomain}` before the user navigates to the login URL. In Libation these are set by a private WebView; in our browser-based flow the user runs a JS snippet in the browser console.

### `frc` cookie

Domain: `.amazon.{topDomain}` Path: `/ap`

Algorithm (FrcEncoder.cs):
1. Build JSON payload (see below)
2. Gzip-compress UTF-8 bytes of JSON
3. Derive AES key: `PBKDF2(deviceSN, salt="AES/CBC/PKCS7Padding", 1000 iter, SHA1, 16 bytes)`
4. Generate 16 random IV bytes
5. Encrypt: `AES-128-CBC-PKCS7(key, IV, compressed)`
6. Derive HMAC key: `PBKDF2(deviceSN, salt="HmacSHA256", 1000 iter, SHA1, 16 bytes)`
7. Signature: `HMAC-SHA256(hmacKey, IV || encrypted)[0:8]`
8. Assemble: `[0x00] || sig[8] || IV[16] || encrypted`
9. Base64 encode

JSON payload:
```json
{
  "ApplicationName": "com.audible.application",
  "ApplicationVersion": "2090254511",
  "DeviceOSVersion": "google/sdk_gphone64_x86_64/emu64xa:14/UPB5.230623.003/10615560:userdebug/dev-keys",
  "DeviceName": "ranchu/Google/sdk_gphone64_x86_64",
  "ScreenWidthPixels": "1344",
  "ThirdPartyDeviceId": "{deviceSN}",
  "FirstPartyDeviceId": "{deviceSN}",
  "ScreenHeightPixels": "2769",
  "DeviceLanguage": "{locale.language}",
  "TimeZone": "{server timezone offset}",
  "Carrier": "T-Mobile",
  "IpAddress": "0.0.0.0"
}
```

### `map-md` cookie

Domain: `.amazon.{topDomain}` Path: `/ap`

Base64-encode the following JSON (compact, no whitespace):
```json
{
  "device_registration_data": {"software_version": "130050002"},
  "app_identifier": {
    "package": "com.audible.application",
    "SHA-256": null,
    "app_version": "2090253826",
    "app_version_name": "25.38.26",
    "app_sms_hash": null,
    "map_version": "MAPAndroidLib-1.3.40908.0"
  },
  "app_info": {
    "auto_pv": 0,
    "auto_pv_with_smsretriever": 1,
    "smartlock_supported": 0,
    "permission_runtime_grant": 2
  }
}
```

### `sid` cookie

Domain: `.amazon.{topDomain}` Path: `/`  Value: empty string.

---

## Token exchange

After extracting `openid.oa2.authorization_code` from the pasted maplanding URL:

```
POST https://api.amazon.{topDomain}/auth/O2/token
Content-Type: application/x-www-form-urlencoded

client_id=device:{hex(utf8(deviceSN + "#" + deviceType))}
&code={authCode}
&code_verifier={codeVerifier}
&grant_type=authorization_code
&redirect_uri=https://www.audible.{topDomain}/ap/maplanding
```

Returns `access_token`, `refresh_token`, `expires_in`.

---

## Known limitations / next steps

- The `frc`/`map-md` cookie injection relies on the user manually running a JS snippet in their browser console. A WebView (Capacitor) would let us inject these automatically without user action.
- Token refresh (`POST /auth/O2/token` with `grant_type=refresh_token`) currently omits `client_id` — may need it stored in session if refresh fails.
- `getAccountInfo` calls `https://api.amazon.com/user/profile` (US endpoint only). Should use locale-specific domain.
