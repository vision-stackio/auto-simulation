const protoBanner = document.getElementById("protoBanner");
if (location.protocol === "file:") {
  protoBanner.classList.add("show");
  throw new Error(
    "Vision Auto-Simulation was opened as a local file. Run `npm start` in the project folder and open http://localhost:8787 instead — " +
      "every API call and asset fetch in this app uses an absolute path that only resolves against the real server."
  );
}

if (typeof window.THREE === "undefined") {
  document.getElementById("modelLoading").textContent =
    "Couldn't load the 3D engine (three.js from cdnjs.cloudflare.com). Check your internet connection or whether something is blocking that domain, then reload.";
  throw new Error("THREE is not defined — the three.js CDN script did not load.");
}

const { Rig } = await import("./rig.js");
const { createSpeechController } = await import("./speech.js");

const els = {
  micBtn: document.getElementById("micBtn"),
  micIcon: document.getElementById("micIcon"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  caption: document.getElementById("caption"),
  bodyState: document.getElementById("bodyState"),
  llmBadge: document.getElementById("llmBadge"),
  supportWarning: document.getElementById("supportWarning"),
  fallbackToggle: document.getElementById("fallbackToggle"),
  keyboardToggle: document.getElementById("keyboardToggle"),
  fallbackForm: document.getElementById("fallbackForm"),
  fallbackText: document.getElementById("fallbackText"),
};

const DURATIONAL_DEFAULT = { TURN_LEFT: 600, TURN_RIGHT: 600, WALK_FORWARD: 800, WALK_BACKWARD: 800, DANCE: 3000 };
const history = []; // { role, content }[]
const MAX_HISTORY = 8;

let busyExecuting = false; // true while a command sequence is playing
let idleTimer = null;
let musicAudio = null; // HTMLAudioElement for PLAY_MUSIC

function stopMusic() {
  if (musicAudio) {
    try { musicAudio.pause(); musicAudio.currentTime = 0; } catch (_) {}
    musicAudio = null;
  }
}

function playMusic(url) {
  stopMusic();
  if (!url || typeof url !== "string") return;
  // Only allow same-origin /downloads paths
  if (!url.startsWith("/downloads/")) {
    console.warn("PLAY_MUSIC blocked non-downloads URL:", url);
    return;
  }
  musicAudio = new Audio(url);
  musicAudio.volume = 0.9;
  musicAudio.play().catch((err) => console.error("Music play failed:", err));
  musicAudio.onended = () => {
    musicAudio = null;
    if (els.bodyState && els.bodyState.textContent === "Playing music") {
      els.bodyState.textContent = "Idle";
    }
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function setStatus(text, tone) {
  if (els.statusText) els.statusText.textContent = text;
  if (els.statusDot) els.statusDot.className = "dot" + (tone ? " " + tone : "");
}

// ---- caption bubble (the entire "conversation" UI) -------------------------
let captionTimer = null;
function showCaption(role, text) {
  clearTimeout(captionTimer);
  els.caption.className = "caption show " + role;
  els.caption.innerHTML = `<span class="who">${role === "user" ? "You" : "Vision"}</span>${escapeHtml(text)}`;
  captionTimer = setTimeout(() => els.caption.classList.remove("show"), role === "user" ? 2600 : 5200);
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function pushHistory(role, content) {
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plays a list of {op:'EXEC'|'SLEEP', ...} instructions against the rig,
 *  in order, awaiting each one's natural duration — mirrors the compiler
 *  project's simulator playback loop, minus the debug UI around it. */
async function executeInstructions(instructions) {
  if (!instructions || !instructions.length) return;
  busyExecuting = true;
  if (els.bodyState) els.bodyState.textContent = "Acting…";

  for (const instr of instructions) {
    if (instr.op === "SLEEP") {
      await delay(instr.ms);
      continue;
    }

    const { command, arg } = instr;
    let holdMs = 0;

    switch (command) {
      case "EYE_CENTER": Rig.setEyeAngle(90); break;
      case "EYE_SET": if (typeof arg === "number") Rig.setEyeAngle(clamp(arg, 0, 180)); break;
      case "EYE_LEFT": Rig.setEyeAngle(clamp(Rig.getEyeAngle() - (typeof arg === "number" ? arg : 15), 0, 180)); break;
      case "EYE_RIGHT": Rig.setEyeAngle(clamp(Rig.getEyeAngle() + (typeof arg === "number" ? arg : 15), 0, 180)); break;

      case "TURN_LEFT":
      case "TURN_RIGHT": {
        holdMs = typeof arg === "number" ? arg : DURATIONAL_DEFAULT[command];
        const delta = command === "TURN_LEFT" ? -90 : 90;
        Rig.setBodyTurn(Rig.getBodyTurn() + delta); // keep new heading (no snap-back)
        await delay(holdMs);
        break;
      }

      case "WALK_FORWARD": {
        // Keep walking until WALK_STOP / "Vision, stop" — no auto timeout
        Rig.setDancing(false);
        Rig.setWalking(true, 1);
        if (els.bodyState) els.bodyState.textContent = "Walking";
        break;
      }

      case "WALK_BACKWARD": {
        // Turn 180° from current heading, then walk forward in the new direction
        Rig.setDancing(false);
        Rig.setWalking(false);
        Rig.setBodyTurn(Rig.getBodyTurn() + 180);
        if (els.bodyState) els.bodyState.textContent = "Turning…";
        await delay(600);
        Rig.setWalking(true, 1);
        if (els.bodyState) els.bodyState.textContent = "Walking";
        break;
      }

      case "WALK_STOP":
        Rig.setWalking(false);
        Rig.setDancing(false);
        if (els.bodyState) els.bodyState.textContent = "Idle";
        break;

      case "DANCE": {
        // Keep dancing until WALK_STOP / "Vision, stop"
        Rig.setWalking(false);
        Rig.setDancing(true);
        if (els.bodyState) els.bodyState.textContent = "Dancing";
        break;
      }

      case "EMERGENCY_STOP":
        Rig.setStopped(true);
        Rig.setWalking(false);
        Rig.setDancing(false);
        if (els.bodyState) els.bodyState.textContent = "E-STOP";
        break;

      case "EMERGENCY_CLEAR":
        Rig.setStopped(false);
        break;

      case "AUDIO_SPEAK":
        // Speech is handled separately (see speakAndAct) so it can overlap
        // with movement; this tag alone just leaves a short beat.
        await delay(300);
        break;

      case "PLAY_MUSIC": {
        if (typeof arg === "string" && arg) {
          playMusic(arg);
          if (els.bodyState) els.bodyState.textContent = "Playing music";
        }
        break;
      }

      case "STOP_MUSIC": {
        stopMusic();
        break;
      }

      default:
        break;
    }
  }

  busyExecuting = false;
  // Continuous actions (walk/dance) keep their label until stop
  if (els.bodyState && els.bodyState.textContent === "Acting…") {
    els.bodyState.textContent = "Idle";
  }
}

/** Speaks the reply out loud while the command sequence plays concurrently,
 *  the way a real assistant would talk *while* gesturing rather than
 *  finishing one before starting the other. */
function speakAndAct(replyText, instructions, speech) {
  const runMovement = executeInstructions(instructions);
  speech.speak(replyText, {});
  return runMovement;
}

async function sendToServer(message) {
  showCaption("user", message);
  pushHistory("user", message);
  setStatus("Thinking…", "warn");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) throw new Error("server responded " + res.status);
    const data = await res.json();
    showCaption("assistant", data.reply || "…");
    pushHistory("assistant", data.reply || "");
    setStatus(speech.isListening() ? "Listening" : "Idle", speech.isListening() ? "good" : null);
    await speakAndAct(data.reply || "", data.instructions || [], speech);
  } catch (err) {
    console.error(err);
    showCaption("assistant", "Sorry, I couldn't reach the server.");
    setStatus("Error", "bad");
  }
}

// ---- "attentive listening" idle reaction ----------------------------------
// While interim (not-yet-final) speech is coming in, gently nudge the eyes
// back and forth so the robot looks like it's reacting to being spoken to —
// but only when it isn't already mid-action from a previous command.
let idleNudgeActive = false;
function startIdleNudge() {
  if (idleNudgeActive || busyExecuting) return;
  idleNudgeActive = true;
  const start = performance.now();
  function step(now) {
    if (!idleNudgeActive) { Rig.setIdleNudge(0); return; }
    const elapsed = (now - start) / 1000;
    Rig.setIdleNudge(Math.sin(elapsed * 3.2) * 12);
    idleTimer = requestAnimationFrame(step);
  }
  idleTimer = requestAnimationFrame(step);
}
function stopIdleNudge() {
  idleNudgeActive = false;
  if (idleTimer) cancelAnimationFrame(idleTimer);
  Rig.setIdleNudge(0);
}

let interimResetTimer = null;
function handleInterim() {
  startIdleNudge();
  clearTimeout(interimResetTimer);
  interimResetTimer = setTimeout(stopIdleNudge, 900); // stop nudging shortly after speech pauses
}

function handleFinal(text) {
  stopIdleNudge();
  sendToServer(text);
}

const speech = createSpeechController({
  onInterim: handleInterim,
  onFinal: handleFinal,
  onListeningChange: (isListening) => {
    els.micBtn.classList.toggle("live", isListening);
    els.micIcon.className = isListening ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash";
    if (!busyExecuting) setStatus(isListening ? "Listening" : "Idle", isListening ? "good" : null);
  },
});

if (!speech.supported) {
  els.supportWarning.style.display = "block";
  els.micBtn.disabled = true;
  els.fallbackForm.classList.add("show");
  els.keyboardToggle.style.display = "none";
}

els.micBtn.addEventListener("click", () => {
  if (speech.isListening()) speech.stopListening();
  else speech.startListening();
});

// Small escape hatch — not a chat log, just an occasional typed message —
// for accessibility or whenever speech recognition misbehaves.
function toggleFallback() {
  els.fallbackForm.classList.toggle("show");
  if (els.fallbackForm.classList.contains("show")) els.fallbackText.focus();
}
els.keyboardToggle.addEventListener("click", toggleFallback);
els.fallbackToggle?.addEventListener("click", toggleFallback);
els.fallbackForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.fallbackText.value.trim();
  if (!text) return;
  els.fallbackText.value = "";
  sendToServer(text);
});

// ---- boot -------------------------------------------------------------
setStatus("Loading model…", "warn");
fetch("/api/health")
  .then((r) => r.json())
  .then(({ llm }) => {
    if (!els.llmBadge) return;
    els.llmBadge.textContent = llm.configured ? `LLM: ${llm.provider} (${llm.model})` : "LLM: not configured";
    els.llmBadge.classList.toggle("warn", !llm.configured);
  })
  .catch(() => {
    if (!els.llmBadge) return;
    els.llmBadge.textContent = "LLM: server unreachable";
    els.llmBadge.classList.add("warn");
  });

Rig.ready.then(() => setStatus("Idle", null)).catch(() => setStatus("Model failed to load", "bad"));
