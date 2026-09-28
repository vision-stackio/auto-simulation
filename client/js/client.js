// ---- Fail loudly instead of silently -------------------------------------
// The two most common ways this breaks are (1) opening index.html directly
// as a file instead of through the Node server, and (2) three.js failing to
// load from the CDN. Both used to fail silently with only console errors —
// now they show an obvious on-page message instead.

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
  identifyToggle: document.getElementById("identifyToggle"),
  // identify panel elements
  identifyPanel: document.getElementById("identifyPanel"),
  identifyClose: document.getElementById("identifyClose"),
  identifyDropzone: document.getElementById("identifyDropzone"),
  dropzoneInner: document.getElementById("dropzoneInner"),
  identifyFileInput: document.getElementById("identifyFileInput"),
  dropzonePreview: document.getElementById("dropzonePreview"),
  identifySubmit: document.getElementById("identifySubmit"),
  identifyResult: document.getElementById("identifyResult"),
  resultName: document.getElementById("resultName"),
  resultSummary: document.getElementById("resultSummary"),
  resultInfo: document.getElementById("resultInfo"),
  identifyError: document.getElementById("identifyError"),
  identifyLoader: document.getElementById("identifyLoader"),
};

const DURATIONAL_DEFAULT = { TURN_LEFT: 600, TURN_RIGHT: 600, WALK_FORWARD: 800, WALK_BACKWARD: 800, DANCE: 3000 };
const history = []; // { role, content }[]
const MAX_HISTORY = 8;

let busyExecuting = false; // true while a command sequence is playing
let idleTimer = null;

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
        const delta = command === "TURN_LEFT" ? -20 : 20;
        Rig.setBodyTurn(Rig.getBodyTurn() + delta);
        await delay(holdMs);
        Rig.setBodyTurn(Rig.getBodyTurn() - delta);
        break;
      }

      case "WALK_FORWARD":
      case "WALK_BACKWARD": {
        holdMs = typeof arg === "number" ? arg : DURATIONAL_DEFAULT[command];
        Rig.setWalking(true);
        if (els.bodyState) els.bodyState.textContent = "Walking";
        await delay(holdMs);
        Rig.setWalking(false);
        break;
      }

      case "WALK_STOP":
        Rig.setWalking(false);
        break;

      case "DANCE": {
        holdMs = typeof arg === "number" ? arg : DURATIONAL_DEFAULT.DANCE;
        Rig.setDancing(true);
        if (els.bodyState) els.bodyState.textContent = "Dancing";
        await delay(holdMs);
        Rig.setDancing(false);
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

      default:
        break;
    }
  }

  busyExecuting = false;
  if (els.bodyState) els.bodyState.textContent = "Idle";
}

let lastAssistantReply = "";
let lastAssistantReplyTime = 0;
let isSending = false;

function isEchoOfAssistant(text) {
  if (!lastAssistantReply) return false;
  // Acoustic echo from speakers only happens during or immediately after speech
  if (Date.now() - lastAssistantReplyTime > 6000) return false;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const cleanInput = normalize(text);
  const cleanReply = normalize(lastAssistantReply);

  if (!cleanInput || !cleanReply) return false;

  // 1. Exact match
  if (cleanInput === cleanReply) return true;

  // 2. Substring match within 6s of assistant speaking
  if (cleanInput.length >= 8 && cleanReply.includes(cleanInput)) return true;
  if (cleanReply.length >= 8 && cleanInput.includes(cleanReply)) return true;

  // 3. Word overlap: if at least 2 words and >70% overlap
  const inputWords = cleanInput.split(" ").filter((w) => w.length > 2);
  const replyWords = new Set(cleanReply.split(" ").filter((w) => w.length > 2));
  if (inputWords.length >= 2) {
    const matched = inputWords.filter((w) => replyWords.has(w)).length;
    if (matched / inputWords.length >= 0.7) return true;
  }

  return false;
}

/** Speaks the reply out loud while the command sequence plays concurrently,
 *  awaiting both so state stays clean. */
function speakAndAct(replyText, instructions, speech) {
  const runMovement = executeInstructions(instructions);
  const speechPromise = new Promise((resolve) => {
    speech.speak(replyText, { onEnd: resolve });
  });
  return Promise.all([runMovement, speechPromise]);
}

