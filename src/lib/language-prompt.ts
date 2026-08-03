import type { PrimaryLanguageCode } from "./language-tag.js";

// Short native-language sentences passed as Whisper's `initial_prompt` /
// Groq's `prompt`. Anchors the model to the target language even on
// non-speech audio (silence, music, B-roll between speech) so it doesn't
// drift into hallucinated English/French/etc — the bug captured at
// video hrREdNm7vB4 where ~46% of segments came back as nonsense
// English despite `--language zh` being pinned.
//
// Why a prompt and not just `--language`: the `--language` flag tells
// Whisper which language to *transcribe to*, but with the default
// `condition_on_previous_text=True` Whisper still propagates a
// hallucinated English token across subsequent chunks until strong
// native audio resets it. A native-language anchor in the prompt biases
// the model's output distribution every chunk, not just the first.
//
// Each value is a natural conversational opener ("Hello everyone,
// today let's talk about this topic") — content-shaped, not a
// meta-template. The previous "The following is a sentence in <X>"
// form was content-neutral but matched a documented Whisper
// hallucination pattern: training data contains many "the following
// is a sentence in <language>" prompts (TTS / ASR datasets), and
// during long silent stretches Whisper regurgitates that exact
// phrasing. Verified on hrREdNm7vB4: a segment at 194.03s was
// literally "The following is a sentence in English." — the model
// echoed our own English anchor template rather than producing
// native content. A natural-content opener doesn't appear verbatim
// in training prompts the same way and is less prone to
// regurgitation. The opener form also better matches actual YouTube
// content (intros, podcasts) so the language fingerprint is closer
// to the audio's own distribution.
//
// All entries fit comfortably under Whisper's 224-token prompt cap.
// Prompt content owns this set of supported anchors. A valid Primary
// Language Code without an entry gets null and the caller falls back to
// language-only flag pinning (the prior behavior).
//
// Aside: Whisper still occasionally regurgitates initial_prompt during
// silence, but a regurgitated "Hello everyone, today let's talk about
// this topic" reads as plausible video content rather than the
// obvious meta-phrase the previous form produced. The hallucination
// doesn't disappear — its failure mode just becomes less user-visible.
const LANGUAGE_ANCHOR_PROMPTS: Record<string, string> = {
  en: "Hello everyone, today let's talk about this topic.",
  zh: "大家好，今天我们来聊一聊这个话题。",
  fr: "Bonjour à tous, parlons aujourd'hui de ce sujet.",
  es: "Hola a todos, hoy vamos a hablar de este tema.",
  ja: "皆さん、今日はこの話題について話しましょう。",
  ko: "안녕하세요, 오늘은 이 주제에 대해 이야기해 봅시다.",
  de: "Hallo zusammen, heute sprechen wir über dieses Thema.",
  pt: "Olá a todos, hoje vamos falar sobre este assunto.",
  ru: "Всем привет, сегодня поговорим об этой теме.",
  it: "Ciao a tutti, oggi parliamo di questo argomento.",
  ar: "مرحبا بالجميع، اليوم سنتحدث عن هذا الموضوع.",
  hi: "नमस्ते दोस्तों, आज हम इस विषय पर बात करेंगे।",
  nl: "Hallo allemaal, vandaag hebben we het over dit onderwerp.",
  tr: "Herkese merhaba, bugün bu konu hakkında konuşacağız.",
  vi: "Xin chào mọi người, hôm nay chúng ta sẽ nói về chủ đề này.",
  id: "Halo semuanya, hari ini kita akan membahas topik ini.",
  th: "สวัสดีทุกคน วันนี้เรามาคุยเรื่องนี้กัน",
  pl: "Witajcie wszyscy, dziś porozmawiamy na ten temat.",
  uk: "Привіт усім, сьогодні поговоримо на цю тему.",
  sv: "Hej allihopa, idag ska vi prata om detta ämne.",
  da: "Hej alle sammen, i dag taler vi om dette emne.",
  no: "Hei alle sammen, i dag skal vi snakke om dette temaet.",
  fi: "Hei kaikille, tänään puhumme tästä aiheesta.",
  cs: "Ahoj všichni, dnes si povíme o tomto tématu.",
  el: "Γεια σας, σήμερα θα μιλήσουμε για αυτό το θέμα.",
  he: "שלום לכולם, היום נדבר על הנושא הזה.",
  ro: "Salut tuturor, astăzi vom vorbi despre acest subiect.",
  hu: "Sziasztok, ma erről a témáról fogunk beszélni.",
};

/**
 * Look up the language-anchor prompt for a given language code.
 * Returns null when no anchor is defined for that language so callers
 * can branch on "no anchor available" without conflating it with empty
 * string.
 *
 * Accepts only the validated two-letter Primary Language Code produced by
 * the language-tag policy. Returning null for an unavailable anchor keeps
 * language validity independent from prompt-content ownership.
 *
 * Used by both the Groq transcription path (`prompt` form field) and
 * the local Whisper fallback (`--initial_prompt` flag).
 */
export function getLanguageAnchorPrompt(
  lang?: PrimaryLanguageCode | null,
): string | null {
  if (!lang) return null;
  return LANGUAGE_ANCHOR_PROMPTS[lang] ?? null;
}
