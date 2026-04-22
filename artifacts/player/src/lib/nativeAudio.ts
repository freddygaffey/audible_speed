import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeAudioStatus = {
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  engine: "none" | "avAudioEngine" | "avPlayer";
};

type NativeAudioPlugin = {
  prepare(options: { src: string; rate: number }): Promise<NativeAudioStatus>;
  play(): Promise<NativeAudioStatus>;
  pause(): Promise<NativeAudioStatus>;
  seekTo(options: { position: number }): Promise<NativeAudioStatus>;
  setRate(options: { rate: number }): Promise<NativeAudioStatus>;
  getStatus(): Promise<NativeAudioStatus>;
  unload(): Promise<void>;
  addListener(eventName: "status", listenerFunc: (status: NativeAudioStatus) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listenerFunc: (error: { message?: string }) => void): Promise<PluginListenerHandle>;
};

export const NativeAudio = registerPlugin<NativeAudioPlugin>("NativeAudio");
