export class MicrophoneProcessor {
  private ctx: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode;
  private limiterNode: DynamicsCompressorNode;
  private analyserNode: AnalyserNode;
  private destinationNode: MediaStreamAudioDestinationNode;
  private keepAliveGainNode: GainNode;
  private currentStream: MediaStream | null = null;
  private dataArray: Uint8Array<ArrayBuffer>;

  constructor() {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new AudioContextClass();

    // 1. Gain Node (0% a 200% com curva perceptual quadrática)
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);

    // 2. DynamicsCompressorNode configurado como Brickwall Limiter suave (-3dB)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.setValueAtTime(-3, this.ctx.currentTime);
    this.limiterNode.knee.setValueAtTime(6, this.ctx.currentTime);
    this.limiterNode.ratio.setValueAtTime(20, this.ctx.currentTime);
    this.limiterNode.attack.setValueAtTime(0.003, this.ctx.currentTime);
    this.limiterNode.release.setValueAtTime(0.15, this.ctx.currentTime);

    // 3. AnalyserNode para monitoramento em tempo real do VU Meter
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.5;
    this.dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    // 4. DestinationNode que fornece a track processada para transmissão
    this.destinationNode = this.ctx.createMediaStreamDestination();

    // 5. Nó silencioso conectado ao destination principal para manter o clock
    // do Web Audio ativo no Safari/WebKit e Firefox
    this.keepAliveGainNode = this.ctx.createGain();
    this.keepAliveGainNode.gain.setValueAtTime(0, this.ctx.currentTime);

    // Conexões da pipeline de áudio
    this.gainNode.connect(this.limiterNode);
    this.limiterNode.connect(this.analyserNode);
    this.analyserNode.connect(this.destinationNode);
    this.analyserNode.connect(this.keepAliveGainNode);
    this.keepAliveGainNode.connect(this.ctx.destination);

    // No Safari, o getUserMedia pode colocar o AudioContext em estado "interrupted" ou "suspended"
    this.ctx.onstatechange = () => {
      const state = this.ctx.state as string;
      if (state === "suspended" || state === "interrupted") {
        void this.ctx.resume().catch(() => {});
      }
    };
  }

  public resume(): void {
    const state = this.ctx.state as string;
    if (state !== "running" && state !== "closed") {
      void this.ctx.resume().catch(() => {});
    }
  }

  public async setSourceStream(stream: MediaStream): Promise<MediaStreamTrack> {
    if ((this.ctx.state as string) !== "running") {
      await this.ctx.resume().catch(() => {});
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }

    this.currentStream = stream;
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.gainNode);

    const processedTrack = this.destinationNode.stream.getAudioTracks()[0];
    processedTrack.enabled = true;
    return processedTrack;
  }

  public setGainPercent(percent: number): void {
    const clamped = Math.max(0, Math.min(200, percent));
    // Curva perceptual quadrática: 50% = 0.25x, 100% = 1.0x, 200% = 4.0x
    const gainValue = Math.pow(clamped / 100, 2);
    this.gainNode.gain.setTargetAtTime(gainValue, this.ctx.currentTime, 0.015);
  }

  public getAudioLevel(): { percent: number; db: number; isClipping: boolean } {
    this.analyserNode.getByteFrequencyData(this.dataArray);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const val = this.dataArray[i];
      sum += val * val;
      if (val > max) max = val;
    }

    const rms = Math.sqrt(sum / this.dataArray.length);
    const normalized = Math.min(100, Math.round((rms / 255) * 100 * 2.2));

    // Decibéis aproximados (-60dB a 0dB)
    const db = rms > 0 ? 20 * Math.log10(rms / 255) : -60;
    const isClipping = max >= 250;

    return {
      percent: normalized,
      db: Math.max(-60, Math.round(db)),
      isClipping,
    };
  }

  public getProcessedTrack(): MediaStreamTrack | null {
    const tracks = this.destinationNode.stream.getAudioTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  public cleanup(): void {
    this.ctx.onstatechange = null;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((track) => track.stop());
      this.currentStream = null;
    }
    if ((this.ctx.state as string) !== "closed") {
      void this.ctx.close().catch(() => {});
    }
  }
}
