/**
 * A source-neutral piece of timed text. Caption Tracks and Transcription
 * produce the same vocabulary so consumers do not need to branch on origin.
 */
export interface TimedTextSegment {
  readonly text: string;
  readonly start: number;
  readonly duration: number;
}
