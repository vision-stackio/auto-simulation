// Thin wrapper around the browser's Web Speech API. Chrome/Edge have solid
// support for both continuous SpeechRecognition and speechSynthesis; Safari
// and Firefox are weaker or missing recognition entirely, so callers should
// treat `SpeechController.supported` as a hard feature check and fall back
// to the text input in the UI when it's false.

export function createSpeechController({ onInterim, onFinal, onListeningChange }) {
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SpeechRecognitionImpl && !!window.speechSynthesis;

  let recognition = null;
  let userWantsListening = false;
  let actuallyRecognizing = false;
  let isSpeaking = false;
  let lastSpeakEndTime = 0;
  let activeUtterance = null; // keeps reference to prevent Chrome GC bug
  let cooldownTimer = null;
  let safetyTimeout = null;

  function safeStartRecognition() {
    if (!recognition || actuallyRecognizing) return;
    if (!userWantsListening || isSpeaking) return;
    if (Date.now() - lastSpeakEndTime < 800) return;

    try {
      recognition.start();
      actuallyRecognizing = true;
    } catch {
      /* already starting or active in browser */
    }
  }

  function safeStopRecognition() {
    if (!recognition) return;
    actuallyRecognizing = false;
    try {
      recognition.abort(); // abort flushes pending audio buffers so no trailing speech is emitted
    } catch {
      /* ignore */
    }
  }

  if (SpeechRecognitionImpl) {
    recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      actuallyRecognizing = true;
    };

    recognition.onresult = (event) => {
      // Discard any audio captured while the speaker was talking or during the acoustic cooldown
      if (isSpeaking || Date.now() - lastSpeakEndTime < 1000) {
        return;
      }

      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }

      if (interim.trim() && !isSpeaking && Date.now() - lastSpeakEndTime >= 1000) {
        onInterim?.(interim.trim());
      }
      if (final.trim() && !isSpeaking && Date.now() - lastSpeakEndTime >= 1000) {
        onFinal?.(final.trim());
      }
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are normal lifecycle events in continuous mode
      if (event.error !== "no-speech" && event.error !== "aborted") {
        console.warn("speech recognition error:", event.error);
      }
    };

    recognition.onend = () => {
      actuallyRecognizing = false;
      // Auto-restart recognition unless the user explicitly turned off the mic,
      // or speech synthesis is active/cooling down
      if (userWantsListening && !isSpeaking && Date.now() - lastSpeakEndTime >= 800) {
        safeStartRecognition();
      }
    };
  }

  function startListening() {
    userWantsListening = true;
    onListeningChange?.(true);
    if (!isSpeaking) {
      safeStartRecognition();
    }
  }

  function stopListening() {
    userWantsListening = false;
    safeStopRecognition();
    onListeningChange?.(false);
  }

  function stopSpeaking() {
    clearTimeout(cooldownTimer);
    clearTimeout(safetyTimeout);
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    activeUtterance = null;
    isSpeaking = false;
    lastSpeakEndTime = Date.now();
    if (userWantsListening) {
      setTimeout(() => {
        if (userWantsListening && !isSpeaking) safeStartRecognition();
      }, 300);
    }
  }

  function speak(text, { onEnd } = {}) {
    if (!window.speechSynthesis || !text) {
      onEnd?.();
      return;
    }

    clearTimeout(cooldownTimer);
    clearTimeout(safetyTimeout);

    isSpeaking = true;
    // Abort recognition immediately so the mic cannot capture speaker output
    safeStopRecognition();

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    activeUtterance = utterance;
    utterance.rate = 1.02;
    utterance.pitch = 1.05;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeUtterance = null;
      lastSpeakEndTime = Date.now();

      // Keep mic paused for cooldown window to allow room reverberation/echo to settle
      cooldownTimer = setTimeout(() => {
        isSpeaking = false;
        if (userWantsListening) {
          safeStartRecognition();
        }
        onEnd?.();
      }, 700);
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Safety timeout in case browser speech synthesis fails to fire onend
    const maxDurationMs = Math.max(3000, text.length * 120 + 4000);
    safetyTimeout = setTimeout(() => {
      if (!finished) {
        console.warn("speechSynthesis safety timeout triggered");
        finish();
      }
    }, maxDurationMs);

    window.speechSynthesis.speak(utterance);
  }

  return {
    supported,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    isListening: () => userWantsListening,
    isSpeaking: () => isSpeaking || (Date.now() - lastSpeakEndTime < 800),
  };
}