async function sendToServer(message, isDirectUserAction = false) {
  if (isSending) return;
  isSending = true;

  showCaption("user", message);
  pushHistory("user", message);
  setStatus("Thinking…", "warn");

  let replyText = "";
  let instructions = [];

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) throw new Error("server responded " + res.status);
    const data = await res.json();
    replyText = data.reply || "…";
    instructions = data.instructions || [];

    lastAssistantReply = replyText;
    lastAssistantReplyTime = Date.now();

    if (
      data.action === "open_identify" ||
      /\b(panel|upload (a |an )?(photo|image|picture)|drop (a |an )?(photo|image))\b/i.test(replyText)
    ) {
      resetIdentifyPanel();
      showIdentifyPanel();
    }

    showCaption("assistant", replyText);
    pushHistory("assistant", replyText);
  } catch (err) {
    console.error(err);
    replyText = "Hmm, I had trouble reaching my brain — try again in a moment!";
    showCaption("assistant", replyText);
    setStatus("Error", "bad");
  } finally {
    // Release the lock as soon as we have a response — speech.isSpeaking()
    // guards against echo during playback so we don't need isSending for that.
    isSending = false;
  }

  // Speak and act outside the isSending lock so the user can queue the next
  // message as soon as the acoustic cooldown ends.
  if (replyText) {
    if (els.bodyState) els.bodyState.textContent = "Speaking…";
    setStatus("Speaking…", "warn");
    await speakAndAct(replyText, instructions, speech);
    setStatus(speech.isListening() ? "Listening" : "Idle", speech.isListening() ? "good" : null);
    if (els.bodyState) els.bodyState.textContent = "Idle";
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
  if (speech.isSpeaking() || isSending) return;
  startIdleNudge();
  clearTimeout(interimResetTimer);
  interimResetTimer = setTimeout(stopIdleNudge, 900); // stop nudging shortly after speech pauses
}

function handleFinal(text) {
  stopIdleNudge();

  const trimmed = text.trim();
  if (!trimmed) return;

  // 1. Never accept input while the robot is speaking or in cooldown
  if (speech.isSpeaking()) {
    console.log("[speech] Dropped input during speaking/cooldown:", trimmed);
    return;
  }

  // 2. Reject self-echo of the robot's own recent output
  if (isEchoOfAssistant(trimmed)) {
    console.log("[speech] Dropped echo of robot output:", trimmed);
    return;
  }

  // 3. Ignore speech if a server request is currently in flight
  if (isSending) {
    console.log("[speech] Dropped input while request in flight:", trimmed);
    return;
  }

  // 4. Identify-person intent — open the panel and prompt for a photo
  if (isIdentifyIntent(trimmed)) {
    showCaption("user", trimmed);
    resetIdentifyPanel();
    showIdentifyPanel();
    const prompt = "Sure! Drop a photo into the panel on the right and I'll tell you who it is.";
    showCaption("assistant", prompt);
    speech.speak(prompt);
    return;
  }

  sendToServer(trimmed);
}

const speech = createSpeechController({
  onInterim: handleInterim,
  onFinal: handleFinal,
  onListeningChange: (isListening) => {
    els.micBtn.classList.toggle("live", isListening);
    els.micIcon.className = isListening ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash";
    if (!busyExecuting && !speech.isSpeaking() && !isSending) {
      setStatus(isListening ? "Listening" : "Idle", isListening ? "good" : null);
    }
  },
});

if (!speech.supported) {
  els.supportWarning.style.display = "block";
  els.micBtn.disabled = true;
  els.fallbackForm.classList.add("show");
  els.keyboardToggle.style.display = "none";
}

els.micBtn.addEventListener("click", () => {
  if (speech.isListening()) {
    speech.stopListening();
    speech.stopSpeaking();
  } else {
    speech.startListening();
  }
});

// Small escape hatch — not a chat log, just an occasional typed message —
// for accessibility or whenever speech recognition misbehaves.
function toggleFallback() {
  els.fallbackForm.classList.toggle("show");
  if (els.fallbackForm.classList.contains("show")) els.fallbackText.focus();
}
els.keyboardToggle?.addEventListener("click", toggleFallback);
els.fallbackToggle?.addEventListener("click", toggleFallback);
els.identifyToggle?.addEventListener("click", () => {
  speech.stopSpeaking();
  toggleIdentifyPanel();
});
els.fallbackForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.fallbackText.value.trim();
  if (!text) return;
  els.fallbackText.value = "";
  speech.stopSpeaking();

  if (isIdentifyIntent(text)) {
    showCaption("user", text);
    resetIdentifyPanel();
    showIdentifyPanel();
    const prompt = "Sure! Drop a photo into the panel on the right and I'll tell you who it is.";
    showCaption("assistant", prompt);
    speech.speak(prompt);
    return;
  }

  sendToServer(text, true);
});

