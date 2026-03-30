import { tool } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";

const logDir = path.join(process.env.HOME || "/home/$USER", ".config", "opencode", "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, "voice-input.log");

function log(level, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(logFile, logMessage);
}

// ---------- WAV header builder ----------
function buildWavHeader({ sampleRate = 16000, channels = 1, bitDepth = 16, dataSize }) {
  const byteRate = (sampleRate * bitDepth * channels) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const chunkSize = 36 + dataSize;

  const buffer = Buffer.alloc(44);
  // RIFF
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(chunkSize, 4);
  buffer.write("WAVE", 8);
  // fmt
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20);  // AudioFormat = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  // data
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// ---------- Main plugin ----------
export const VoiceInputPlugin = async ({ project, client, $, directory, worktree }) => {
  log("info", "Voice Input Plugin loaded");

  // ----- Configuration (normally from opencode.json) -----
  const config = {
    serverUrl: "http://127.0.0.1:8080",
    sampleRate: 24000,
    channels: 1,
    bitDepth: 16,
  };
  log("info", "Voice Input Plugin config:", config);

  // ----- State -----
  let isRecording = false;
  let isPromptMode = false;
  let recorder = null;
  let audioChunks = [];

  // Note: Global hotkey (uiohook-napi) doesn't work with Bun due to
  // libuv limitations. Use /tools rt or /tools rp instead.

  // ----- Start recording -----
  const startRecording = async (promptMode = false) => {
    if (recorder) {
      log("warn", "startRecording called but recorder exists, cleaning up first");
      try { recorder.kill ? recorder.kill("SIGTERM") : recorder.stop(); } catch (_) {}
      recorder = null;
    }
    if (isRecording) {
      log("warn", "startRecording called but already recording, ignoring");
      return;
    }

    isPromptMode = promptMode;
    log("info", `Voice Input Plugin: Starting audio recording (mode: ${promptMode ? 'prompt' : 'transcription'})`);

    try {
      const { spawn } = await import("child_process");

      audioChunks = [];

      recorder = spawn("ffmpeg", [
        "-f", "alsa",
        "-i", "default",
        "-ar", String(config.sampleRate),
        "-ac", String(config.channels),
        "-acodec", "pcm_s16le",
        "-filter:a", "volume=2.0",
        "-f", "s16le",
        "-"
      ]);

      recorder.stdout.on("data", (chunk) => {
        audioChunks.push(chunk);
      });

      recorder.stderr.on("data", (data) => {
        // ffmpeg outputs to stderr
      });

      recorder.on("close", (code) => {
        log("info", `Voice Input Plugin: ffmpeg closed with code ${code}`);
        if (isRecording) {
          isRecording = false;
        }
      });

      recorder.on("error", (err) => {
        log("error", `Voice Input Plugin: ffmpeg error: ${err}`);
        client.tui.showToast({
          body: { message: `Recorder error: ${err.message}`, variant: "error" },
        });
        stopRecording();
      });

      isRecording = true;
      log("info", "Voice Input Plugin: ffmpeg recording started");

      const modeLabel = promptMode ? "🎙️ Recording prompt..." : "🎙️ Recording transcription...";
      await client.tui.showToast({
        body: { message: modeLabel, variant: "info", duration: 0 },
      });
      log("info", `Voice Input Plugin: Recording started (${promptMode ? 'prompt' : 'transcription'} mode)`);
    } catch (err) {
      log("error", `Failed to start recorder: ${err.message}\n${err.stack}`);
      await client.tui.showToast({
        body: { message: `Could not start recording: ${err.message}`, variant: "error" },
      });
    }
  };

  // ----- Stop recording and process -----
  const stopRecording = async () => {
    const currentMode = isPromptMode;
    log("info", "Voice Input Plugin: stopRecording called", { isRecording: !!isRecording, hasRecorder: !!recorder, mode: currentMode ? 'prompt' : 'transcription' });
    if (!recorder) {
      log("warn", "Voice Input Plugin: stopRecording ignored – no recorder");
      isRecording = false;
      isPromptMode = false;
      return false;
    }

    try {
      log("info", "Voice Input Plugin: Stopping recorder");
      if (recorder.kill) {
        recorder.kill("SIGTERM");
      } else {
        recorder.stop();
      }
      recorder = null;
      isRecording = false;

      await client.tui.showToast({
        body: { message: "Processing audio...", variant: "info" },
      });

      await processRecording(currentMode);
      isPromptMode = false;
      return true;
    } catch (err) {
      log("error", "Error stopping recorder:", err);
      await client.tui.showToast({
        body: { message: `Error stopping recording: ${err.message}`, variant: "error" },
      });
      isPromptMode = false;
      return false;
    }
  };

  // ----- Convert PCM chunks to WAV + base64 and send to server -----
  async function processRecording(promptMode = false) {
    log("info", `Voice Input Plugin: Processing recorded audio (mode: ${promptMode ? 'prompt' : 'transcription'})`);
    if (audioChunks.length === 0) {
      log("warn", "Voice Input Plugin: No audio data recorded");
      await client.tui.showToast({
        body: { message: "No audio recorded", variant: "warning" },
      });
      return;
    }

    try {
      log("info", "Voice Input Plugin: Concatenating PCM chunks");
      const pcmBuffer = Buffer.concat(audioChunks);
      log("info", `Voice Input Plugin: Total PCM size: ${pcmBuffer.length} bytes (ffmpeg already applied 2x gain)`);

      // Build WAV header
      const wavHeader = buildWavHeader({
        sampleRate: config.sampleRate,
        channels: config.channels,
        bitDepth: config.bitDepth,
        dataSize: pcmBuffer.length,
      });
      const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
      log("info", `Voice Input Plugin: WAV size (with header): ${wavBuffer.length} bytes`);

      // Base64 encode
      const base64Wav = wavBuffer.toString("base64");
      log("info", `Voice Input Plugin: Base64 WAV length: ${base64Wav.length}`);

      // System prompt differs based on mode
      const systemPrompt = promptMode
        ? "You are a helpful AI assistant. The user has recorded a voice message for you. Listen to their audio and respond appropriately to their request. Be concise and direct in your response."
        : "Perform ASR.";

      const requestBody = {
        model: "llama4-scout",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: base64Wav, format: "wav" },
              },
            ],
          },
        ],
        modalities: ["text"],
        max_tokens: promptMode ? 2000 : 500,
        stream: true,
      };
      const requestJson = JSON.stringify(requestBody);
      log("info", `Voice Input Plugin: Request - mode: ${promptMode ? 'prompt' : 'transcription'}, system prompt: "${systemPrompt.substring(0, 50)}..."`);
      log("info", `Voice Input Plugin: Sending to server...`);
      const response = await fetch(`${config.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let resultText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter(line => line.trim() !== "");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) resultText += content;
            } catch (_) {}
          }
        }
      }
      log("info", `Voice Input Plugin: Streaming result complete: "${resultText}"`);

      if (resultText.trim()) {
        log("info", "Voice Input Plugin: Appending result to prompt");
        await client.tui.appendPrompt({
          body: { text: resultText.trim() },
        });
        await client.tui.showToast({
          body: { message: promptMode ? "Response ready" : "Transcription complete", variant: "success" },
        });
      } else {
        log("warn", "Voice Input Plugin: No speech detected");
        await client.tui.showToast({
          body: { message: "No speech detected", variant: "warning" },
        });
      }
    } catch (err) {
      log("error", `Voice Input Plugin: Processing error: ${err.message}\n${err.stack}`);
      await client.tui.showToast({
        body: { message: `Processing failed: ${err.message}`, variant: "error" },
      });
    } finally {
      // Clean up for next utterance
      audioChunks = [];
      recorder = null;
      isRecording = false;
      isPromptMode = false;
    }
  };

  // ----- Public tool interface -----
  // Tool names: rt = record transcription, rp = record prompt
  return {
    tool: {
      // rt - Record Transcription: Toggle voice input to transcribe speech to text
      // Usage: /tools rt (toggle on/off)
      rt: tool({
        description: "Toggle voice transcription mode - speaks and it gets transcribed to text",
        args: {},
        async execute(args, { project, client, $, directory, worktree }) {
          log("info", "rt (record transcription) tool called", { isRecording });
          if (isRecording) {
            log("info", "Stopping voice recording (transcription mode)");
            const ok = await stopRecording();
            return ok
              ? "Voice transcription stopped and processed."
              : "Voice transcription stopped but there was an error.";
          } else {
            log("info", "Starting voice recording (transcription mode)");
            await startRecording(false);
            return "Recording transcription... Speak now!";
          }
        }
      }),

      // rp - Record Prompt: Toggle voice input for AI conversation
      // Usage: /tools rp (toggle on/off) - speak to the AI directly
      rp: tool({
        description: "Toggle voice prompt mode - speak to the AI and it responds to you",
        args: {},
        async execute(args, { project, client, $, directory, worktree }) {
          log("info", "rp (record prompt) tool called", { isRecording });
          if (isRecording) {
            log("info", "Stopping voice recording (prompt mode)");
            const ok = await stopRecording();
            return ok
              ? "Voice prompt stopped and processed."
              : "Voice prompt stopped but there was an error.";
          } else {
            log("info", "Starting voice recording (prompt mode)");
            await startRecording(true);
            return "Recording prompt... Tell me what you need!";
          }
        }
      }),

      // rts - Stop Record Transcription: Stop the current recording
      rts: tool({
        description: "Stop voice transcription recording (only works if currently recording)",
        args: {},
        async execute(args, { project, client, $, directory, worktree }) {
          log("info", "rts (stop transcription) tool called", { isRecording });
          if (!isRecording) {
            return "Not currently recording in transcription mode.";
          }
          log("info", "Stopping voice recording (transcription mode)");
          const ok = await stopRecording();
          return ok
            ? "Voice transcription stopped and processed."
            : "Voice transcription stopped but there was an error.";
        }
      }),

      // rps - Stop Record Prompt: Stop the current recording
      rps: tool({
        description: "Stop voice prompt recording (only works if currently recording)",
        args: {},
        async execute(args, { project, client, $, directory, worktree }) {
          log("info", "rps (stop prompt) tool called", { isRecording });
          if (!isRecording) {
            return "Not currently recording in prompt mode.";
          }
          log("info", "Stopping voice recording (prompt mode)");
          const ok = await stopRecording();
          return ok
            ? "Voice prompt stopped and processed."
            : "Voice prompt stopped but there was an error.";
        }
      }),
    },

    // ----- Cleanup on plugin unload -----
    "__experimental_destroy": () => {
      if (isRecording && recorder) {
        log("info", "Voice Input Plugin: Cleaning up recorder on destroy");
        try {
          recorder.kill ? recorder.kill("SIGTERM") : recorder.stop();
        } catch (_) {}
        isRecording = false;
        isPromptMode = false;
        recorder = null;
        audioChunks = [];
      }
      log("info", "Voice Input Plugin destroyed");
    }
  };
};
