# Quran Glass

A Quran reader for Meta Ray-Ban Display glasses (a Meta web app, 600×600, Neural Band input).

- **Follow the reciter:** a recitation plays and each word turns gold as it is recited, with its meaning
  underneath.
- **Recite myself:** the wearer recites and each word turns gold as it is said, either by a pinch per word or,
  with the Tidal Glass phone app paired on the same glasses, by the phone listening through the glasses'
  microphones (Follow my voice).

Live at https://baklarrrr.github.io/quran-glass/ (install page: `install.html`). Personal project by Bakar
(Bakar Studio); not affiliated with Meta, Quran.com, QuranicAudio or mp3quran.net.

## Credits and sources

Nothing of the Quran is stored in this repository; it is loaded while the app runs.

- Quran text (Uthmani script), word-by-word English meanings and transliteration, per-word recitation
  timing and word audio: [Quran.com](https://quran.com) public API (`api.quran.com/api/v4`) and
  `audio.qurancdn.com`.
- English translation of the meaning: Saheeh International, via Quran.com (translation 20).
- Recitations: [QuranicAudio](https://quranicaudio.com) (`download.quranicaudio.com`), as linked by Quran.com.
- Reciters marked "aligned": audio from [mp3quran.net](https://mp3quran.net), word timing made by Bakar
  Studio's own alignment ([quran-timings](https://github.com/baklarrrr/quran-timings), list:
  [reciters.json](https://baklarrrr.github.io/quran-timings/reciters.json)). Where the alignment has no
  timing for an ayah, the reader shows it unlit for its stretch of the recording (or passes over it when
  that stretch is empty) and says on its tip line that there is no word timing. A surah without timing yet
  says so when Play is pressed.
- Fonts: Scheherazade New and Noto Naskh Arabic (SIL Open Font License), Amiri Quran (SIL Open Font
  License), loaded from Google Fonts.
- Follow my voice runs on the phone, not here: FastConformer CTC fine-tuned on recitation by mrmuminov
  ([Hugging Face](https://huggingface.co/mrmuminov/quran-fastconformer-ctc-ar), CC-BY-4.0), from NVIDIA's
  `stt_ar_fastconformer_hybrid_large_pcd`.
- Link library: [mqtt.js](https://github.com/mqttjs/MQTT.js) 5.16.0 (MIT), in `vendor/` with its licence.

Gilding follows the recorded timing, the wearer's own marks or what the phone hears. It does not check
tajwīd. A word the phone heard but could not make out is gilded in a fainter gold.

## Privacy: Follow my voice

While Follow my voice is on, the glasses and the phone exchange short messages through public MQTT
brokers: broker.emqx.io, broker.hivemq.com and, if neither can be reached, public.cloud.shiftr.io. The
glasses send where to follow from (again when the wearer moves), a check-in every 20 seconds and a stop;
the phone sends its status, the loudness it hears and the positions of the words it heard. Each message
is sealed with AES-GCM using the pairing key that Tidal Glass stored on these glasses, so the brokers
relay ciphertext. They can still see the topic name and when messages pass. When the browser cannot read
the glasses' battery, the glasses also open the same links for a few seconds at launch and on return, to
fetch the phone's sealed status report, which carries it. This web app records no audio. What the phone
app does with the microphone audio has not been independently verified.
