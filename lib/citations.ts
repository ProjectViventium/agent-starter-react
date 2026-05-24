// === VIVENTIUM START ===
// Feature: agent-starter-react citation stripping for LibreChat-style markers.
// Reason: Modern playground does not render LibreChat citations, so raw markers leak.
// Details: Keep regex patterns aligned with agents-playground utils.
const COMPOSITE_REGEX = /(?:\\ue200|ue200|\uE200).*?(?:\\ue201|ue201|\uE201)/gi;
const STANDALONE_REGEX = /(?:\\ue202|ue202|\uE202)turn\d+[A-Za-z]+\d+/gi;
const BARE_TURN_ID_REGEX =
  /(?<![A-Za-z])(?:\u3010\s*)?turn\d+[A-Za-z]+\d+(?:\s*\u2020[^\u3011\s]*)?(?:\s*\u3011)?/gi;
const ORPHAN_CITATION_TAIL_REGEX = /(?<!\S)\u2020[^\u3011\s]{0,80}\u3011(?=\s|$)/g;
const ORPHAN_CITATION_BRACKET_REGEX = /(?<!\S)[\u3010\u3011](?!\S)/g;
const CLEANUP_REGEX = /\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\uE200-\uE206]/gi;
const BRACKET_REGEX = /\[(\d{1,3})\](?=\s|[.,;:!?)]|$)/g;
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
  cleaned = cleaned.replace(BARE_TURN_ID_REGEX, ' ');
  cleaned = cleaned.replace(ORPHAN_CITATION_TAIL_REGEX, ' ');
  cleaned = cleaned.replace(ORPHAN_CITATION_BRACKET_REGEX, ' ');
  cleaned = cleaned.replace(CLEANUP_REGEX, ' ');
  cleaned = cleaned.replace(BRACKET_REGEX, ' ');
  cleaned = cleaned.replace(/\s+([.,!?;:])/g, '$1');
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
// Updated: 2026-04-28 - bracket stripping is structural, not a hardcoded token list.
const SPEAK_TAG_REGEX = /<\/?speak[^>]*>/gi;
const EMOTION_SELF_CLOSING_REGEX = /<emotion\s+value=["']?[^"'>]+["']?\s*\/>/gi;
// Note: Use [\s\S]*? instead of .*? with /s flag — tsconfig targets ES2017 (no dotAll).
const EMOTION_WRAPPER_REGEX = /<emotion\s+value=["']?[^"'>]+["']?\s*>([\s\S]*?)<\/emotion>/gi;
const BREAK_TAG_REGEX = /<break\s+time=["']?[^"'>]+["']?\s*\/>/gi;
const SPEED_TAG_REGEX = /<speed\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const VOLUME_TAG_REGEX = /<volume\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const SPELL_TAG_REGEX = /<spell>([\s\S]*?)<\/spell>/gi;
const XAI_WRAPPING_TAG_NAMES = [
  'soft',
  'whisper',
  'loud',
  'build-intensity',
  'decrease-intensity',
  'higher-pitch',
  'lower-pitch',
  'slow',
  'fast',
  'sing-song',
  'singing',
  'laugh-speak',
  'emphasis',
];
const XAI_WRAPPER_REGEX = new RegExp(
  `<(${XAI_WRAPPING_TAG_NAMES.join('|')})>([\\s\\S]*?)</\\1>`,
  'gi'
);
const STAGE_DIRECTION_MIN_ALPHA = 3;
const STAGE_DIRECTION_MAX_ALPHA = 24;
const STAGE_DIRECTION_MAX_WORDS = 3;

const isStageDirectionBoundary = (ch?: string): boolean =>
  !ch || /\s/.test(ch) || '.,!?;:(){}<>"\''.includes(ch);

const isBracketStageDirection = (content: string): boolean => {
  const candidate = content.trim();
  if (!candidate || candidate !== candidate.toLowerCase()) {
    return false;
  }
  if (/\d/.test(candidate)) {
    return false;
  }
  if (!/^[a-z' -]+$/.test(candidate)) {
    return false;
  }

  const alphaCount = (candidate.match(/[a-z]/g) || []).length;
  if (alphaCount < STAGE_DIRECTION_MIN_ALPHA || alphaCount > STAGE_DIRECTION_MAX_ALPHA) {
    return false;
  }

  const words = candidate.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > STAGE_DIRECTION_MAX_WORDS) {
    return false;
  }
  return words.every((word) => /^[a-z']+$/.test(word));
};

const stripBracketStageDirections = (text: string): string => {
  if (!text) {
    return '';
  }

  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '[') {
      out += text[index];
      index += 1;
      continue;
    }

    const closing = text.indexOf(']', index + 1);
    if (closing < 0) {
      out += text[index];
      index += 1;
      continue;
    }

    const content = text.slice(index + 1, closing);
    const left = index > 0 ? text[index - 1] : '';
    const right = closing + 1 < text.length ? text[closing + 1] : '';
    if (
      isBracketStageDirection(content) &&
      isStageDirectionBoundary(left) &&
      isStageDirectionBoundary(right)
    ) {
      index = closing + 1;
      continue;
    }

    out += text.slice(index, closing + 1);
    index = closing + 1;
  }

  return out;
};

const stripXaiWrappingTags = (text: string): string => {
  let cleaned = text || '';
  let previous: string;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(XAI_WRAPPER_REGEX, '$2');
  } while (cleaned !== previous);
  return cleaned;
};

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
  cleaned = stripXaiWrappingTags(cleaned);
  cleaned = stripBracketStageDirections(cleaned);
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  // Preserve chunk-boundary whitespace for streamed assistant text. Trimming here
  // causes later chunks like " world" to become "world", which re-concatenates
  // transcript words in the modern playground.
  return cleaned;
};
// === VIVENTIUM END ===
