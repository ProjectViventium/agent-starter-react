// === VIVENTIUM START ===
// Feature: agent-starter-react citation stripping for LibreChat-style markers.
// Reason: Modern playground does not render LibreChat citations, so raw markers leak.
// Details: Keep regex patterns aligned with agents-playground utils.
const COMPOSITE_REGEX = /(?:\\ue200|ue200|\uE200).*?(?:\\ue201|ue201|\uE201)/gi;
const STANDALONE_REGEX = /(?:\\ue202|ue202|\uE202)turn\d+[A-Za-z]+\d+/gi;
const CLEANUP_REGEX = /\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\uE200-\uE206]/gi;
const BRACKET_REGEX = /\[(\d{1,3})\](?=\s|$)/g;
const TURN_BLOCK_REGEX = /<turn\b([^>]*)>([\s\S]*?)<\/turn>/gi;
const TURN_ROLE_REGEX = /\brole\s*=\s*(?:"|')?([a-zA-Z_]+)(?:"|')?/i;
const TURN_TAG_REGEX = /<\/?turn\b[^>]*>/gi;
const RECALL_DUMP_BLOCK_REGEX =
  /(?:^|\n)(?:[ \t]*[─—-]{5,}[ \t]*\n)?(?:[ \t]*Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]+\n|(?:[ \t]*Tool:[ \t]*[^\n]*\n)?[ \t]*File:[ \t]*[^\n]+\n)[ \t]*Anchor:[ \t]*[^\n]+\n[ \t]*Relevance:[ \t]*[^\n]+\n[ \t]*Content:[ \t]*[\s\S]*?(?=(?:\n[ \t]*[─—-]{5,}[ \t]*(?:\n|$))|(?:\n[ \t]*(?:Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]+|(?:Tool:[ \t]*[^\n]*\n)?[ \t]*File:[ \t]*[^\n]+)\n[ \t]*Anchor:)|$)/gi;
const RECALL_META_LINE_REGEX =
  /^[ \t]*(?:Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]*|Anchor:[ \t]*[^\n]*|Relevance:[ \t]*[-+]?\d*\.?\d+|Content:[ \t]*(?:<turn\b[^\n]*|$))[ \t]*$/gim;

export const stripCitations = (text: string): string => {
  if (!text) {
    return '';
  }
  let cleaned = text.replace(COMPOSITE_REGEX, ' ');
  cleaned = cleaned.replace(STANDALONE_REGEX, ' ');
  cleaned = cleaned.replace(CLEANUP_REGEX, ' ');
  cleaned = cleaned.replace(BRACKET_REGEX, ' ');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  return cleaned;
};
// === VIVENTIUM END ===

// === VIVENTIUM START ===
// Feature: Strip leaked recall/tool artifacts from non-LibreChat-rendered chat output.
export const stripInternalArtifactsForDisplay = (text: string): string => {
  if (!text) {
    return '';
  }

  let cleaned = text.replace(TURN_BLOCK_REGEX, (_match, attrs: string, body: string) => {
    const roleMatch = attrs.match(TURN_ROLE_REGEX);
    const role = (roleMatch?.[1] || '').toLowerCase();
    if (role === 'ai' || role === 'assistant' || role === 'model') {
      const trimmed = (body || '').trim();
      return trimmed ? `\n${trimmed}\n` : '\n';
    }
    return '\n';
  });

  cleaned = cleaned.replace(TURN_TAG_REGEX, ' ');
  cleaned = cleaned.replace(RECALL_DUMP_BLOCK_REGEX, '\n');
  cleaned = cleaned.replace(RECALL_META_LINE_REGEX, ' ');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
};
// === VIVENTIUM END ===

// === VIVENTIUM START ===
// Feature: Strip Cartesia SSML and bracket nonverbal markers for voice transcript display.
// Purpose: During voice calls, the LLM emits TTS-specific markup (<emotion/>, <break/>,
// <speed/>, <volume/>, <spell>, [laughter], [sigh], etc.) that should be spoken but never
// displayed as raw text in the chat transcript.
// Keep regex patterns aligned with surfacePrompts.js stripVoiceControlTagsForDisplay()
// and agents-playground/src/utils/citations.ts.
// Updated: 2026-02-22 — added bracket nonverbals, break/speed/volume/spell stripping.
const SPEAK_TAG_REGEX = /<\/?speak[^>]*>/gi;
const EMOTION_SELF_CLOSING_REGEX = /<emotion\s+value=["']?[^"'>]+["']?\s*\/>/gi;
// Note: Use [\s\S]*? instead of .*? with /s flag — tsconfig targets ES2017 (no dotAll).
const EMOTION_WRAPPER_REGEX = /<emotion\s+value=["']?[^"'>]+["']?\s*>([\s\S]*?)<\/emotion>/gi;
const BREAK_TAG_REGEX = /<break\s+time=["']?[^"'>]+["']?\s*\/>/gi;
const SPEED_TAG_REGEX = /<speed\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const VOLUME_TAG_REGEX = /<volume\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const SPELL_TAG_REGEX = /<spell>([\s\S]*?)<\/spell>/gi;
const BRACKET_NONVERBAL_REGEX =
  /\[(?:laugh(?:ter)?|giggle|chuckle|soft laugh|gentle laugh|quiet laugh|nervous laugh|awkward laugh|light laugh|sigh|gentle sigh|soft sigh|breath|breath in|breath out|inhale|exhale|gasp|whisper|hmm|hm)\]/gi;

export const stripVoiceControlTagsForDisplay = (text: string): string => {
  if (!text) {
    return '';
  }
  let cleaned = text.replace(SPEAK_TAG_REGEX, '');
  cleaned = cleaned.replace(EMOTION_SELF_CLOSING_REGEX, '');
  cleaned = cleaned.replace(EMOTION_WRAPPER_REGEX, '$1');
  cleaned = cleaned.replace(BREAK_TAG_REGEX, '');
  cleaned = cleaned.replace(SPEED_TAG_REGEX, '');
  cleaned = cleaned.replace(VOLUME_TAG_REGEX, '');
  cleaned = cleaned.replace(SPELL_TAG_REGEX, '$1');
  cleaned = cleaned.replace(BRACKET_NONVERBAL_REGEX, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  // Preserve chunk-boundary whitespace for streamed assistant text. Trimming here
  // causes later chunks like " world" to become "world", which re-concatenates
  // transcript words in the modern playground.
  return cleaned;
};
// === VIVENTIUM END ===
