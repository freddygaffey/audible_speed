package com.speed.player;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {
    private ExoPlayer player;
    private final Handler statusHandler = new Handler(Looper.getMainLooper());
    private Runnable statusRunnable;
    private float targetRate = 1.0f;

    @PluginMethod
    public void prepare(PluginCall call) {
        String src = call.getString("src");
        if (src == null || src.isEmpty()) {
            call.reject("Missing src");
            return;
        }
        targetRate = clampRate((float) call.getDouble("rate", 1.0));
        runOnMainThread(() -> {
            unloadInternal();
            ensurePlayer();
            player.setMediaItem(MediaItem.fromUri(Uri.parse(src)));
            player.setPlaybackParameters(new PlaybackParameters(targetRate));
            player.prepare();
            emitStatus();
            startStatusLoop();
            call.resolve(statusPayload());
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        runOnMainThread(() -> {
            if (player == null) {
                call.reject("Player not prepared");
                return;
            }
            player.setPlayWhenReady(true);
            player.setPlaybackParameters(new PlaybackParameters(targetRate));
            emitStatus();
            call.resolve(statusPayload());
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        runOnMainThread(() -> {
            if (player == null) {
                call.reject("Player not prepared");
                return;
            }
            player.setPlayWhenReady(false);
            emitStatus();
            call.resolve(statusPayload());
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        double seconds = call.getDouble("position", 0.0);
        long positionMs = Math.max(0L, (long) (seconds * 1000.0));
        runOnMainThread(() -> {
            if (player == null) {
                call.reject("Player not prepared");
                return;
            }
            player.seekTo(positionMs);
            emitStatus();
            call.resolve(statusPayload());
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        targetRate = clampRate((float) call.getDouble("rate", 1.0));
        runOnMainThread(() -> {
            if (player == null) {
                call.reject("Player not prepared");
                return;
            }
            player.setPlaybackParameters(new PlaybackParameters(targetRate));
            emitStatus();
            call.resolve(statusPayload());
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        runOnMainThread(() -> call.resolve(statusPayload()));
    }

    @PluginMethod
    public void unload(PluginCall call) {
        runOnMainThread(() -> {
            unloadInternal();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        unloadInternal();
        super.handleOnDestroy();
    }

    private void ensurePlayer() {
        if (player != null) return;
        player = new ExoPlayer.Builder(getContext()).build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) {
                    notifyListeners("ended", new JSObject());
                }
                emitStatus();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitStatus();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                JSObject payload = new JSObject();
                payload.put("message", error.getMessage() == null ? "Playback error" : error.getMessage());
                notifyListeners("error", payload);
            }
        });
    }

    private void unloadInternal() {
        stopStatusLoop();
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private void startStatusLoop() {
        stopStatusLoop();
        statusRunnable = new Runnable() {
            @Override
            public void run() {
                emitStatus();
                statusHandler.postDelayed(this, 250);
            }
        };
        statusHandler.post(statusRunnable);
    }

    private void stopStatusLoop() {
        if (statusRunnable != null) {
            statusHandler.removeCallbacks(statusRunnable);
            statusRunnable = null;
        }
    }

    private JSObject statusPayload() {
        JSObject payload = new JSObject();
        if (player == null) {
            payload.put("position", 0.0);
            payload.put("duration", 0.0);
            payload.put("playing", false);
            payload.put("buffering", false);
            return payload;
        }
        long durationMs = player.getDuration();
        if (durationMs < 0) durationMs = 0;
        long positionMs = Math.max(0L, player.getCurrentPosition());
        payload.put("position", positionMs / 1000.0);
        payload.put("duration", durationMs / 1000.0);
        payload.put("playing", player.isPlaying());
        payload.put("buffering", player.getPlaybackState() == Player.STATE_BUFFERING);
        return payload;
    }

    private void emitStatus() {
        notifyListeners("status", statusPayload());
    }

    private float clampRate(float value) {
        return Math.max(0.5f, Math.min(16.0f, value));
    }

    private void runOnMainThread(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
        } else {
            statusHandler.post(task);
        }
    }
}
