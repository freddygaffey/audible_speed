import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { useAuth } from "../lib/authContext";
import { setActivationBytes as apiSetActivationBytes } from "../lib/apiClient";
import {
  saveActivationBytes,
  loadActivationBytes,
  clearActivationBytes,
  isValidActivationBytes,
} from "../lib/activationBytes";
import { isNative, SPEED_API_ORIGIN } from "../lib/platformConfig";
import { clearAllVaults, formatVaultBytes, getVaultTotalBytes } from "../lib/audioVault";
import { useMobilePreview } from "../lib/mobilePreviewContext";

export default function Settings() {
  const { session, signOut } = useAuth();
  const { mobilePreview, setMobilePreview } = useMobilePreview();
  const [, navigate] = useLocation();
  const [bytes, setBytes] = useState(() => loadActivationBytes() ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [vaultBytes, setVaultBytes] = useState(0);
  const [vaultBusy, setVaultBusy] = useState(false);

  const refreshVaultSize = useCallback(async () => {
    if (!isNative()) return;
    setVaultBusy(true);
    try {
      setVaultBytes(await getVaultTotalBytes());
    } finally {
      setVaultBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshVaultSize();
  }, [refreshVaultSize, session?.username, session?.marketplace]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const trimmed = bytes.trim();
    if (!isValidActivationBytes(trimmed)) {
      setErrorMsg("Must be exactly 8 hexadecimal characters (e.g. 1a2b3c4d).");
      return;
    }
    setStatus("saving");
    setErrorMsg("");
    try {
      await apiSetActivationBytes(trimmed);
      saveActivationBytes(trimmed);
      setStatus("saved");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
      setStatus("error");
    }
  }

  function handleClear() {
    clearActivationBytes();
    setBytes("");
    setStatus("idle");
  }

  async function handleClearOfflineVault() {
    if (!isNative()) return;
    setVaultBusy(true);
    try {
      await clearAllVaults();
      setVaultBytes(0);
    } finally {
      setVaultBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto max-w-sm space-y-8">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/library")}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-400 touch-manipulation transition duration-150 hover:bg-gray-800 hover:text-white active:scale-95"
            aria-label="Back to library"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-bold text-white">Settings</h1>
        </div>

        {!isNative() && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">Mobile layout preview</p>
                <p className="mt-1 text-xs text-gray-500">
                  Pins the app to about phone width (~390px) so you can check library and player on a narrow column
                  (including offline). The choice is saved on this device.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={mobilePreview}
                onClick={() => setMobilePreview(!mobilePreview)}
                className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full touch-manipulation transition-colors active:opacity-90 ${
                  mobilePreview ? "bg-orange-500" : "bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-1 left-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                    mobilePreview ? "translate-x-6" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>
        )}

        {session && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-1">
            <p className="text-sm text-white font-medium">{session.username}</p>
            <p className="text-xs text-gray-400">{session.email}</p>
            <p className="text-xs text-gray-500">{session.marketplace.toUpperCase()}</p>
            <button
              type="button"
              onClick={signOut}
              className="mt-3 min-h-10 rounded-lg px-2 py-2 text-left text-xs text-red-400 touch-manipulation hover:bg-gray-800/50 hover:text-red-300 active:bg-gray-800/70"
            >
              Sign out
            </button>
          </div>
        )}

        {isNative() && (
          <div className="space-y-3">
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
              <p className="text-sm font-medium text-white">Offline audio vault</p>
              <p className="text-xs text-gray-500">
                Finished downloads are copied here so you can play without re-downloading from the server.
              </p>
              <p className="text-xs text-gray-400">
                {vaultBusy ? "…" : `Using about ${formatVaultBytes(vaultBytes)} on this device.`}
              </p>
              <button
                type="button"
                disabled={vaultBusy || vaultBytes === 0}
                onClick={() => void handleClearOfflineVault()}
                className="min-h-11 w-full touch-manipulation rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-300 transition-colors hover:border-gray-500 active:bg-gray-800 disabled:opacity-40"
              >
                Clear offline audio
              </button>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5 text-xs text-gray-400">
              API server:{" "}
              <span className="break-all font-mono text-gray-300">{SPEED_API_ORIGIN}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Activation bytes
            </label>
            <p className="mb-3 text-xs text-gray-500">
              8-character hex string used to decrypt .aax files. Leave blank if you only use Speed downloads: the
              server can take the key from your Audible license on the first DRM download and save it here. You can
              still paste bytes from <code className="text-gray-400">audible-activator</code> or{" "}
              <code className="text-gray-400">AAXClean</code> to override.
            </p>
            <input
              type="text"
              value={bytes}
              onChange={(e) => { setBytes(e.target.value); setStatus("idle"); }}
              placeholder="1a2b3c4d"
              maxLength={8}
              className="min-h-11 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 font-mono text-base text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none sm:text-sm"
            />
          </div>
          {errorMsg && <p className="text-sm text-red-400">{errorMsg}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={status === "saving"}
              className="flex min-h-11 flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 font-medium text-white transition-colors hover:bg-orange-600 active:bg-orange-700 disabled:opacity-50"
            >
              {status === "saving" && <Loader2 className="h-4 w-4 animate-spin" />}
              {status === "saved" && <Check className="h-4 w-4" />}
              {status === "saved" ? "Saved" : "Save"}
            </button>
            {bytes && (
              <button
                type="button"
                onClick={handleClear}
                className="min-h-11 touch-manipulation rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-400 transition-colors hover:border-gray-500 active:bg-gray-800"
              >
                Clear
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