// ---- identify-person panel logic ----------------------------------------
const IDENTIFY_RE = /\b(identif[ty]+|identifying)\b.*\b(persons?|people|someone|anyone|human|individual|faces?|him|her|them|who|image|photo|picture)\b/i;
let identifyFile = null; // File object selected by the user

function isIdentifyIntent(text) {
  if (!text) return false;
  return (
    IDENTIFY_RE.test(text) ||
    /\b(who\s+is\s+(this|that|he|she))\b/i.test(text) ||
    /\b(recogni[sz]e|recogni[sz]ing)\b.*\b(persons?|people|someone|anyone|faces?|him|her|them|this|that)\b/i.test(text) ||
    /\b(do\s+you\s+know\s+(who|him|her|them|this\s+person))\b/i.test(text) ||
    /\b(facial\s+recognition|face\s+id)\b/i.test(text) ||
    /\b(open|show)\s+(the\s+)?(identify|upload|photo|image|face)\s*(panel|box|input)?\b/i.test(text) ||
    /\b(upload\s+(a\s+)?(photo|image|picture))\b/i.test(text)
  );
}

function showIdentifyPanel() {
  els.identifyPanel.classList.add("open");
  els.identifyPanel.setAttribute("aria-hidden", "false");
  if (els.identifyToggle) els.identifyToggle.classList.add("active");
}

function hideIdentifyPanel() {
  els.identifyPanel.classList.remove("open");
  els.identifyPanel.setAttribute("aria-hidden", "true");
  if (els.identifyToggle) els.identifyToggle.classList.remove("active");
}

function toggleIdentifyPanel() {
  if (els.identifyPanel.classList.contains("open")) {
    hideIdentifyPanel();
    resetIdentifyPanel();
  } else {
    resetIdentifyPanel();
    showIdentifyPanel();
  }
}

function resetIdentifyPanel() {
  identifyFile = null;
  els.identifySubmit.disabled = true;
  els.dropzonePreview.hidden = true;
  els.dropzonePreview.src = "";
  els.dropzoneInner.hidden = false;
  els.identifyResult.hidden = true;
  els.identifyError.hidden = true;
  els.identifyLoader.hidden = true;
  els.resultName.textContent = "";
  if (els.resultSummary) {
    els.resultSummary.hidden = true;
    els.resultSummary.innerHTML = "";
  }
  els.resultInfo.innerHTML = "";
}

function previewFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  identifyFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    els.dropzonePreview.src = e.target.result;
    els.dropzonePreview.hidden = false;
    els.dropzoneInner.hidden = true;
    els.identifySubmit.disabled = false;
  };
  reader.readAsDataURL(file);
}

// Click to browse
els.identifyDropzone.addEventListener("click", () => els.identifyFileInput.click());
els.identifyFileInput.addEventListener("change", () => {
  if (els.identifyFileInput.files.length) previewFile(els.identifyFileInput.files[0]);
});

// Drag-and-drop
els.identifyDropzone.addEventListener("dragover", (e) => { e.preventDefault(); els.identifyDropzone.classList.add("dragover"); });
els.identifyDropzone.addEventListener("dragleave", () => els.identifyDropzone.classList.remove("dragover"));
els.identifyDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.identifyDropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) previewFile(file);
});

// Close button
els.identifyClose.addEventListener("click", () => { hideIdentifyPanel(); resetIdentifyPanel(); });

