# YouTube AI Service

The service acquires YouTube video information and spoken content for downstream AI features while preserving stable, bounded responses.

## Language

**Language Tag**:
The canonical full language identity accepted by the service. It may retain
script, region, or registered-variant detail when that detail is meaningful to
the caller or provider.
_Avoid_: Locale, language code

**Primary Language Code**:
The lowercase two-letter primary identity derived from a Language Tag. It is
the representation used by metadata responses and Transcription providers.
_Avoid_: Language Tag, Prompt Locale

**Prompt Locale**:
The existing binary `en`/`zh` Caption Track response value used for prompt
routing. It describes prompt selection, not the full Language Tag returned by
the provider.
_Avoid_: Language Tag, Primary Language Code

**Caption Track**:
Timestamped text published with a YouTube video and retrievable without interpreting its audio.
_Avoid_: Transcript, transcription

**Transcription**:
The conversion of a YouTube video's spoken audio into timestamped text when a suitable caption track is unavailable.
_Avoid_: Captions, caption extraction

**Transcript Segment**:
A bounded piece of transcribed text paired with its start time and duration.
_Avoid_: Caption, paragraph

**Local Transcription Fallback**:
A bounded local second attempt after an eligible primary Transcription failure.
_Avoid_: Caption Track fallback, language fallback
