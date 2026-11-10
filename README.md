# Quran Glass

A Quran reader for Meta Ray-Ban Display glasses (a Meta web app, 600×600, Neural Band input).

- **Follow the reciter:** a recitation plays and each word turns gold as it is recited, with its meaning
  underneath.
- **Recite myself:** the wearer recites and each word turns gold as it is said, either by a pinch per word or,
  with the Tidal Glass phone app paired on the same glasses, by the phone listening through the glasses'
  microphones (Follow my voice).

When WebMCP is enabled on the glasses, open Quran and say “Hey Meta, open surah 112.”
The command selects the same surah as a pinch and leaves playback off. It works from Home,
the surah list or an idle reader. The tool reports the selected number and a short status to Meta AI. It does not read out your saved position or progress.

Live at https://baklarrrr.github.io/quran-glass/ (install page: `install.html`; privacy and terms:
[`privacy.html`](https://baklarrrr.github.io/quran-glass/privacy.html)). Personal project by Bakar (Bakar Studio);
not affiliated with Meta, Quran Foundation, QuranicAudio or mp3quran.net.

## Credits and sources

If the online service cannot supply an ayah, the reader opens the Arabic text from the
[Tanzil Project](https://tanzil.net/). Pinch or swipe right to mark the next word and swipe left to undo.
The fallback includes all 114 surahs in separate files. An opened chapter can be kept on the glasses for
offline reading. A first visit to a chapter needs a connection to the app's host. Select **Retry audio & meanings** to check for the online text, meanings, timing and recitation again.

The bundled Uthmani text is Tanzil version 1.1. Each ayah and its diacritics are reproduced verbatim.
An opening basmala supplied separately in the source is displayed separately from the numbered ayah.
[Text license](https://tanzil.net/docs/Text_License) · [source checksums](tanzil/source.json).
Every chapter file contains the original copyright notice. The catalog uses
[Tanzil metadata](https://tanzil.net/docs/Quran_Metadata), copyright 2008–2009 Tanzil.info (CC BY).
Reproduce the import with `python3 tools/import_tanzil.py <official-text.xml> <official-metadata.xml>`.
Online Quran Foundation content is fetched while reading. Its chapter list is kept for up to seven days.

- Quran data provided by Quran.Foundation ([Quran.com](https://quran.com)): Quran text (Uthmani script),
  word-by-word English meanings and transliteration, per-word recitation timing and word audio, from the
  Quran Foundation API (`api.quran.com/api/v4`) and `audio.qurancdn.com`.
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
  ([Hugging Face](https://huggingface.co/mrmuminov/quran-fastconformer-ctc-ar), CC BY 4.0), from NVIDIA's
  [stt_ar_fastconformer_hybrid_large_pcd_v1.0](https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0)
  (CC BY 4.0). Credit to NVIDIA and to the model's author.
- The Arabic text is marked `translate="no"`, as Quran Foundation asks, so browsers do not machine-translate it.
- Link library: [mqtt.js](https://github.com/mqttjs/MQTT.js) 5.16.0 (MIT), in `vendor/` with its licence.

Gilding follows the recorded timing, the wearer's own marks or what the phone hears. It does not check
tajwīd. A word the phone heard but could not make out is gilded in a fainter gold.

## Privacy: Follow my voice

While Follow my voice is on, the glasses and the phone exchange short messages through public MQTT
brokers, all three at once: broker.emqx.io, broker.hivemq.com and public.cloud.shiftr.io. The
glasses send where to follow from (again when the wearer moves), a check-in every 20 seconds and a stop;
the phone sends its status, the loudness it hears and the positions of the words it heard. Each message
is sealed with AES-GCM using the pairing key that Tidal Glass stored on these glasses, so the brokers
relay ciphertext. They can still see the topic name and when messages pass. When the browser cannot read
the glasses' battery, the glasses also open the same links for a few seconds at launch and on return, to
fetch the phone's sealed status report, which carries it. This web app records no audio. What the phone
app does with the microphone audio has not been independently verified.
