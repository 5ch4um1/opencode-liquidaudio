# opencode-liquidaudio

Voice input plugin for [opencode](https://github.com/anomalyco/opencode) - records audio using ffmpeg, sends it to a Liquid AI server for transcription, and inserts the result directly into your prompt.

## Features

- **Two recording modes:**
  - **Transcription mode (`rt`):** Records speech and transcribes it to text
  - **Prompt mode (`rp`):** Records speech and sends it to the AI as a voice message - the AI responds to you conversationally

- Toggle recording on/off with simple commands
- Records from default ALSA audio input (Linux)
- Automatically processes audio and appends to prompt

## Requirements

### 1. Liquid AI Server (Experimental llama.cpp Fork)

This plugin requires the experimental llama.cpp fork with Liquid AI support. You need a server running that supports the OpenAI-compatible chat completions API with audio input.
https://github.com/tdakhran/llama.cpp/tree/tarek/feat/os-lfm2.5-audio-1.5b-upstream


### 2. System Dependencies

- **ffmpeg** - with ALSA support (standard in most distros)

### 3. opencode

Install opencode from [https://opencode.ai](https://opencode.ai)

## Usage

### Start Transcription Mode

```
/tools rt
```

- Starts recording (say what you want to transcribe)


### Start Prompt Mode

```
/tools rp
```

- Starts recording (speak to the AI)

###  Stop Commands

Use these commands to stop the recording and send the audio to the server:

- `/tools rts` - Stop transcription recording
- `/tools rps` - Stop prompt recording

## Configuration

Edit `voice-input.js` to customize:

```javascript
const config = {
  serverUrl: "http://127.0.0.1:8080",  // Your Liquid AI server URL
  sampleRate: 24000,                    // Audio sample rate
  channels: 1,                          // Mono audio
  bitDepth: 16,                         // 16-bit PCM
};
```

## Supported Models

The plugin has been tested with:
- LFM2.5-Audio-1.5B-Q4_0.gguf

It should work with any model that supports audio input in the Liquid AI fork?

## How It Works

1. **Recording:** Uses ffmpeg to capture audio from ALSA (`default` device) in raw PCM format
2. **Processing:** Builds a WAV file with proper headers from the PCM data
3. **Encoding:** Base64-encodes the WAV file
4. **API Call:** Sends to the Liquid AI server using OpenAI-compatible `/v1/chat/completions` with `input_audio`
5. **Response:** Receives streaming transcription/response and appends to prompt

## Troubleshooting

### No audio recorded
- Check that your microphone is set as the default ALSA device
- Verify ffmpeg can record: `ffmpeg -f alsa -i default -t 5 test.wav`

### Server connection errors
- Ensure your Liquid AI server is running: `curl http://127.0.0.1:8080/v1/models`
- Check the server URL in the config matches your setup

### No speech detected
- Check audio levels - the plugin applies 2x gain
- Look at the log file for detailed error messages

## License

MIT
