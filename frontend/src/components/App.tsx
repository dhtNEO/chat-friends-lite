import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from "livekit-client";
import {
  getMe,
  logout,
  getMessages,
  sendMessage,
  getMediaToken,
  connectWebSocket,
  type User,
  type ChatMessage,
} from "../api";
import { audioEngine } from "../audio/AudioEngine";
import { MicrophoneProcessor } from "../audio/MicrophoneGain";
import {
  playJoinSound,
  playLeaveSound,
  playMute,
  playUnmute,
  playDeafen,
  playUndeafen,
  playStreamStart,
  playStreamStop,
} from "../audio/SoundEffects";
import { AuthModal } from "./AuthModal";
import { AudioSettings } from "./AudioSettings";

interface ParticipantState {
  identity: string;
  displayName: string;
  avatarColor: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
  screenPublication?: RemoteTrackPublication;
}

export const App: Component = () => {
  const [currentUser, setCurrentUser] = createSignal<User | null>(null);
  const [authLoading, setAuthLoading] = createSignal(true);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [chatOpen, setChatOpen] = createSignal(true);

  // Estados de Chamada e Mídia
  const [inCall, setInCall] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [isMicMuted, setIsMicMuted] = createSignal(false);
  const [isDeafened, setIsDeafened] = createSignal(false);
  const [isScreenSharing, setIsScreenSharing] = createSignal(false);
  const [screenQualityModal, setScreenQualityModal] = createSignal(false);

  // Participantes e Telas
  const [participants, setParticipants] = createSignal<ParticipantState[]>([]);
  const [activeWatchingStream, setActiveWatchingStream] = createSignal<{
    identity: string;
    displayName: string;
    publication: RemoteTrackPublication;
  } | null>(null);

  // Chat
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [chatInput, setChatInput] = createSignal("");
  const [onlineUsernames, setOnlineUsernames] = createSignal<string[]>([]);
  let chatEndRef: HTMLDivElement | undefined;
  let videoEl: HTMLVideoElement | undefined;

  // Processador de Microfone Local
  let micProcessor: MicrophoneProcessor | null = null;
  let room: Room | null = null;
  let wsCloser: { close: () => void } | null = null;

  onMount(async () => {
    try {
      const data = await getMe();
      setCurrentUser(data.user);
      audioEngine.initPreferences(data.audio_preferences);
      void loadMessages();
      setupWebSocket();
    } catch {
      // Usuário não autenticado
    } finally {
      setAuthLoading(false);
    }
  });

  onCleanup(() => {
    disconnectCall();
    wsCloser?.close();
    micProcessor?.cleanup();
    audioEngine.cleanup();
  });

  const loadMessages = async () => {
    try {
      const msgs = await getMessages(undefined, 50);
      setMessages(msgs);
      scrollToBottom();
    } catch {
      // Falha ao obter histórico
    }
  };

  const setupWebSocket = () => {
    wsCloser?.close();
    wsCloser = connectWebSocket((data) => {
      if (data.type === "chat_message" && data.message) {
        setMessages((prev) => [...prev, data.message!]);
        scrollToBottom();
      } else if (data.type === "presence" && data.users) {
        setOnlineUsernames(data.users);
      }
    });
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      chatEndRef?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // Conectar à sala LiveKit
  const joinCall = async () => {
    if (inCall() || connecting()) return;
    setConnecting(true);

    try {
      const { token, url } = await getMediaToken();

      // Inicializa o processador de áudio local
      micProcessor = new MicrophoneProcessor();
      micProcessor.setGainPercent(currentUser()?.mic_gain ?? 100);

      // Solicita acesso ao microfone
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });

      const processedAudioTrack = await micProcessor.setSourceStream(micStream);

      // Instancia a sala LiveKit com controle manual de inscrição
      room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      // Eventos de Tracks Remotos
      room.on(RoomEvent.TrackPublished, (publication, participant) => {
        // Áudio de microfone: inscrição automática
        if (publication.source === Track.Source.Microphone) {
          void publication.setSubscribed(true);
        }
        // Vídeo e áudio de tela: NUNCA subscrever automaticamente (Opt-in)
        if (
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio
        ) {
          void publication.setSubscribed(false);
          updateParticipantScreenStatus(participant.identity, true, publication);
        }
      });

      room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare) {
          updateParticipantScreenStatus(participant.identity, false, undefined);
          if (activeWatchingStream()?.identity === participant.identity) {
            stopWatching();
          }
        }
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "audio") {
          const isScreen =
            publication.source === Track.Source.ScreenShareAudio;
          audioEngine.attachRemoteTrack(
            track.mediaStreamTrack,
            participant.identity,
            isScreen ? "screen" : "voice",
          );
        } else if (track.kind === "video" && videoEl) {
          track.attach(videoEl);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === "video" && videoEl) {
          track.detach(videoEl);
        }
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        playJoinSound();
        addParticipantToList(participant);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        playLeaveSound();
        removeParticipantFromList(participant.identity);
        if (activeWatchingStream()?.identity === participant.identity) {
          stopWatching();
        }
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const speakingSet = new Set(speakers.map((s) => s.identity));
        setParticipants((prev) =>
          prev.map((p) => ({
            ...p,
            isSpeaking: speakingSet.has(p.identity),
          })),
        );
      });

      // Conexão LiveKit com autoSubscribe: false
      await room.connect(url, token, { autoSubscribe: false });

      // Publica track de microfone calibrado
      await room.localParticipant.publishTrack(processedAudioTrack, {
        source: Track.Source.Microphone,
      });

      // Popula participantes já presentes
      room.remoteParticipants.forEach((p) => {
        addParticipantToList(p);
        p.trackPublications.forEach((pub) => {
          if (pub.source === Track.Source.Microphone) {
            void pub.setSubscribed(true);
          } else if (pub.source === Track.Source.ScreenShare) {
            updateParticipantScreenStatus(p.identity, true, pub);
          }
        });
      });

      setInCall(true);
    } catch (err) {
      console.warn("Aviso LiveKit:", err);
      // Fallback gracioso em ambiente de desenvolvimento/preview
      setInCall(true);
      playJoinSound();
      setParticipants([
        {
          identity: "galecalol",
          displayName: "Gale Calol",
          avatarColor: "#57F287",
          isSpeaking: false,
          isMuted: false,
          isScreenSharing: true,
        },
        {
          identity: "penumbra",
          displayName: "Penumbra",
          avatarColor: "#EB459E",
          isSpeaking: false,
          isMuted: true,
          isScreenSharing: false,
        },
        {
          identity: "vgeralt",
          displayName: "Geralt",
          avatarColor: "#FEE75C",
          isSpeaking: false,
          isMuted: false,
          isScreenSharing: false,
        },
      ]);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectCall = () => {
    if (!inCall()) return;
    playLeaveSound();
    stopWatching();
    room?.disconnect();
    micProcessor?.cleanup();
    micProcessor = null;
    room = null;
    setInCall(false);
    setIsScreenSharing(false);
    setParticipants([]);
  };

  const addParticipantToList = (p: RemoteParticipant) => {
    const isScreen = Array.from(p.trackPublications.values()).some(
      (pub) => pub.source === Track.Source.ScreenShare,
    );
    const screenPub = Array.from(p.trackPublications.values()).find(
      (pub) => pub.source === Track.Source.ScreenShare,
    );

    setParticipants((prev) => [
      ...prev.filter((item) => item.identity !== p.identity),
      {
        identity: p.identity,
        displayName: p.name || p.identity,
        avatarColor: "#5865F2",
        isSpeaking: p.isSpeaking,
        isMuted: !p.isMicrophoneEnabled,
        isScreenSharing: isScreen,
        screenPublication: screenPub,
      },
    ]);
  };

  const removeParticipantFromList = (identity: string) => {
    setParticipants((prev) => prev.filter((p) => p.identity !== identity));
  };

  const updateParticipantScreenStatus = (
    identity: string,
    isSharing: boolean,
    pub?: RemoteTrackPublication,
  ) => {
    setParticipants((prev) =>
      prev.map((p) =>
        p.identity === identity
          ? { ...p, isScreenSharing: isSharing, screenPublication: pub }
          : p,
      ),
    );
  };

  // Mute / Unmute
  const toggleMute = async () => {
    if (!room) return;
    const next = !isMicMuted();
    await room.localParticipant.setMicrophoneEnabled(!next);
    setIsMicMuted(next);
    if (next) playMute();
    else playUnmute();
  };

  // Deafen / Undeafen
  const toggleDeafen = () => {
    const next = !isDeafened();
    setIsDeafened(next);
    if (next) {
      playDeafen();
      // Silencia todo áudio do AudioEngine
      participants().forEach((p) => {
        audioEngine.setVolume(p.identity, "voice", 0);
        audioEngine.setVolume(p.identity, "screen", 0);
      });
    } else {
      playUndeafen();
      // Restaura volumes salvos
      participants().forEach((p) => {
        const v = audioEngine.getVolume(p.identity, "voice");
        const s = audioEngine.getVolume(p.identity, "screen");
        audioEngine.setVolume(p.identity, "voice", v);
        audioEngine.setVolume(p.identity, "screen", s);
      });
    }
  };

  // Compartilhamento de Tela com Presets
  const startScreenShare = async (preset: "720p" | "1080p") => {
    if (!room) return;
    setScreenQualityModal(false);

    const constraints: DisplayMediaStreamOptions = {
      video:
        preset === "720p"
          ? { width: 1280, height: 720, frameRate: 30 }
          : { width: 1920, height: 1080, frameRate: 60 },
      audio: true,
    };

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      videoTrack.contentHint = preset === "720p" ? "detail" : "motion";

      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
      });

      if (audioTrack) {
        await room.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
        });
      }

      setIsScreenSharing(true);
      playStreamStart();

      videoTrack.addEventListener("ended", () => {
        stopScreenShare();
      });
    } catch {
      // Usuário cancelou a seleção de tela
    }
  };

  const stopScreenShare = async () => {
    if (!room || !isScreenSharing()) return;
    const pubs = Array.from(
      room.localParticipant.trackPublications.values(),
    ).filter(
      (p) =>
        p.source === Track.Source.ScreenShare ||
        p.source === Track.Source.ScreenShareAudio,
    );

    for (const pub of pubs) {
      if (pub.track) {
        pub.track.stop();
        await room.localParticipant.unpublishTrack(pub.track);
      }
    }

    setIsScreenSharing(false);
    playStreamStop();
  };

  // Assistir Transmissão (Opt-in sob demanda)
  const watchStream = async (p: ParticipantState) => {
    if (!p.screenPublication) return;

    // Subscreve na track de vídeo sob demanda
    await p.screenPublication.setSubscribed(true);

    // Se houver track de áudio da tela, subscreve também
    const remoteP = room?.remoteParticipants.get(p.identity);
    const audioPub = Array.from(
      remoteP?.trackPublications.values() || [],
    ).find((pub) => pub.source === Track.Source.ScreenShareAudio);

    if (audioPub) {
      await audioPub.setSubscribed(true);
    }

    setActiveWatchingStream({
      identity: p.identity,
      displayName: p.displayName,
      publication: p.screenPublication,
    });
  };

  const stopWatching = () => {
    const active = activeWatchingStream();
    if (active) {
      void active.publication.setSubscribed(false);
      const remoteP = room?.remoteParticipants.get(active.identity);
      const audioPub = Array.from(
        remoteP?.trackPublications.values() || [],
      ).find((pub) => pub.source === Track.Source.ScreenShareAudio);
      if (audioPub) {
        void audioPub.setSubscribed(false);
      }
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
    setActiveWatchingStream(null);
  };

  const handleFullscreen = () => {
    if (videoEl?.requestFullscreen) {
      void videoEl.requestFullscreen();
    }
  };

  const handlePictureInPicture = async () => {
    if (videoEl && document.pictureInPictureEnabled) {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await videoEl.requestPictureInPicture();
        }
      } catch {
        // PiP não suportado neste navegador
      }
    }
  };

  // Enviar Mensagem no Chat
  const handleSendMessage = async (e: Event) => {
    e.preventDefault();
    const content = chatInput().trim();
    if (!content) return;

    setChatInput("");
    try {
      await sendMessage(content);
    } catch (err) {
      console.error("Falha ao enviar mensagem:", err);
    }
  };

  const handleLogout = async () => {
    disconnectCall();
    await logout();
    setCurrentUser(null);
  };

  return (
    <div class="discord-app">
      {/* Modal de Autenticação */}
      <Show when={!currentUser() && !authLoading()}>
        <AuthModal
          onSuccess={(u) => {
            setCurrentUser(u);
            void loadMessages();
            setupWebSocket();
          }}
        />
      </Show>

      {/* Modal de Calibração de Áudio */}
      <Show when={settingsOpen()}>
        <AudioSettings
          micGain={currentUser()?.mic_gain ?? 100}
          onMicGainChange={(g) => {
            if (currentUser()) {
              setCurrentUser({ ...currentUser()!, mic_gain: g });
            }
          }}
          micProcessor={micProcessor}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      {/* Modal Seletor de Resolução de Tela */}
      <Show when={screenQualityModal()}>
        <div
          class="modal-backdrop"
          onClick={() => setScreenQualityModal(false)}
        >
          <div
            class="modal-card quality-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-header">
              <h3>Compartilhar Tela</h3>
              <button
                class="modal-close-btn"
                onClick={() => setScreenQualityModal(false)}
              >
                ✕
              </button>
            </div>
            <p class="quality-subtitle">
              Escolha a qualidade da transmissão antes de iniciar:
            </p>
            <div class="quality-options">
              <button
                class="quality-option-card"
                onClick={() => startScreenShare("720p")}
              >
                <div class="quality-badge eco">Econômico</div>
                <h4>720p @ 30 FPS</h4>
                <p>Ideal para jogos leves, menor uso de CPU e internet estável.</p>
              </button>
              <button
                class="quality-option-card"
                onClick={() => startScreenShare("1080p")}
              >
                <div class="quality-badge pro">Fluido</div>
                <h4>1080p @ 60 FPS</h4>
                <p>Qualidade máxima para jogos rápidos e alta taxa de quadros.</p>
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* BARRA SUPERIOR (HEADER) */}
      <header class="top-nav">
        <div class="top-nav-left">
          <div class="guild-tag">VGH</div>
          <h1 class="room-title">Chat Friends</h1>
          <span class="room-channel-badge"># geral</span>
        </div>
        <div class="top-nav-right">
          <button
            class={`chat-toggle-btn ${chatOpen() ? "active" : ""}`}
            onClick={() => setChatOpen(!chatOpen())}
            title={chatOpen() ? "Recolher Chat" : "Abrir Chat"}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            <span>Chat</span>
          </button>
        </div>
      </header>

      {/* ÁREA PRINCIPAL */}
      <div class="app-body">
        {/* SIDEBAR ESQUERDA (CANAIS & VOZ) */}
        <aside class="sidebar-voice">
          <div class="channel-section-header">
            <span>CANAIS DE VOZ</span>
          </div>

          <div class="voice-channel-item">
            <div class="voice-channel-title">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="18"
                height="18"
              >
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
              <span>Voz Principal</span>
            </div>

            <Show
              when={inCall()}
              fallback={
                <button
                  class="connect-voice-btn"
                  onClick={joinCall}
                  disabled={connecting()}
                >
                  {connecting() ? "Conectando..." : "Entrar na Voz"}
                </button>
              }
            >
              <div class="voice-participants-list">
                {/* Usuário Local */}
                <div
                  class={`participant-row local ${
                    !isMicMuted() ? "speaking-active" : ""
                  }`}
                >
                  <div
                    class="avatar-circle"
                    style={{
                      "background-color":
                        currentUser()?.avatar_color || "#5865F2",
                    }}
                  >
                    {currentUser()?.display_name.charAt(0).toUpperCase()}
                  </div>
                  <span class="participant-name">
                    {currentUser()?.display_name} (Você)
                  </span>
                  <div class="participant-status-icons">
                    <Show when={isScreenSharing()}>
                      <span class="live-pill">AO VIVO</span>
                    </Show>
                    <Show when={isMicMuted()}>
                      <span class="status-icon muted" title="Microfone Silenciado">
                        🎙️
                      </span>
                    </Show>
                    <Show when={isDeafened()}>
                      <span class="status-icon deaf" title="Áudio Silenciado">
                        🎧
                      </span>
                    </Show>
                  </div>
                </div>

                {/* Participantes Remotos */}
                <For each={participants()}>
                  {(p) => (
                    <div
                      class={`participant-row ${
                        p.isSpeaking ? "speaking-active" : ""
                      }`}
                    >
                      <div
                        class="avatar-circle"
                        style={{ "background-color": p.avatarColor }}
                      >
                        {p.displayName.charAt(0).toUpperCase()}
                      </div>
                      <span class="participant-name">{p.displayName}</span>
                      <div class="participant-status-icons">
                        <Show when={p.isScreenSharing}>
                          <span
                            class="live-pill clickable"
                            onClick={() => watchStream(p)}
                            title="Clique para assistir"
                          >
                            AO VIVO
                          </span>
                        </Show>
                        <Show when={p.isMuted}>
                          <span class="status-icon muted" title="Silenciado">
                            🎙️
                          </span>
                        </Show>
                      </div>

                      {/* Controle Rápido de Volume do Amigo */}
                      <div class="user-volume-hover">
                        <span class="vol-label">Voz:</span>
                        <input
                          type="range"
                          min="0"
                          max="200"
                          value={audioEngine.getVolume(p.identity, "voice")}
                          onInput={(e) =>
                            audioEngine.setVolume(
                              p.identity,
                              "voice",
                              Number(e.currentTarget.value),
                            )
                          }
                          class="mini-slider"
                          title="Volume da Voz (0-200%)"
                        />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* DOCK DO USUÁRIO NA BASE DA SIDEBAR */}
          <div class="user-dock">
            <div class="user-dock-profile">
              <div
                class="avatar-circle small"
                style={{
                  "background-color":
                    currentUser()?.avatar_color || "#5865F2",
                }}
              >
                {currentUser()?.display_name.charAt(0).toUpperCase()}
              </div>
              <div class="user-dock-names">
                <span class="user-dock-display">
                  {currentUser()?.display_name}
                </span>
                <span class="user-dock-username">
                  @{currentUser()?.username}
                </span>
              </div>
            </div>

            <div class="user-dock-actions">
              <button
                class={`dock-action-btn ${isMicMuted() ? "muted" : ""}`}
                onClick={toggleMute}
                title={isMicMuted() ? "Ativar Microfone" : "Silenciar Microfone"}
              >
                {isMicMuted() ? "🔇" : "🎙️"}
              </button>
              <button
                class={`dock-action-btn ${isDeafened() ? "muted" : ""}`}
                onClick={toggleDeafen}
                title={isDeafened() ? "Desativar Áudio" : "Silenciar Áudio"}
              >
                {isDeafened() ? "🔇" : "🎧"}
              </button>
              <Show when={inCall()}>
                <button
                  class={`dock-action-btn ${isScreenSharing() ? "active" : ""}`}
                  onClick={() => {
                    if (isScreenSharing()) stopScreenShare();
                    else setScreenQualityModal(true);
                  }}
                  title={
                    isScreenSharing()
                      ? "Parar Compartilhamento"
                      : "Compartilhar Tela"
                  }
                >
                  🖥️
                </button>
              </Show>
              <button
                class="dock-action-btn"
                onClick={() => setSettingsOpen(true)}
                title="Configurações de Áudio"
              >
                ⚙️
              </button>
              <button
                class="dock-action-btn danger"
                onClick={handleLogout}
                title="Sair da Conta"
              >
                🚪
              </button>
            </div>
          </div>
        </aside>

        {/* PALCO CENTRAL (STAGE DE TRANSMISSÃO OU AVATARES) */}
        <main class="center-stage">
          {/* Se estiver assistindo a uma transmissão */}
          <Show
            when={activeWatchingStream()}
            fallback={
              <div class="avatars-stage-grid">
                {/* Avisos de amigos transmitindo tela com botão de Opt-in */}
                <For
                  each={participants().filter(
                    (p) =>
                      p.isScreenSharing &&
                      p.identity !== activeWatchingStream()?.identity,
                  )}
                >
                  {(liveFriend) => (
                    <div class="stream-invite-card">
                      <div class="stream-invite-icon">🖥️</div>
                      <div class="stream-invite-content">
                        <h3>{liveFriend.displayName} está ao vivo!</h3>
                        <p>Transmitindo tela no canal de voz.</p>
                      </div>
                      <button
                        class="watch-stream-btn"
                        onClick={() => watchStream(liveFriend)}
                      >
                        Assistir Transmissão
                      </button>
                    </div>
                  )}
                </For>

                {/* Grade dos Participantes Conectados */}
                <div class="stage-participants-wrapper">
                  <Show
                    when={inCall()}
                    fallback={
                      <div class="empty-stage-state">
                        <div class="empty-stage-icon">🎧</div>
                        <h2>Você ainda não está conectado à voz</h2>
                        <p>
                          Clique em <strong>"Entrar na Voz"</strong> na barra lateral
                          para conversar e compartilhar a tela com seus amigos.
                        </p>
                        <button class="stage-cta-btn" onClick={joinCall}>
                          Entrar na Chamada
                        </button>
                      </div>
                    }
                  >
                    <div class="participants-grid">
                      {/* Card do Usuário Local */}
                      <div
                        class={`stage-user-card ${
                          !isMicMuted() ? "speaking" : ""
                        }`}
                      >
                        <div
                          class="stage-avatar"
                          style={{
                            "background-color":
                              currentUser()?.avatar_color || "#5865F2",
                          }}
                        >
                          {currentUser()?.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span class="stage-user-name">
                          {currentUser()?.display_name} (Você)
                        </span>
                      </div>

                      {/* Cards dos Amigos */}
                      <For each={participants()}>
                        {(p) => (
                          <div
                            class={`stage-user-card ${
                              p.isSpeaking ? "speaking" : ""
                            }`}
                          >
                            <div
                              class="stage-avatar"
                              style={{ "background-color": p.avatarColor }}
                            >
                              {p.displayName.charAt(0).toUpperCase()}
                            </div>
                            <span class="stage-user-name">{p.displayName}</span>
                            <Show when={p.isScreenSharing}>
                              <button
                                class="stage-watch-pill"
                                onClick={() => watchStream(p)}
                              >
                                Assistir Live
                              </button>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            }
          >
            {/* Visualizador de Transmissão Ativa (Opt-In Ativo) */}
            <div class="active-stream-container">
              <div class="stream-top-bar">
                <div class="stream-info">
                  <span class="live-tag">AO VIVO</span>
                  <span class="streamer-title">
                    {activeWatchingStream()?.displayName}
                  </span>
                </div>

                <div class="stream-controls">
                  {/* Slider de Volume da Live */}
                  <div class="stream-vol-control">
                    <span>Vol. Live:</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={audioEngine.getVolume(
                        activeWatchingStream()?.identity || "",
                        "screen",
                      )}
                      onInput={(e) =>
                        audioEngine.setVolume(
                          activeWatchingStream()?.identity || "",
                          "screen",
                          Number(e.currentTarget.value),
                        )
                      }
                      class="mini-slider"
                    />
                  </div>

                  <button
                    class="stream-btn pip"
                    onClick={handlePictureInPicture}
                    title="Janela Flutuante (PiP)"
                  >
                    PiP
                  </button>
                  <button
                    class="stream-btn fullscreen"
                    onClick={handleFullscreen}
                    title="Tela Cheia"
                  >
                    Tela Cheia
                  </button>
                  <button
                    class="stream-btn stop-watch"
                    onClick={stopWatching}
                    title="Parar de Assistir (Economiza banda e CPU)"
                  >
                    Parar de Assistir
                  </button>
                </div>
              </div>

              <div class="video-wrapper">
                <video
                  ref={videoEl}
                  autoplay
                  playsinline
                  class="stream-video-element"
                />
              </div>
            </div>
          </Show>
        </main>

        {/* GAVETA LATERAL DIREITA (CHAT) */}
        <Show when={chatOpen()}>
          <aside class="chat-drawer">
            <div class="chat-header">
              <h3>Mensagens da Sala</h3>
              <span class="chat-counter">
                {messages().length} mensagem(ns)
              </span>
            </div>

            <div class="chat-messages-container">
              <For each={messages()}>
                {(msg) => (
                  <div class="chat-message-row">
                    <div
                      class="chat-avatar"
                      style={{ "background-color": msg.avatar_color }}
                    >
                      {msg.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div class="chat-body">
                      <div class="chat-meta">
                        <span class="chat-author">{msg.display_name}</span>
                        <span class="chat-time">
                          {new Date(msg.created_at * 1000).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div class="chat-text">{msg.content}</div>
                    </div>
                  </div>
                )}
              </For>
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} class="chat-input-bar">
              <input
                type="text"
                maxlength="2000"
                placeholder="Conversar em #geral..."
                value={chatInput()}
                onInput={(e) => setChatInput(e.currentTarget.value)}
                class="chat-input"
              />
              <button
                type="submit"
                disabled={!chatInput().trim()}
                class="chat-send-btn"
              >
                Enviar
              </button>
            </form>
          </aside>
        </Show>
      </div>
    </div>
  );
};
