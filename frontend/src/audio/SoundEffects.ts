let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

export function playJoinSound(): void {
  try {
    const audio = new Audio("/sounds/entrar.mp3");
    audio.volume = 0.55;
    void audio.play().catch(() => {});
  } catch {
    // Falha silenciosa em navegadores com restrição de autoplay
  }
}

export function playLeaveSound(): void {
  try {
    const audio = new Audio("/sounds/sair.mp3");
    audio.volume = 0.55;
    void audio.play().catch(() => {});
  } catch {
    // Falha silenciosa
  }
}

function playToneSequence(
  frequencies: number[],
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.15,
): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    gain.gain.setValueAtTime(volume, now);

    const stepTime = duration / frequencies.length;
    frequencies.forEach((freq, idx) => {
      osc.frequency.setValueAtTime(freq, now + idx * stepTime);
    });

    gain.gain.setValueAtTime(volume, now + duration * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration);
  } catch {
    // Falha silenciosa
  }
}

export function playMute(): void {
  // Tom duplo descendente suave (estilo Discord)
  playToneSequence([480, 360], 0.14, "sine", 0.16);
}

export function playUnmute(): void {
  // Tom duplo ascendente suave
  playToneSequence([360, 540], 0.14, "sine", 0.16);
}

export function playDeafen(): void {
  // Tom grave descendente
  playToneSequence([380, 240], 0.18, "triangle", 0.18);
}

export function playUndeafen(): void {
  // Tom agudo ascendente
  playToneSequence([260, 480], 0.18, "triangle", 0.18);
}

export function playStreamStart(): void {
  // Acorde triadico ascendente
  playToneSequence([440, 554, 659], 0.22, "sine", 0.15);
}

export function playStreamStop(): void {
  // Tom curto descendente
  playToneSequence([554, 440], 0.15, "sine", 0.15);
}
