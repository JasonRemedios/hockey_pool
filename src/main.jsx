import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadStripe } from "@stripe/stripe-js";
import { Circle, LogOut, RotateCcw } from "lucide-react";
import logoUrl from "./assets/logo.jpg";
import "./styles.css";

const TOKEN_KEY = "hockeyPoolSession";

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [picks, setPicks] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [winner, setWinner] = useState(null);
  const [stripePublishableKey, setStripePublishableKey] = useState("");
  const [paymentSession, setPaymentSession] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadPageData() {
    setLoading(true);
    setError("");

    try {
      const [scheduleData, winnerData, configData] = await Promise.all([
        apiFetch("/api/schedule/current"),
        apiFetch("/api/winner/latest"),
        apiFetch("/api/config"),
      ]);
      setSchedule(scheduleData);
      setWinner(winnerData);
      setStripePublishableKey(configData.stripePublishableKey || "");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPageData();
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }

    apiFetch("/api/me", { token })
      .then((data) => setUser(data.user))
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
      });
  }, [token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get("ticket");
    const sessionId = params.get("session_id");

    if (!ticketId || !sessionId || !token) {
      return;
    }

    apiFetch(`/api/tickets/${ticketId}/verify-payment`, {
      method: "POST",
      token,
      body: { sessionId },
    })
      .then(() => setMessage("Payment received. Your ticket is submitted."))
      .catch((paymentError) => setError(paymentError.message))
      .finally(() => window.history.replaceState({}, "", window.location.pathname));
  }, [token]);

  const stripePromise = useMemo(
    () => (stripePublishableKey ? loadStripe(stripePublishableKey) : null),
    [stripePublishableKey],
  );

  const gameDays = schedule?.days || [];
  const games = schedule?.games || [];
  const gameIds = useMemo(() => games.map((game) => String(game.id)), [games]);
  const totalGames = games.length;
  const pickedCount = Object.keys(picks).filter((gameId) => gameIds.includes(gameId)).length;
  const firstGame = games[0];

  useEffect(() => {
    setPicks({});
  }, [schedule?.ticketId]);

  async function submitAuth(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    try {
      const data = await apiFetch(`/api/auth/${authMode}`, {
        method: "POST",
        body: authMode === "register" ? authForm : { email: authForm.email, password: authForm.password },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      setMessage(`Signed in as ${data.user.name}.`);
    } catch (authError) {
      setError(authError.message);
    }
  }

  async function submitTicket() {
    setError("");
    setMessage("");
    setPaymentSession(null);

    if (!user) {
      setError("Please sign in before submitting a ticket.");
      return;
    }

    if (pickedCount !== totalGames) {
      setError("Please make a pick for every game before submitting.");
      return;
    }

    try {
      setSubmitting(true);
      const data = await apiFetch("/api/tickets", {
        method: "POST",
        token,
        body: { picks },
      });

      if (data.paymentRequired) {
        const checkout = await apiFetch(`/api/tickets/${data.ticket.id}/checkout`, {
          method: "POST",
          token,
          body: { embedded: Boolean(stripePublishableKey) },
        });

        if (checkout.clientSecret) {
          setPaymentSession({
            ticketId: data.ticket.id,
            sessionId: checkout.sessionId,
            clientSecret: checkout.clientSecret,
          });
          setMessage("Complete payment below. You can submit another ticket after payment is received.");
          return;
        }

        window.location.href = checkout.url;
      } else {
        setMessage("Ticket submitted and marked paid in local dev mode.");
        setPicks({});
      }
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function completeEmbeddedPayment(sessionId) {
    if (!paymentSession) {
      return;
    }

    try {
      const verified = await apiFetch(`/api/tickets/${paymentSession.ticketId}/verify-payment`, {
        method: "POST",
        token,
        body: { sessionId },
      });
      setPaymentSession(null);
      setPicks({});
      setMessage(`Payment received. Ticket ${verified.ticket.ticketId} is submitted. You can play another ticket.`);
    } catch (paymentError) {
      setError(paymentError.message);
    }
  }

  function chooseTeam(gameId, team) {
    setPicks((current) => {
      const next = { ...current };

      if (next[gameId] === team) {
        delete next[gameId];
      } else {
        next[gameId] = team;
      }

      return next;
    });
  }

  function resetPicks() {
    setPicks({});
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
  }

  return (
    <main className="page-shell">
      <section className="ticket" aria-label="Trinity-Placentia Minor Hockey Association lottery ticket">
        <header className="ticket-header">
          <img className="association-logo" src={logoUrl} alt="Trinity Placentia Minor Hockey logo" />

          <div className="association">
            <p>TRINITY-PLACENTIA MINOR HOCKEY ASSOCIATION</p>
            <p>P.O. Box 666, Blaketown, NL A0B 1C0</p>
          </div>

          <img className="association-logo" src={logoUrl} alt="" aria-hidden="true" />
        </header>

        <section className="ticket-info">
          <div>
            <h1>{getWeekTitle(gameDays)}</h1>
            <p>
              Ticket # <strong>{schedule?.ticketId || "---"}</strong>
            </p>
            <p>
              Tickets: <strong>$3.00 each</strong>
            </p>
            <p>
              Weekly Prize is <strong>50/50</strong>
            </p>
          </div>

          <div className="details-block">
            <p>
              First Game: <strong>{firstGame ? firstGame.startLabel : "Loading..."}</strong>
            </p>
            <p>
              Games on Ticket: <strong>{totalGames || "-"}</strong>
            </p>
            <p>
              Last Winner: <strong>{formatWinner(winner)}</strong>
            </p>
          </div>

          <AccountPanel
            authForm={authForm}
            authMode={authMode}
            onAuthModeChange={setAuthMode}
            onFormChange={setAuthForm}
            onSubmit={submitAuth}
            onSignOut={signOut}
            user={user}
          />
        </section>

        <p className="instructions">
          Circle the team you think will win the game. Each correct prediction is worth one point.
          The person with the most points wins the pot.
        </p>

        <section className="games-grid" aria-label="NHL games">
          {loading ? (
            <StatusPanel message="Loading NHL games..." />
          ) : error && !gameDays.length ? (
            <StatusPanel message={error} actionLabel="Try Again" onAction={loadPageData} />
          ) : gameDays.length ? (
            gameDays.map((day) => (
              <div className="day-column" key={day.date}>
                <h2>{day.label}</h2>
                <div className="games-list">
                  {day.games.map((game) => (
                    <div className="matchup" key={game.id}>
                      <TeamButton
                        team={game.awayTeam}
                        selected={picks[game.id] === game.awayTeam}
                        onClick={() => chooseTeam(String(game.id), game.awayTeam)}
                      />
                      <span className="at">at</span>
                      <TeamButton
                        team={game.homeTeam}
                        selected={picks[game.id] === game.homeTeam}
                        onClick={() => chooseTeam(String(game.id), game.homeTeam)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <StatusPanel message="No Friday, Saturday, or Sunday NHL games found." />
          )}
        </section>

        {(error || message) && (
          <p className={`form-message ${error ? "error" : "success"}`}>{error || message}</p>
        )}

        {paymentSession && stripePromise && (
          <EmbeddedCheckoutPanel
            clientSecret={paymentSession.clientSecret}
            onCancel={() => setPaymentSession(null)}
            onComplete={() => completeEmbeddedPayment(paymentSession.sessionId)}
            stripePromise={stripePromise}
          />
        )}

        <section className="ticket-footer">
          <p>
            Friday, Saturday, and Sunday games only. Entries must be in before the first ticket game starts.
          </p>
          <p>
            NOTICE: Last week's winner is calculated automatically from paid submitted tickets and final NHL scores.
          </p>
          <div className="footer-actions">
            <button type="button" className="submit-ticket" onClick={submitTicket}>
              {submitting ? "Submitting..." : "Submit & Pay"}
            </button>
          </div>
        </section>

        <aside className="pick-counter" aria-live="polite">
          <span>
            {pickedCount}/{totalGames || 0} selected
          </span>
          <button type="button" onClick={resetPicks} aria-label="Reset picks">
            <RotateCcw size={16} />
          </button>
        </aside>
      </section>
    </main>
  );
}

function EmbeddedCheckoutPanel({ clientSecret, onCancel, onComplete, stripePromise }) {
  const checkoutRef = useRef(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let active = true;
    let embeddedCheckout = null;

    async function mountCheckout() {
      const stripe = await stripePromise;
      if (!stripe || !active || !checkoutRef.current) {
        return;
      }

      const checkout = await stripe.initEmbeddedCheckout({
        clientSecret,
        onComplete: () => onCompleteRef.current(),
      });

      if (active && checkoutRef.current) {
        embeddedCheckout = checkout;
        checkout.mount(checkoutRef.current);
      } else {
        checkout.destroy();
      }
    }

    mountCheckout();

    return () => {
      active = false;
      embeddedCheckout?.destroy();
    };
  }, [clientSecret, stripePromise]);

  return (
    <section className="embedded-checkout" aria-label="Secure card payment">
      <div className="embedded-checkout-header">
        <h2>Payment</h2>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div ref={checkoutRef} />
    </section>
  );
}

function AccountPanel({
  authForm,
  authMode,
  onAuthModeChange,
  onFormChange,
  onSubmit,
  onSignOut,
  user,
}) {
  if (user) {
    return (
      <div className="account-panel signed-in">
        <p>Signed in as</p>
        <strong>{user.name}</strong>
        <span>{user.email}</span>
        <button type="button" onClick={onSignOut}>
          <LogOut size={15} />
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <form className="account-panel" onSubmit={onSubmit}>
      <div className="auth-tabs">
        <button
          type="button"
          className={authMode === "login" ? "active" : ""}
          onClick={() => onAuthModeChange("login")}
        >
          Log In
        </button>
        <button
          type="button"
          className={authMode === "register" ? "active" : ""}
          onClick={() => onAuthModeChange("register")}
        >
          Register
        </button>
      </div>
      {authMode === "register" && (
        <label>
          <span>Name:</span>
          <input
            type="text"
            value={authForm.name}
            onChange={(event) => onFormChange({ ...authForm, name: event.target.value })}
          />
        </label>
      )}
      <label>
        <span>Email:</span>
        <input
          type="email"
          value={authForm.email}
          onChange={(event) => onFormChange({ ...authForm, email: event.target.value })}
        />
      </label>
      <label>
        <span>Password:</span>
        <input
          type="password"
          value={authForm.password}
          onChange={(event) => onFormChange({ ...authForm, password: event.target.value })}
        />
      </label>
      <button type="submit" className="auth-submit">
        {authMode === "login" ? "Log In" : "Create Account"}
      </button>
    </form>
  );
}

function TeamButton({ team, selected, onClick }) {
  return (
    <button
      type="button"
      className={`team-button ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <Circle size={12} aria-hidden="true" />
      <span>{team}</span>
    </button>
  );
}

function StatusPanel({ message, actionLabel, onAction }) {
  return (
    <div className="status-panel">
      <p>{message}</p>
      {actionLabel && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function getWeekTitle(gameDays) {
  if (!gameDays.length) {
    return "NHL Pool";
  }

  const firstDate = new Date(`${gameDays[0].date}T12:00:00`);
  return `Week of ${new Intl.DateTimeFormat("en-CA", {
    month: "long",
    day: "numeric",
  }).format(firstDate)}`;
}

function formatWinner(winner) {
  if (!winner?.winners?.length) {
    return "Pending";
  }

  const names = winner.winners.map((item) => item.name).join(", ");
  return `${names} (${winner.winners[0].correct}/${winner.possible})`;
}

createRoot(document.getElementById("root")).render(<App />);