// Submit button — read the file as base64, POST to /api/identify
els.identifySubmit.addEventListener("click", async () => {
  if (!identifyFile) return;

  els.identifySubmit.disabled = true;
  els.identifyResult.hidden = true;
  els.identifyError.hidden = true;
  els.identifyLoader.hidden = false;

  try {
    const base64 = await fileToBase64(identifyFile);
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType: identifyFile.type }),
    });
    if (!res.ok) throw new Error("Server responded " + res.status);
    const data = await res.json();

    els.identifyLoader.hidden = true;

    if (data.error) {
      els.identifyError.textContent = data.error;
      els.identifyError.hidden = false;
      speech.speak("Sorry, I couldn't identify that person.");
      return;
    }

    // Show result
    els.resultName.textContent = data.name || "Unknown";
    const spokenName = data.name || "this person";
    const spokenSummary = data.summary?.trim() || summarizePersonLocally(spokenName, data.info);

    if (els.resultSummary) {
      if (spokenSummary) {
        els.resultSummary.innerHTML = `<i class="fa-solid fa-volume-high"></i><span>${escapeHtml(spokenSummary)}</span>`;
        els.resultSummary.hidden = false;
      } else {
        els.resultSummary.hidden = true;
      }
    }

    els.resultInfo.innerHTML = "";
    if (data.info && data.info.length) {
      for (const point of data.info) {
        const div = document.createElement("div");
        div.className = "result-info-item";
        div.textContent = point;
        els.resultInfo.appendChild(div);
      }
    }
    els.identifyResult.hidden = false;

    // Have Vision announce the result using the summary of the information (not the raw snippet)
    showCaption("assistant", spokenSummary);
    lastAssistantReply = spokenSummary;
    lastAssistantReplyTime = Date.now();
    speech.speak(spokenSummary);
  } catch (err) {
    console.error("[identify]", err);
    els.identifyLoader.hidden = true;
    els.identifyError.textContent = "Something went wrong — please try again.";
    els.identifyError.hidden = false;
    speech.speak("Sorry, something went wrong while identifying that person.");
  }
});

function cleanSnippet(raw) {
  if (!raw) return "";
  return raw
    .replace(/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\s*[—–\-·….]\s*/i, "")
    .replace(/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s*[—–\-·….]\s*/i, "")
    .replace(/^\d+\s+(hours?|days?|months?|years?|mins?|minutes?)\s+ago\s*[—–\-·….]\s*/i, "")
    .replace(/\s*\(\s*\/[^)]+\/\s*[;,]?\s*/gi, " (")
    .replace(/\b(FRS|KBE|OBE|CBE|MBE)\b/g, "")
    .replace(/\s*\([^)]*\b(?:born|died|pronounced|née)\b[^)]*\)/gi, "")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizePersonLocally(name, infoPoints) {
  // Strip website suffixes like "Elon Musk – Wikipedia"
  const safeName = name ? name.replace(/\s*[-–—|•·].*$/, "").trim() : "this person";
  if (!infoPoints || !infoPoints.length) {
    return `I think this is ${safeName}.`;
  }

  const cleaned = infoPoints.map(cleanSnippet).filter(t => t.length > 20);
  if (!cleaned.length) {
    return `I identified this person as ${safeName}.`;
  }

  // 1. Look for a strong identity sentence: "is a businessman", "is the CEO of..."
  let identitySentence = "";
  for (const item of cleaned) {
    const sentences = item.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (
        /\b(?:is|was)\s+(?:an?|the)\b/i.test(s) &&
        /\b(?:businessman|entrepreneur|investor|executive|founder|ceo|scientist|engineer|artist|politician|leader|author|actor|director|researcher)\b/i.test(s)
      ) {
        identitySentence = s.trim();
        break;
      }
    }
    if (identitySentence) break;
  }

  // 2. Fall back to any "is a/the" or "known for" sentence
  if (!identitySentence) {
    for (const item of cleaned) {
      const sentences = item.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (/\b(?:is|was)\s+(?:an?|the)\b/i.test(s) || /\b(?:known for|leads|founded|created)\b/i.test(s)) {
          identitySentence = s.trim();
          break;
        }
      }
      if (identitySentence) break;
    }
  }

  // 3. Last resort: first sentence
  if (!identitySentence) {
    identitySentence = cleaned[0].split(/(?<=[.!?])\s+/)[0] || cleaned[0];
  }

  let sentence = identitySentence;

  // Transform "[Full Name] is a..." → "This is [safeName], a..."
  const fullIdentityRegex = new RegExp(`^[A-Z][a-zA-Z\\s.']+\\s+(?:is|was)\\s+(an?\\s+.+)$`, "i");
  const match = sentence.match(fullIdentityRegex);
  if (match) {
    sentence = `This is ${safeName}, ${match[1]}`;
  } else if (!sentence.toLowerCase().includes(safeName.toLowerCase())) {
    sentence = `This is ${safeName}. ${sentence}`;
  }

  // Strip any trailing dangling connective words
  sentence = sentence
    .replace(/\s+(?:and|the|of|in|for|with|that|to|a|an|as|or|by)[.,\s]*$/i, "")
    .replace(/[,\s;:-]+$/, "")
    .trim();

  if (!/[.!?]$/.test(sentence)) {
    sentence += ".";
  }

  return sentence;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mime>;base64,<data>" — strip the prefix
      const fullResult = reader.result;
      resolve(fullResult.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

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
