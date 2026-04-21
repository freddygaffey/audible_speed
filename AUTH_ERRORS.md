# Audible Auth — Errors Encountered & Solutions

Chronological log of every error hit during auth implementation.

---

## 1. Login URL → 404 "Looking for Something?"

**Error**: Amazon returned a 404 page when the user opened the generated sign-in URL.

**Root causes** (three bugs combined):
1. `openid.return_to` used the Amazon domain (`www.amazon.com.au`) instead of the Audible domain (`www.audible.com.au`)
2. `openid.assoc_handle` used iOS format (`amzn_audible_ios_au`) when Amazon now requires Android format
3. Missing required params: `openid.ns.oa2`, `openid.oa2.scope`, `marketPlaceId`, `disableLoginPrepopulate`

**Fix**: Rewrote `initLogin()` in `audibleAuth.ts` with correct params sourced from `rmcrackan/AudibleApi` C# source (Libation).

---

## 2. Token exchange → `invalid_client` 401

**Error**:
```
Token exchange failed: 401 {"error_description":"Client authentication failed","error":"invalid_client"}
```

**Root cause**: We were POST-ing to the standard OAuth endpoint `https://api.amazon.com.au/auth/O2/token` with `grant_type=authorization_code`. Audible does NOT use this endpoint — it uses a custom device registration endpoint.

**Fix**: Switched to `POST https://api.amazon.{tld}/auth/register` with a JSON body containing `registration_data` (device info), `auth_data` (code + verifier), and `requested_token_type`. Source: mkb79/audible-api Python library.

---

## 3. Device registration → `InvalidValue` 400 (Android device type)

**Error**:
```
Token exchange failed: 400 {"response":{"error":{"code":"InvalidValue","message":"One or more provided values are invalid."}}}
```

**Root cause**: The registration body used Android device constants (`A10KISP2GWF0E4`, `com.audible.application`, etc.) which are not accepted by `/auth/register`.

**Attempted fix**: Switched `DEVICE_TYPE` to iOS (`A2CZJZGLK2JJVM`) and all `registration_data` to iOS constants (proven working via mkb79).

---

## 4. Login URL → 404 again after switching to iOS assocHandle

**Error**: Switching `openid.assoc_handle` to `amzn_audible_ios_au` caused the 404 to return.

**Root cause**: The `pageId` parameter was set to `amzn_audible_ios_au` (with country code suffix). Amazon doesn't recognise this value. The correct `pageId` for the iOS flow is `amzn_audible_ios` (no country code suffix — same for all locales).

Additionally we had `disableLoginPrepopulate=1` which mkb79 does NOT include, and were missing `forceMobileLayout=true`.

**Fix**: Updated `initLogin()` to match mkb79's exact URL param set:
- `openid.assoc_handle = amzn_audible_ios_{cc}` (country-specific, e.g. `amzn_audible_ios_au`)
- `pageId = amzn_audible_ios` (no country code — constant for all locales)
- Removed `disableLoginPrepopulate`
- Added `forceMobileLayout = true`
- Device type: `A2CZJZGLK2JJVM` (iOS, consistent across login URL client_id and registration body)

---

## 5. Device registration → `InvalidValue` 400 (iOS device type + Android assocHandle mismatch)

**Error**: Same `InvalidValue` 400 persisted after switching to iOS device type but keeping the Android assocHandle.

**Root cause**: Amazon validates that the `openid.assoc_handle` used during login is consistent with the device type in `auth_data.client_id` and `registration_data.device_type`. Mixing Android assocHandle with iOS device type causes the mismatch.

**Fix**: Use iOS assocHandle AND iOS device type throughout — both login URL and registration body must be consistent.

---

## Summary of working configuration

| Field | Value |
|-------|-------|
| `openid.assoc_handle` | `amzn_audible_ios_{cc}` |
| `pageId` | `amzn_audible_ios` (no cc suffix) |
| `openid.return_to` | `https://www.audible.{tld}/ap/maplanding` |
| `DEVICE_TYPE` | `A2CZJZGLK2JJVM` |
| Registration endpoint | `https://api.amazon.{tld}/auth/register` |
| `registration_data.device_type` | `A2CZJZGLK2JJVM` |
| `registration_data.app_name` | `Audible` |
| `registration_data.app_version` | `3.56.2` |
| `auth_data.client_domain` | `DeviceLegacy` |

Source of truth for iOS constants: mkb79/audible-api Python library.
Source of truth for URL params: mkb79/audible-api + rmcrackan/AudibleApi (Libation).
