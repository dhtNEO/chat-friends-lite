import { updateAudioPreference, type AudioPreference } from "../api";

interface TrackNodeGroup {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  stream: MediaStream;
  audioEl: HTMLAudioElement;
}

export class AudioEngine {
  private ctx: AudioContext;
  private masterGain: GainNode;
  private deafened = false;
  private trackNodes = new Map<string, TrackNodeGroup>();
  private userPreferences = new Map<string, number>(); // key: `${username}:${streamType}` -> volume (0..200)
  private debounceTimers = new Map<string, number>();

  constructor() {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new AudioContextClass();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);
  }

  public initPreferences(prefs: AudioPreference[]): void {
    prefs.forEach((p) => {
      const key = `${p.target_username.toLowerCase()}:${p.stream_type}`;
      this.userPreferences.set(key, p.volume);
    });
  }

  public getVolume(username: string, streamType: "voice" | "screen"): number {
    const key = `${username.toLowerCase()}:${streamType}`;
    const stored = this.userPreferences.get(key);
    if (stored !== undefined) return stored;
    return 100; // default 100%
  }

  public setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.resumeContext();
    this.masterGain.gain.setTargetAtTime(
      deafened ? 0 : 1,
      this.ctx.currentTime,
      0.015,
    );
  }

  public isDeafened(): boolean {
    return this.deafened;
  }

  public attachRemoteTrack(
    track: MediaStreamTrack,
    username: string,
    streamType: "voice" | "screen",
  ): void {
    this.resumeContext();

    const trackKey = `${username.toLowerCase()}:${streamType}:${track.id}`;

    // Remove nó anterior se já existia para este track
    if (this.trackNodes.has(trackKey)) {
      this.detachTrack(trackKey);
    }

    const stream = new MediaStream([track]);

    // Workaround obrigatório para Chromium (Chrome/Edge/Brave):
    // Uma MediaStreamTrack remota do WebRTC precisa estar anexada a um HTMLAudioElement
    // em reprodução (mesmo mutado) para que o navegador puxe e decodifique os pacotes RTP
    // para o Web Audio API (createMediaStreamSource).
    const audioEl = document.createElement("audio");
    audioEl.srcObject = stream;
    audioEl.muted = true;
    audioEl.volume = 0;
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "true");
    void audioEl.play().catch(() => {});

    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();

    const volumePercent = this.getVolume(username, streamType);
    const gainVal = this.calculateGain(volumePercent);
    gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);

    source.connect(gain);
    gain.connect(this.masterGain);

    this.trackNodes.set(trackKey, { source, gain, stream, audioEl });

    track.addEventListener("ended", () => {
      this.detachTrack(trackKey);
    });
  }

  public detachRemoteTrack(
    track: MediaStreamTrack,
    username: string,
    streamType: "voice" | "screen",
  ): void {
    const trackKey = `${username.toLowerCase()}:${streamType}:${track.id}`;
    this.detachTrack(trackKey);
  }

  public detachTrack(trackKey: string): void {
    const group = this.trackNodes.get(trackKey);
    if (group) {
      try {
        group.source.disconnect();
        group.gain.disconnect();
      } catch {
        // Ignora erro se já desconectado
      }
      group.audioEl.pause();
      group.audioEl.srcObject = null;
      this.trackNodes.delete(trackKey);
    }
  }

  public setVolume(
    username: string,
    streamType: "voice" | "screen",
    sliderValue: number,
  ): void {
    const clamped =
      streamType === "screen"
        ? Math.max(0, Math.min(100, sliderValue))
        : Math.max(0, Math.min(200, sliderValue));

    const key = `${username.toLowerCase()}:${streamType}`;
    this.userPreferences.set(key, clamped);

    // Aplica o ganho nos nós ativos deste usuário/streamType
    const gainVal = this.calculateGain(clamped);
    for (const [tKey, group] of this.trackNodes.entries()) {
      if (tKey.startsWith(`${key}:`)) {
        group.gain.gain.setTargetAtTime(gainVal, this.ctx.currentTime, 0.015);
      }
    }

    // Debounce de 600ms para salvar no banco SQLite via API
    const timer = this.debounceTimers.get(key);
    if (timer) clearTimeout(timer);

    this.debounceTimers.set(
      key,
      window.setTimeout(() => {
        void updateAudioPreference(username, streamType, clamped).catch(() => {});
        this.debounceTimers.delete(key);
      }, 600),
    );
  }

  private calculateGain(sliderValue: number): number {
    // Curva perceptual quadrática: 50% = 0.25x, 100% = 1.0x, 200% = 4.0x
    return Math.pow(sliderValue / 100, 2);
  }

  public resumeContext(): void {
    if ((this.ctx.state as string) !== "running" && (this.ctx.state as string) !== "closed") {
      void this.ctx.resume().catch(() => {});
    }
  }

  public cleanup(): void {
    for (const [key] of this.trackNodes) {
      this.detachTrack(key);
    }
    if ((this.ctx.state as string) !== "closed") {
      void this.ctx.close().catch(() => {});
    }
  }
}

export const audioEngine = new AudioEngine();
