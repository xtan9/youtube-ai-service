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
// Each value is content-neutral ("the following is a sentence in
// <language>") — long enough to give franc/whisper a strong language
// fingerprint, short enough to stay well under Whisper's 224-token
// prompt cap. Only ISO 639-1 codes that detectLanguage() can return are
// listed; unknown codes get null and the caller falls back to
// language-only flag pinning (the prior behavior).
const LANGUAGE_ANCHOR_PROMPTS: Record<string, string> = {
  en: "The following is a sentence in English.",
  zh: "以下是普通话的句子。",
  fr: "Ce qui suit est une phrase en français.",
  es: "Lo siguiente es una oración en español.",
  ja: "以下は日本語の文です。",
  ko: "다음은 한국어 문장입니다.",
  de: "Das Folgende ist ein Satz auf Deutsch.",
  pt: "A seguir está uma frase em português.",
  ru: "Это предложение на русском языке.",
  it: "La seguente è una frase in italiano.",
  ar: "ما يلي هو جملة باللغة العربية.",
  hi: "यह हिंदी में एक वाक्य है।",
  nl: "Het volgende is een zin in het Nederlands.",
  tr: "Aşağıdaki Türkçe bir cümledir.",
  vi: "Sau đây là một câu tiếng Việt.",
  id: "Berikut adalah kalimat dalam bahasa Indonesia.",
  th: "ต่อไปนี้เป็นประโยคภาษาไทย",
  pl: "Poniżej znajduje się zdanie po polsku.",
  uk: "Це речення українською мовою.",
  sv: "Följande är en mening på svenska.",
  da: "Følgende er en sætning på dansk.",
  no: "Følgende er en setning på norsk.",
  fi: "Seuraava on lause suomeksi.",
  cs: "Následuje věta v češtině.",
  el: "Το ακόλουθο είναι μια πρόταση στα ελληνικά.",
  he: "להלן משפט בעברית.",
  ro: "Următoarea este o propoziție în limba română.",
  hu: "A következő egy mondat magyarul.",
};

/**
 * Look up the language-anchor prompt for a given ISO 639-1 code.
 * Returns null when no anchor is defined for that language so callers
 * can branch on "no anchor available" without conflating it with empty
 * string. Case-insensitive on input.
 *
 * Used by both the Groq transcription path (`prompt` form field) and
 * the local Whisper fallback (`--initial_prompt` flag).
 */
export function getLanguageAnchorPrompt(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const normalized = lang.toLowerCase().trim();
  return LANGUAGE_ANCHOR_PROMPTS[normalized] ?? null;
}
