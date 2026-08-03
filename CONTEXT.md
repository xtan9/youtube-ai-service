# YouTube AI Service

The service acquires YouTube video information and spoken content for downstream AI features while preserving stable, bounded responses.

## Language

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
