import { createSignal, Show, type Component } from "solid-js";
import { login, register, type User } from "../api";

interface AuthModalProps {
  onSuccess: (user: User) => void;
}

export const AuthModal: Component<AuthModalProps> = (props) => {
  const [tab, setTab] = createSignal<"login" | "register">("login");
  const [username, setUsername] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [inviteCode, setInviteCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (tab() === "login") {
        const user = await login(username(), password());
        props.onSuccess(user);
      } else {
        const user = await register(
          username(),
          displayName() || username(),
          password(),
          inviteCode(),
        );
        props.onSuccess(user);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Ocorreu um erro ao processar a autenticação.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="auth-backdrop">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-brand-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="36" height="36">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-9c.83 0 1.5-.67 1.5-1.5S7.83 8 7 8s-1.5.67-1.5 1.5S6.17 11 7 11zm10 0c.83 0 1.5-.67 1.5-1.5S17.83 8 17 8s-1.5.67-1.5 1.5.67 1.5 1.5 1.5zm-5 6c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
            </svg>
          </div>
          <h2>Boas-vindas ao Chat Friends</h2>
          <p class="auth-subtitle">
            {tab() === "login"
              ? "Estamos felizes em ter você de volta!"
              : "Crie sua conta para entrar na chamada com a galera."}
          </p>
        </div>

        <div class="auth-tabs">
          <button
            type="button"
            class={`auth-tab-btn ${tab() === "login" ? "active" : ""}`}
            onClick={() => {
              setTab("login");
              setError(null);
            }}
          >
            Entrar
          </button>
          <button
            type="button"
            class={`auth-tab-btn ${tab() === "register" ? "active" : ""}`}
            onClick={() => {
              setTab("register");
              setError(null);
            }}
          >
            Registrar-se
          </button>
        </div>

        <Show when={error()}>
          <div class="auth-error-banner">{error()}</div>
        </Show>

        <form onSubmit={handleSubmit} class="auth-form">
          <label class="auth-field">
            <span class="auth-label">NOME DE USUÁRIO</span>
            <input
              type="text"
              required
              autocomplete="username"
              placeholder="seu_usuario"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              class="auth-input"
            />
          </label>

          <Show when={tab() === "register"}>
            <label class="auth-field">
              <span class="auth-label">NOME DE EXIBIÇÃO</span>
              <input
                type="text"
                required
                placeholder="Como seus amigos vão te ver"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                class="auth-input"
              />
            </label>
          </Show>

          <label class="auth-field">
            <span class="auth-label">SENHA</span>
            <input
              type="password"
              required
              autocomplete={tab() === "login" ? "current-password" : "new-password"}
              placeholder="••••••••"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              class="auth-input"
            />
          </label>

          <Show when={tab() === "register"}>
            <label class="auth-field">
              <span class="auth-label">CÓDIGO DE CONVITE</span>
              <input
                type="text"
                required
                placeholder="Solicite ao criador do servidor"
                value={inviteCode()}
                onInput={(e) => setInviteCode(e.currentTarget.value)}
                class="auth-input"
              />
            </label>
          </Show>

          <button
            type="submit"
            disabled={loading()}
            class="auth-submit-btn"
          >
            {loading()
              ? "Carregando..."
              : tab() === "login"
                ? "Entrar"
                : "Criar Conta"}
          </button>
        </form>
      </div>
    </div>
  );
};
